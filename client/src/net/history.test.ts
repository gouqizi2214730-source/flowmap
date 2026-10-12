import { describe, expect, it } from 'vitest';

import { HistoryLoader, pageColsForRows, HISTORY_PAGE_COLS, type HistoryLoaderDeps } from './history';
import { Residency, type ResidentRange } from '../gl/tileRing';
import { MODE_L2, MsgType, type DepthColumn, type HistoryResponse, type Marker } from '../proto/types';

/**
 * The T8 backfill range-computation + debounce logic is pure — driven here by a
 * fake `requestHistory` and a mutable resident window. No GL, no transport.
 */

const ROWS = 4;
const DT = 1000; // ns per column in the fake

function makeCol(colSeq: number, t0: bigint): DepthColumn {
  return {
    type: MsgType.DEPTH_COL,
    epoch: 0,
    col_seq: colSeq,
    t0_ns: t0,
    mode: MODE_L2,
    final: true,
    bid: new Float32Array(ROWS),
    ask: new Float32Array(ROWS),
  };
}

interface Harness {
  loader: HistoryLoader;
  win: { oldest: number; newest: number };
  spliced: number[];
  requests: { before_t: bigint; n: number }[];
}

/**
 * @param oldestAvailable server's oldest retained t0 (columns below it 404).
 * @param serverFloorSeq   lowest col_seq the fake server still has.
 */
function harness(
  oldestAvailable: bigint,
  serverFloorSeq = 0,
  budget = 256,
): Harness {
  const win = { oldest: 100, newest: 199 };
  const spliced: number[] = [];
  const requests: { before_t: bigint; n: number }[] = [];

  const deps: HistoryLoaderDeps = {
    requestHistory: (before_t, n): Promise<HistoryResponse> => {
      requests.push({ before_t, n });
      // Return up to n columns with t0 < before_t, down to the server floor.
      const cols: DepthColumn[] = [];
      for (let s = win.oldest - n; s < win.oldest; s++) {
        if (s < serverFloorSeq) continue;
        const t0 = BigInt(s * DT);
        if (t0 < before_t) cols.push(makeCol(s, t0));
      }
      return Promise.resolve({
        type: MsgType.HISTORY_RESP,
        req_id: 1,
        epoch: 0,
        oldest_available_t_ns: oldestAvailable,
        depth_cols: cols,
        bar_cols: [],
        markers: [],
        big_trades: [],
      });
    },
    spliceColumn: (col) => {
      spliced.push(col.col_seq);
      if (col.col_seq < win.oldest) win.oldest = col.col_seq;
    },
    residentRange: (): ResidentRange | null => ({
      oldest: win.oldest,
      newest: win.newest,
      count: win.newest - win.oldest + 1,
    }),
    budgetCols: () => budget,
    dtNs: () => DT,
  };

  return { loader: new HistoryLoader(deps), win, spliced, requests };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The actual bounded modulo window, with slot identities checked like texels. */
function residentHarness(start = 1000, budget = 256, pageCols = 64) {
  const residency = new Residency(budget, budget, 1);
  const slots = new Map<number, number>();
  const requests: { before_t: bigint; n: number }[] = [];
  const spliced: number[] = [];
  const latest = { colSeq: start + budget - 1, t0Ns: BigInt((start + budget - 1) * DT) };
  let completed = 0;
  const write = (colSeq: number) => {
    slots.set(colSeq % budget, colSeq);
    residency.note(colSeq);
  };
  for (let s = start; s <= latest.colSeq; s++) write(s);
  const loader = new HistoryLoader({
    residentRange: () => residency.range(),
    validFromSeq: () => residency.validFromSeq(),
    latestColumn: () => latest,
    budgetCols: () => budget,
    maxPageCols: () => pageCols,
    dtNs: () => DT,
    requestHistory: async (before_t, n) => {
      requests.push({ before_t, n });
      const last = Math.floor(Number(before_t) / DT) - 1;
      const depth_cols = Array.from({ length: n }, (_, i) => last - n + 1 + i)
        .filter(s => s >= 0 && s <= latest.colSeq)
        .map(s => makeCol(s, BigInt(s * DT)));
      return { type: MsgType.HISTORY_RESP, req_id: requests.length, epoch: 0,
        oldest_available_t_ns: 0n, depth_cols, bar_cols: [], markers: [], big_trades: [] };
    },
    spliceColumn: col => { spliced.push(col.col_seq); write(col.col_seq); },
    onSpliced: () => { completed++; },
  });
  loader.noteColumn(start, BigInt(start * DT));
  loader.noteColumn(latest.colSeq, latest.t0Ns);
  return {
    loader, residency, requests, spliced, latest,
    completed: () => completed,
    advance: (seq: number) => {
      latest.colSeq = seq;
      latest.t0Ns = BigInt(seq * DT);
      write(seq);
      loader.noteColumn(seq, latest.t0Ns);
    },
    assertValid: () => {
      const range = residency.range()!;
      expect(range.count).toBeLessThanOrEqual(budget);
      for (let s = residency.validFromSeq(); s <= range.newest; s++) {
        expect(slots.get(s % budget), `slot for valid column ${s}`).toBe(s);
      }
    },
  };
}

async function fillVisible(
  h: ReturnType<typeof residentHarness>, view: { leftCol: number; span: number; level: number },
) {
  for (let page = 0; page < 32; page++) {
    const before = h.loader.requestCount;
    h.loader.ensureVisible(view);
    await flush();
    h.assertValid();
    if (h.loader.requestCount === before) return;
  }
  throw new Error('visible history did not settle within its bounded pages');
}

describe('history upload frame budget', () => {
  function scheduledPage() {
    const spliced: number[] = [];
    const pending: Array<() => void> = [];
    let completed = 0;
    const loader = new HistoryLoader({
      residentRange: () => ({ oldest: 100, newest: 199, count: 100 }),
      budgetCols: () => 512, dtNs: () => DT,
      requestHistory: async () => ({ type: MsgType.HISTORY_RESP, req_id: 1,
        epoch: 0, oldest_available_t_ns: 0n,
        depth_cols: Array.from({length:24}, (_,i) => makeCol(76+i, BigInt((76+i)*DT))),
        bar_cols: [], markers: [], big_trades: [] }),
      spliceColumn: c => { spliced.push(c.col_seq); },
      yieldToFrame: () => new Promise<void>(resolve => { pending.push(resolve); }),
      onSpliced: () => { completed++; },
    });
    loader.noteColumn(100, BigInt(100*DT));
    loader.ensureVisible({leftCol:0, span:80, level:0});
    return {loader, spliced, pending, completed: () => completed};
  }

  it('lets display/live work run between small ordered upload chunks', async () => {
    const h = scheduledPage();
    await flush();
    expect(h.spliced).toEqual(Array.from({length:8}, (_,i) => 99-i));
    expect(h.loader.inFlight).toBe(true);
    expect(h.completed()).toBe(0);
    h.pending.shift()!(); await flush();
    expect(h.spliced).toHaveLength(16);
    h.pending.shift()!(); await flush();
    expect(h.spliced).toEqual(Array.from({length:24}, (_,i) => 99-i));
    expect(h.completed()).toBe(1);
    expect(h.loader.inFlight).toBe(false);
  });

  it('cancels a yielded old-session page before it can write the next chunk', async () => {
    const h = scheduledPage();
    await flush();
    h.loader.reset();
    h.pending.shift()!(); await flush();
    expect(h.spliced).toHaveLength(8);
    expect(h.completed()).toBe(0);
    expect(h.loader.inFlight).toBe(false);
    expect(h.loader.error).toBeNull();
  });
});

describe('HistoryLoader (T8 backfill)', () => {
  it('fires a HistoryRequest when the view pans left past the resident window', async () => {
    const h = harness(/* oldestAvailable */ -1_000_000n); // server has lots older
    h.loader.noteColumn(100, BigInt(100 * DT)); // seed exact t0 of oldest resident

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    expect(h.loader.inFlight).toBe(true);
    expect(h.loader.requestCount).toBe(1);
    // before_t is the tracked t0 of the oldest resident column (exclusive).
    expect(h.requests[0].before_t).toBe(BigInt(100 * DT));

    await flush();
    expect(h.spliced.length).toBeGreaterThan(0);
    // Splices land at their true absolute col_seq, ending just below oldest(100).
    expect(Math.max(...h.spliced)).toBe(99);
    expect(h.win.oldest).toBeLessThan(100);
    expect(h.loader.inFlight).toBe(false);
  });

  it('coalesces overlapping requests (only one in flight)', async () => {
    const h = harness(-1_000_000n);
    h.loader.noteColumn(100, BigInt(100 * DT));

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 }); // same frame-ish
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    expect(h.loader.requestCount).toBe(1);
    await flush();
    expect(h.loader.requestCount).toBe(1);
  });

  it('backfills a fitting viewport at mip level 2', async () => {
    const h = harness(-1_000_000n);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 2 });
    expect(h.loader.requestCount).toBe(1);
    await flush();
    expect(h.spliced).toContain(0);
    expect(h.loader.inFlight).toBe(false);
  });

  it('does NOT backfill when the time span exceeds the full-res budget', () => {
    const h = harness(-1_000_000n, 0, /* budget */ 256);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 500, level: 0 }); // span > budget
    expect(h.loader.requestCount).toBe(0);
  });

  it('does NOT fire while the visible left edge is already resident', () => {
    const h = harness(-1_000_000n);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 110, span: 40, level: 0 });
    expect(h.loader.requestCount).toBe(0);
  });

  it('does not fight live eviction when a full ring glides just behind its edge', () => {
    const h = harness(-1_000_000n, 0, 100);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 99, span: 100, level: 2, following: true });
    expect(h.loader.requestCount).toBe(0);
    // Manual history still requests that exact same missing column.
    h.loader.ensureVisible({ leftCol: 99, span: 100, level: 2, following: false });
    expect(h.loader.requestCount).toBe(1);
  });

  it('latches start-of-history when the server has nothing older', async () => {
    // Server floor at col 0, oldest_available = t0 of col 0.
    const h = harness(/* oldestAvailable */ 0n, /* serverFloorSeq */ 0);
    h.loader.noteColumn(100, BigInt(100 * DT));

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    // Reached col 0 (t0 0 ≤ oldest_available 0) → exhausted, no more spinning.
    expect(h.loader.startOfHistory).toBe(true);

    const before = h.loader.requestCount;
    h.loader.ensureVisible({ leftCol: -50, span: 80, level: 0 });
    expect(h.loader.requestCount).toBe(before); // latched: does not re-request
  });

  it('latches start-of-history when a response comes back empty', async () => {
    // Server floor ABOVE the requested range → empty depth_cols.
    const h = harness(5_000_000n, /* serverFloorSeq */ 100);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(h.spliced.length).toBe(0);
    expect(h.loader.startOfHistory).toBe(true);
  });

  it('latches at absolute col_seq 0 when panned past the start of the stream', () => {
    const h = harness(-1_000_000n);
    h.win.oldest = 0; // resident window already reaches the first column
    // Pan the left edge clearly past col 0 (beyond the prefetch margin).
    h.loader.ensureVisible({ leftCol: -100, span: 40, level: 0 });
    expect(h.loader.requestCount).toBe(0);
    expect(h.loader.startOfHistory).toBe(true);
  });

  it('does NOT latch start-of-history during normal live follow (oldest 0)', () => {
    const h = harness(-1_000_000n);
    h.win.oldest = 0;
    h.win.newest = 40;
    // Following the live edge: the left edge is near the newest, not the oldest.
    h.loader.ensureVisible({ leftCol: 5, span: 30, level: 0 });
    expect(h.loader.startOfHistory).toBe(false);
    expect(h.loader.requestCount).toBe(0);
  });

  it('prefetch loads history toward the target but stops short of the ring budget', async () => {
    // Server has effectively unlimited older data; ask for far more than the ring.
    const h = harness(/* oldestAvailable */ -1_000_000_000n, /* serverFloorSeq */ -1_000_000, /* budget */ 256);
    h.loader.noteColumn(100, BigInt(100 * DT));

    await h.loader.prefetch(1_000_000); // absurd target → must clamp to budget − headroom

    const count = h.win.newest - h.win.oldest + 1;
    // Never fills past the ring budget (the live-edge-eviction guard)…
    expect(count).toBeLessThanOrEqual(256);
    // …and it DID load a meaningful chunk (near budget − RESIDENT_HEADROOM_COLS=32).
    expect(count).toBeGreaterThanOrEqual(200);
    // Stopped in a couple of pages, not the 64-page runaway cap.
    expect(h.loader.requestCount).toBeLessThan(4);
  });

  it('prefetch is a no-op for a non-positive target', async () => {
    const h = harness(-1_000_000n);
    await h.loader.prefetch(0);
    expect(h.loader.requestCount).toBe(0);
  });

  it('derives before_t from oldest-known t0 minus k·dt when the exact t0 is absent', async () => {
    const h = harness(-1_000_000n);
    // Only a NEWER column's t0 is known; oldest resident (100) has no cached t0.
    h.loader.noteColumn(120, BigInt(120 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    // before_t = t0(120) − (120−100)·dt = 100·dt.
    expect(h.requests[0].before_t).toBe(BigInt(100 * DT));
    await flush();
  });
});

describe('HistoryLoader — bounded history navigation', () => {
  it('uses the same missing-column request at every mip level without a timer gate', async () => {
    const requests = [];
    for (const level of [0, 1, 2]) {
      const h = residentHarness();
      h.loader.ensureVisible({ leftCol: 900, span: 80, level });
      expect(h.loader.inFlight).toBe(true);
      await flush();
      requests.push(h.requests);
    }
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toEqual(requests[0]);
    expect(requests[0]).toEqual([{ before_t: BigInt(1000 * DT), n: 64 }]);
  });

  it('loads a full-budget viewport in bounded pages and stops exactly at its left edge', async () => {
    const h = residentHarness();
    const view = { leftCol: 500, span: 256, level: 2 };
    await fillVisible(h, view);
    expect(h.residency.range()).toEqual({ oldest: 500, newest: 755, count: 256 });
    expect(h.residency.validFromSeq()).toBe(500);
    expect(h.requests.map(r => r.n)).toEqual([64, 64, 64, 64, 64, 64, 64, 52]);
    expect(h.completed()).toBe(8);
    h.loader.ensureVisible(view);
    expect(h.loader.requestCount).toBe(8);
  });

  it('clips a page so the requested right edge cannot be overwritten', async () => {
    const h = residentHarness(1000, 256, 256);
    await fillVisible(h, { leftCol: 900, span: 240, level: 2 });
    expect(h.requests).toEqual([{ before_t: BigInt(1000 * DT), n: 116 }]);
    expect(h.residency.range()).toEqual({ oldest: 884, newest: 1139, count: 256 });
    expect(h.residency.isResident(1139)).toBe(true);
  });

  it('repairs a one-column pan of a full-budget view without leaving a gap or looping', async () => {
    const h = residentHarness();
    await fillVisible(h, { leftCol: 999, span: 256, level: 2 });
    expect(h.requests).toEqual([{ before_t: BigInt(1000 * DT), n: 1 }]);
    expect(h.residency.range()).toEqual({ oldest: 999, newest: 1254, count: 256 });
  });

  it('refills invalid slots inside a claimed window after a large live jump', async () => {
    const h = residentHarness();
    h.advance(2000);
    expect(h.residency.range()!.oldest).toBe(1745);
    expect(h.residency.validFromSeq()).toBe(2000);
    await fillVisible(h, { leftCol: 1900, span: 80, level: 2 });
    expect(h.requests[0].before_t).toBe(BigInt(2000 * DT));
    expect(h.requests).toHaveLength(2);
    expect(h.residency.validFromSeq()).toBe(1872);
    expect(h.residency.range()!.newest).toBe(2000);
  });

  it('can pan right after exhausting older history, then reload the missing left part', async () => {
    const h = residentHarness();
    await fillVisible(h, { leftCol: 0, span: 256, level: 2 });
    expect(h.loader.startOfHistory).toBe(true);
    expect(h.residency.range()).toEqual({ oldest: 0, newest: 255, count: 256 });
    const oldRequests = h.requests.length;
    await fillVisible(h, { leftCol: 800, span: 256, level: 2 });
    expect(h.requests[oldRequests]).toEqual({ before_t: BigInt(1056 * DT), n: 64 });
    expect(h.requests.length - oldRequests).toBe(4);
    expect(h.residency.range()).toEqual({ oldest: 800, newest: 1055, count: 256 });
    expect(h.residency.validFromSeq()).toBe(800);
    expect(h.loader.startOfHistory).toBe(false);
  });

  it('clips right-side history requests to the latest actual source column', async () => {
    const h = residentHarness();
    await fillVisible(h, { leftCol: 0, span: 256, level: 0 });
    const oldRequests = h.requests.length;
    await fillVisible(h, { leftCol: 1200, span: 256, level: 2 });
    expect(h.requests.slice(oldRequests)).toEqual([{ before_t: BigInt(1256 * DT), n: 56 }]);
    expect(h.residency.range()!.newest).toBe(h.latest.colSeq);
    expect(h.residency.validFromSeq()).toBe(1200);
    expect(Math.max(...h.spliced)).toBe(1255);
  });

  it('eager backfill counts only valid columns after a live jump', async () => {
    const h = residentHarness();
    h.advance(2000);
    await h.loader.prefetch(100);
    h.assertValid();
    expect(h.requests.map(r => r.n)).toEqual([64, 35]);
    expect(h.residency.validFromSeq()).toBe(1901);
    expect(h.residency.range()!.newest).toBe(2000);
  });
});

describe('HistoryLoader — exact sequence navigation across restart clocks', () => {
  const interval = 250_000_000n;
  const restartDelay = 1_800_000_000_000n;
  const clock = (seq: number) => 1_000_000_000_000n + BigInt(seq) * interval +
    (seq >= 40_000 ? restartDelay : 0n);

  function exactHarness(pageCols = 256) {
    const budget = 256;
    const residency = new Residency(budget, budget, 1);
    const slots = new Map<number, number>();
    const requests: { start: number; end: number; n: number }[] = [];
    const spliced: number[] = [];
    const latest = { colSeq: 60_255, t0Ns: clock(60_255) };
    let active = true;
    let held: (() => void) | null = null;
    let holdNext = false;
    let emptyNext = false;
    const write = (seq: number) => {
      slots.set(seq % budget, seq);
      residency.note(seq);
    };
    for (let seq = 60_000; seq <= latest.colSeq; seq++) write(seq);
    const loader = new HistoryLoader({
      residentRange: () => residency.range(),
      validFromSeq: () => residency.validFromSeq(),
      latestColumn: () => latest,
      budgetCols: () => budget,
      dtNs: () => Number(interval),
      maxPageCols: () => pageCols,
      isActive: () => active,
      requestHistory: async () => { throw new Error('an affine timestamp cannot locate this page'); },
      requestSequence: async (start, end, n) => {
        requests.push({ start, end, n });
        if (holdNext) {
          holdNext = false;
          await new Promise<void>(resolve => { held = resolve; });
        }
        const depth_cols = emptyNext ? [] : Array.from({ length: end - start + 1 }, (_, i) =>
          makeCol(start + i, clock(start + i)));
        emptyNext = false;
        return { type: MsgType.HISTORY_RESP, req_id: requests.length, epoch: 0,
          oldest_available_t_ns: 0n, depth_cols, bar_cols: [], markers: [], big_trades: [] };
      },
      spliceColumn: col => { spliced.push(col.col_seq); write(col.col_seq); },
    });
    loader.noteColumn(60_000, clock(60_000));
    loader.noteColumn(latest.colSeq, latest.t0Ns);
    const assertValid = () => {
      const range = residency.range()!;
      expect(range.count).toBeLessThanOrEqual(budget);
      for (let seq = residency.validFromSeq(); seq <= range.newest; seq++) {
        expect(slots.get(seq % budget), `slot for ${seq}`).toBe(seq);
      }
    };
    return { loader, residency, requests, spliced, latest, assertValid,
      deactivate: () => { active = false; },
      hold: () => { holdNext = true; },
      release: () => { held?.(); },
      empty: () => { emptyNext = true; },
      advance: (seq: number) => {
        latest.colSeq = seq; latest.t0Ns = clock(seq); write(seq); loader.noteColumn(seq, latest.t0Ns);
      },
    };
  }

  async function settle(h: ReturnType<typeof exactHarness>, leftCol: number, span = 256) {
    for (let page = 0; page < 12; page++) {
      const previous = h.requests.length;
      h.loader.ensureVisible({ leftCol, span, level: 0 });
      await flush();
      h.assertValid();
      if (h.requests.length === previous) return;
    }
    throw new Error('exact history walked beyond the requested viewport');
  }

  it('jumps directly from the live ring to raw columns 64..319 using one bounded page', async () => {
    const h = exactHarness();
    const guessedOldClock = h.latest.t0Ns + BigInt(319 - h.latest.colSeq) * interval;
    expect(guessedOldClock - clock(319)).toBe(restartDelay);
    await settle(h, 64);
    expect(h.requests).toEqual([{ start: 64, end: 319, n: 256 }]);
    expect(h.spliced).toEqual(Array.from({ length: 256 }, (_, i) => 319 - i));
    expect(h.residency.range()).toEqual({ oldest: 64, newest: 319, count: 256 });
    expect(h.loader.error).toBeNull();
  });

  it('uses only the four requested pages when transport budgets limit uploads to 64 columns', async () => {
    const h = exactHarness(64);
    await settle(h, 64);
    expect(h.requests).toEqual([
      { start: 256, end: 319, n: 64 }, { start: 192, end: 255, n: 64 },
      { start: 128, end: 191, n: 64 }, { start: 64, end: 127, n: 64 },
    ]);
    expect(h.spliced).toHaveLength(256);
    expect(h.residency.validFromSeq()).toBe(64);
  });

  it('returns to a distant newer region in ascending order and clips at the true source edge', async () => {
    const h = exactHarness();
    await settle(h, 64);
    const oldCount = h.spliced.length;
    await settle(h, 20_000);
    expect(h.requests[1]).toEqual({ start: 20_000, end: 20_255, n: 256 });
    expect(h.spliced.slice(oldCount)).toEqual(Array.from({ length: 256 }, (_, i) => 20_000 + i));
    await settle(h, h.latest.colSeq - 20);
    expect(h.requests[2]).toEqual({ start: h.latest.colSeq - 20, end: h.latest.colSeq, n: 21 });
    expect(h.residency.range()!.newest).toBe(h.latest.colSeq);
  });

  it('repairs overlapping pans without evicting the requested right edge', async () => {
    const h = exactHarness();
    await settle(h, 59_900, 240);
    expect(h.requests).toEqual([{ start: 59_884, end: 59_999, n: 116 }]);
    expect(h.residency.range()).toEqual({ oldest: 59_884, newest: 60_139, count: 256 });
    expect(h.residency.validFromSeq()).toBe(59_884);
  });

  it('keeps empty pages local and suppresses repeated reads without disabling other history', async () => {
    const h = exactHarness();
    h.empty();
    await settle(h, 200);
    expect(h.requests).toHaveLength(1);
    expect(h.loader.startOfHistory).toBe(false);
    await settle(h, 1000);
    expect(h.requests[1]).toEqual({ start: 1000, end: 1255, n: 256 });
    expect(h.residency.validFromSeq()).toBe(1000);
  });

  it('drops a delayed exact page after the renderer detaches or the loader resets', async () => {
    for (const reset of [false, true]) {
      const h = exactHarness();
      h.hold();
      h.loader.ensureVisible({ leftCol: 64, span: 256, level: 0 });
      h.loader.ensureVisible({ leftCol: 64, span: 256, level: 0 });
      expect(h.requests).toHaveLength(1);
      if (reset) h.loader.reset(); else h.deactivate();
      h.release(); await flush();
      expect(h.spliced).toEqual([]);
      expect(h.loader.inFlight).toBe(false);
    }
  });

  it('discards a delayed far-pan page and immediately serves the latest view instead', async () => {
    const h = exactHarness();
    h.hold();
    h.loader.ensureVisible({ leftCol: 64, span: 256, level: 0 });
    h.loader.ensureVisible({ leftCol: 20_000, span: 256, level: 0 });
    expect(h.requests).toEqual([{ start: 64, end: 319, n: 256 }]);
    h.release(); await flush();
    expect(h.requests).toEqual([
      { start: 64, end: 319, n: 256 }, { start: 20_000, end: 20_255, n: 256 },
    ]);
    expect(h.spliced).toEqual(Array.from({ length: 256 }, (_, i) => 20_255 - i));
    expect(h.residency.validFromSeq()).toBe(20_000);
    h.assertValid();
  });

  it('uses exact sequence pages for eager repair and dropped bands after a clock seam', async () => {
    const h = exactHarness(64);
    h.advance(61_000);
    await h.loader.prefetch(100);
    expect(h.requests).toEqual([
      { start: 60_936, end: 60_999, n: 64 }, { start: 60_901, end: 60_935, n: 35 },
    ]);
    h.loader.refetchBand(60_997, 60_999, 0n); // no trustworthy time anchor needed
    await flush();
    expect(h.requests[2]).toEqual({ start: 60_997, end: 60_999, n: 3 });
    h.assertValid();
  });
});

describe('HistoryLoader — session reset + page hygiene', () => {
  it('reset() drops the SESSION-scoped state: a stale oldest-available bound must not kill the new session’s scroll-back', async () => {
    // Old session: the server floor IS the resident oldest → empty page →
    // start-of-history latched AND oldest_available = t0(100).
    const h = harness(BigInt(100 * DT), /* serverFloorSeq */ 100);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(h.loader.startOfHistory).toBe(true);
    expect(h.loader.requestCount).toBe(1);

    // A session switch hands the SAME loader a NEW session whose grid restarts
    // at col_seq 0 with its own server bound. reset() must clear the latch AND
    // the old session's oldest_available: without that, before_t (= t0(100))
    // ≤ the stale bound latches exhaustion and the new session never probes.
    h.loader.reset();
    expect(h.loader.startOfHistory).toBe(false);
    h.loader.noteColumn(100, BigInt(100 * DT)); // re-seeded by the next live write
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    expect(h.loader.requestCount).toBe(2);
    expect(h.loader.inFlight).toBe(true);
    await flush();
  });

  it('splices an out-of-order older page descending from the resident anchor', async () => {
    const spliced: number[] = [];
    const loader = new HistoryLoader({
      requestHistory: (): Promise<HistoryResponse> =>
        Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 1,
          epoch: 0,
          oldest_available_t_ns: -1_000_000n,
          // A deviant server: the page arrives shuffled.
          depth_cols: [
            makeCol(98, BigInt(98 * DT)),
            makeCol(96, BigInt(96 * DT)),
            makeCol(99, BigInt(99 * DT)),
            makeCol(97, BigInt(97 * DT)),
          ],
          bar_cols: [],
          markers: [],
          big_trades: [],
        }),
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 100, newest: 199, count: 100 }),
      budgetCols: () => 256,
      dtNs: () => DT,
    });
    loader.noteColumn(100, BigInt(100 * DT));

    loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(spliced).toEqual([99, 98, 97, 96]);
    expect(loader.startOfHistory).toBe(false); // floor far below — not exhausted
  });

  it('a transient failure does NOT latch exhaustion — the next pan retries and success clears the error', async () => {
    let fail = true;
    const spliced: number[] = [];
    const loader = new HistoryLoader({
      requestHistory: (before_t): Promise<HistoryResponse> => {
        if (fail) return Promise.reject(new Error('history request 7 timed out'));
        return Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 7,
          epoch: 0,
          oldest_available_t_ns: -1_000_000n,
          depth_cols: [makeCol(Number(before_t) / DT - 1, before_t - BigInt(DT))],
          bar_cols: [],
          markers: [],
          big_trades: [],
        });
      },
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 100, newest: 199, count: 100 }),
      budgetCols: () => 256,
      dtNs: () => DT,
    });
    loader.noteColumn(100, BigInt(100 * DT));

    loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(loader.error).toMatch(/timed out/);
    expect(loader.startOfHistory).toBe(false); // NOT latched on a transient error
    expect(loader.inFlight).toBe(false); // channel freed for a retry

    fail = false;
    loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(loader.requestCount).toBe(2);
    expect(spliced).toEqual([99]);
    expect(loader.error).toBeNull(); // success clears the stale error
  });
});

// --- repaired-skip band refetch (F24) ------------------------------------------
// A server tx_lag drop evicts only THIS client's queue; the columns stay in the
// session grid ring and `history(before_t)` still serves them. The renderer's
// repair zeroes the skipped band; this refetch replaces the zeroes with the
// real columns when the server still holds them (bounded, single-flight, and a
// no-op fallback — the zeroes stay — on failure or an empty page).

describe('HistoryLoader — repaired-skip band refetch (F24)', () => {
  interface BandHarness {
    loader: HistoryLoader;
    spliced: number[];
    requests: { before_t: bigint; n: number }[];
    flushCount: () => number;
    release: () => void;
  }

  /** Fake server: a dense store of columns at t0 = seq·DT down to `floor`. */
  function bandHarness(floor: number, hold = false): BandHarness {
    let releaseFn: (() => void) | null = null;
    const gate = hold ? new Promise<void>((res) => { releaseFn = res; }) : null;
    const spliced: number[] = [];
    const requests: { before_t: bigint; n: number }[] = [];
    let flushes = 0;
    const loader = new HistoryLoader({
      requestHistory: (before_t, n): Promise<HistoryResponse> => {
        requests.push({ before_t, n });
        // The server's exclusive page: the n newest columns with t0 < before_t,
        // ascending (like the real grid ring).
        const cols: DepthColumn[] = [];
        for (let s = Number(before_t / BigInt(DT)) - 1; s >= floor && cols.length < n; s--) {
          cols.push(makeCol(s, BigInt(s * DT)));
        }
        cols.reverse();
        const resp: HistoryResponse = {
          type: MsgType.HISTORY_RESP,
          req_id: 1,
          epoch: 0,
          oldest_available_t_ns: BigInt(floor * DT),
          depth_cols: cols,
          bar_cols: [],
          markers: [],
          big_trades: [],
        };
        return gate ? gate.then(() => resp) : Promise.resolve(resp);
      },
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 200, newest: 299, count: 100 }),
      budgetCols: () => 512,
      dtNs: () => DT,
      onSpliced: () => {
        flushes++;
      },
    });
    return { loader, spliced, requests, flushCount: () => flushes, release: () => releaseFn?.() };
  }

  it('splices ONLY the missing band, descending, anchored at the post-band column', async () => {
    const h = bandHarness(0);
    // Band 50..53 was dropped; col 54 arrived live with t0 = 54·DT.
    h.loader.refetchBand(50, 53, BigInt(54 * DT));
    await flush();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].before_t).toBe(BigInt(54 * DT));
    // Older page members (below 50) are NOT re-spliced here, and the order is
    // descending (each lands adjacent to the valid suffix).
    expect(h.spliced).toEqual([53, 52, 51, 50]);
  });

  it('is single-flight and processes a band arriving mid-refetch (one pending slot)', async () => {
    const h = bandHarness(0, true);
    h.loader.refetchBand(50, 53, BigInt(54 * DT)); // holds on the gate
    h.loader.refetchBand(55, 57, BigInt(58 * DT)); // arrives while in flight → pending
    expect(h.requests).toHaveLength(1);

    h.release();
    await flush();
    await flush();
    expect(h.requests).toHaveLength(2); // the pending band ran right after
    // Each band was covered exactly (they are disjoint here: col 54 is the
    // anchor of the first band, already resident — never part of any drop).
    expect(new Set(h.spliced)).toEqual(new Set([50, 51, 52, 53, 55, 56, 57]));
    expect(h.flushCount()).toBe(2); // one mip flush per completed page walk
  });

  it('walks multiple pages for a band wider than one page (≤3 pages)', async () => {
    const h = bandHarness(0);
    // A 300-column band (1..300): page 1 returns 256 cols (45..300), page 2 the
    // rest (1..44).
    h.loader.refetchBand(1, 300, BigInt(301 * DT));
    await flush();
    await flush();
    await flush();
    expect(h.requests.length).toBeLessThanOrEqual(3);
    expect(h.spliced.length).toBe(300);
    expect([...h.spliced].sort((a, b) => a - b)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it('an empty page (server no longer holds the band) keeps the zeroes and stops', async () => {
    const h = bandHarness(100); // server floor ABOVE the band
    h.loader.refetchBand(50, 53, BigInt(54 * DT));
    await flush();
    expect(h.spliced).toEqual([]);
  });

  it('a transient failure leaves the zeroes, never throws, and a later band still refetches', async () => {
    let fail = true;
    const spliced: number[] = [];
    const loader = new HistoryLoader({
      requestHistory: (before_t): Promise<HistoryResponse> => {
        if (fail) return Promise.reject(new Error('history request timed out'));
        const cols: DepthColumn[] = [];
        for (let s = Number(before_t / BigInt(DT)) - 1; s >= 0 && cols.length < 8; s--) cols.push(makeCol(s, BigInt(s * DT)));
        cols.reverse();
        return Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 2,
          epoch: 0,
          oldest_available_t_ns: 0n,
          depth_cols: cols,
          bar_cols: [],
          markers: [],
          big_trades: [],
        });
      },
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 200, newest: 299, count: 100 }),
      budgetCols: () => 512,
      dtNs: () => DT,
    });

    loader.refetchBand(50, 53, BigInt(54 * DT));
    await flush();
    expect(spliced).toEqual([]);
    expect(loader.error).toMatch(/timed out/);

    fail = false;
    loader.refetchBand(60, 62, BigInt(63 * DT));
    await flush();
    expect(spliced).toEqual([62, 61, 60]);
  });
});

// --- page seam honesty + stale anchor prune (QA3 C-1) -------------------------
// A history page can belong to a DIFFERENT grid than the resident window (a
// reconstructed page, a session replacement under the same subscription). The
// loader must (a) surface the seq→time break as a gap Marker on the response
// the renderer forwards, and (b) re-seed its (col_seq→t0) anchors when the map
// is re-anchored, so the OLD grid's exhaustion latch can't kill scroll-back.

describe('HistoryLoader — page seam honesty (QA3 C-1)', () => {
  const ANCHOR = 1000;

  interface PageHarness {
    loader: HistoryLoader;
    win: { oldest: number; newest: number };
    spliced: number[];
    requests: { before_t: bigint; n: number }[];
    resp: () => HistoryResponse | null;
  }

  function pageHarness(opts: {
    cols: () => DepthColumn[];
    markers?: HistoryResponse['markers'];
    oldest?: number;
    dt?: number;
  }): PageHarness {
    const win = { oldest: opts.oldest ?? ANCHOR, newest: (opts.oldest ?? ANCHOR) + 99 };
    const spliced: number[] = [];
    const requests: { before_t: bigint; n: number }[] = [];
    let lastResp: HistoryResponse | null = null;
    const loader = new HistoryLoader({
      requestHistory: (before_t, n): Promise<HistoryResponse> => {
        requests.push({ before_t, n });
        return Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 1,
          epoch: 0,
          oldest_available_t_ns: -1_000_000n,
          depth_cols: opts.cols(),
          bar_cols: [],
          markers: opts.markers ? [...opts.markers] : [],
          big_trades: [],
        });
      },
      spliceColumn: (col) => {
        spliced.push(col.col_seq);
        if (col.col_seq < win.oldest) win.oldest = col.col_seq;
      },
      residentRange: () => ({ oldest: win.oldest, newest: win.newest, count: win.newest - win.oldest + 1 }),
      budgetCols: () => 256,
      dtNs: () => opts.dt ?? DT,
      onSpliced: (resp) => {
        lastResp = resp;
      },
    });
    loader.noteColumn(win.oldest, BigInt(win.oldest * DT));
    return { loader, win, spliced, requests, resp: () => lastResp };
  }

  it('adds ONE gap Marker when a page runs time BACKWARD, and still splices', async () => {
    const seamTs = BigInt(996 * DT) - 2_000_000_000n; // 2 s backward at col 996
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) {
        out.push(makeCol(s, s === 996 ? seamTs : BigInt(s * DT)));
      }
      return out;
    };
    const h = pageHarness({ cols });

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();

    expect(h.spliced).toEqual([999, 998, 997, 996, 995, 994, 993, 992, 991, 990]);
    const resp = h.resp();
    expect(resp).not.toBeNull();
    const synthetic = resp!.markers.filter((m) => m.text.startsWith('history page seam'));
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ type: MsgType.MARKER, kind: 'gap', ts_ns: seamTs });
  });

  it('a clean page (anchor-consistent cadence) gets NO synthetic marker', async () => {
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) out.push(makeCol(s, BigInt(s * DT)));
      return out;
    };
    const h = pageHarness({ cols });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(h.resp()!.markers).toHaveLength(0);
  });

  it('does not duplicate a server gap marker that already sits on the seam', async () => {
    const seamTs = BigInt(996 * DT) - 2_000_000_000n;
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) {
        out.push(makeCol(s, s === 996 ? seamTs : BigInt(s * DT)));
      }
      return out;
    };
    const serverMarker: Marker = {
      type: MsgType.MARKER,
      ts_ns: seamTs + 500n,
      kind: 'gap',
      text: 'backfill: reconstructed history ends, live resumes',
      price: null,
      size: null,
    };
    const h = pageHarness({ cols, markers: [serverMarker] });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    const resp = h.resp()!;
    expect(resp.markers).toHaveLength(1); // the server's own marker only
    expect(resp.markers[0].text).toContain('backfill');
  });

  it('marks a page↔anchor grid mismatch at the resumption side', async () => {
    // The page is internally clean but its t0s are on the OLD grid's scale:
    // 999 columns × DT above where the resident window's t0 base sits.
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) out.push(makeCol(s, BigInt(s * DT) + 3_600_000_000_000n));
      return out;
    };
    const h = pageHarness({ cols });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    const resp = h.resp()!;
    const synthetic = resp.markers.filter((m) => m.text.includes('page grid mismatch'));
    expect(synthetic).toHaveLength(1);
    // Resumption side = the resident anchor's t0.
    expect(synthetic[0].ts_ns).toBe(BigInt(ANCHOR * DT));
  });

  it('prunes a stale exhaustion latch when the seq→time map is re-anchored', async () => {
    // Empty page → start-of-history latched on the OLD grid.
    const h = pageHarness({ cols: () => [], oldest: 260 });
    h.loader.ensureVisible({ leftCol: 0, span: 50, level: 0 });
    await flush();
    expect(h.loader.startOfHistory).toBe(true);
    expect(h.loader.requestCount).toBe(1);

    // Same-subscription session replacement: col_seq 260 now carries a NEW t0.
    h.loader.noteColumn(260, 26_000_000_000n);
    expect(h.loader.startOfHistory).toBe(false); // stale latch pruned

    h.loader.ensureVisible({ leftCol: 0, span: 50, level: 0 });
    await flush();
    expect(h.loader.requestCount).toBe(2); // scroll-back works on the new grid
    expect(h.requests[1].before_t).toBe(26_000_000_000n); // new anchor, not the old
  });
});

describe('pageColsForRows — per-request frame budget (vite proxy WS ceilings)', () => {
  it('sizes the page so one response frame stays under the byte budget', () => {
    // A column is rows × 2 channels × 4 bytes on the wire.
    // 2 MB budget / (4096 × 8 B) = 64 columns.
    expect(pageColsForRows(4096)).toBe(64);
    // 2 MB / (2048 × 8 B) = 128 columns.
    expect(pageColsForRows(2048)).toBe(128);
  });

  it('clamps to the wire page ceiling and a progress floor', () => {
    // Tiny grid: the budget would allow more than the wire ceiling.
    expect(pageColsForRows(64)).toBe(HISTORY_PAGE_COLS);
    // Poisoned row counts still make progress (16 columns) instead of hanging.
    expect(pageColsForRows(0)).toBe(HISTORY_PAGE_COLS);
    expect(pageColsForRows(Number.NaN)).toBe(HISTORY_PAGE_COLS);
    expect(pageColsForRows(1_000_000)).toBe(16);
  });

  it('honours a custom budget', () => {
    expect(pageColsForRows(2048, 1 * 1024 * 1024)).toBe(64);
  });
});
