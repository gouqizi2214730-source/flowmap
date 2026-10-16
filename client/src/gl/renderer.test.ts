import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Renderer } from './renderer';
import { makeFake2D, makeFakeGL, type FakeGL } from './mockGL';
import { clearColorForRamp } from './lut';
import { MsgType, MODE_L2, type DepthColumn, type HistoryOverviewRequest } from '../proto/types';
import type { StreamMsg } from '../net/connection';
import { makeHybrid, priceToRow, rowToPrice, type PriceScale } from './priceScale';
import { accumulateProfile } from './overlays/profile';
import { THEMES, THEME_IDS } from '../theme';

/**
 * Renderer unit tests over a RECORDING fake GL (see mockGL.ts). Pixels are the
 * browser e2e's job (testHook.ts); these pin the CPU behavior around the GL
 * calls: which columns fold into the normalizer, whether one GL error kills the
 * rAF loop, what the clear color is, and the snapshot() contract.
 */

const ROWS = 8;
const DT_NS = 25_000_000;

function makeCol(seq: number, final: boolean, rows = ROWS): DepthColumn {
  const bid = new Float32Array(rows);
  bid[3] = 5;
  const ask = new Float32Array(rows);
  ask[4] = 7;
  return {
    type: MsgType.DEPTH_COL,
    epoch: 0,
    col_seq: seq,
    t0_ns: BigInt(seq) * BigInt(DT_NS),
    mode: MODE_L2,
    final,
    bid,
    ask,
  };
}

interface FakeStore {
  state: Record<string, unknown> & {
    onStream: (cb: (m: StreamMsg) => void) => () => void;
  };
  emit: (m: StreamMsg) => void;
  getState: () => unknown;
}

function makeStore(): FakeStore {
  const listeners: Array<(m: StreamMsg) => void> = [];
  const state = {
    sessionId: 'sess-1',
    gridEpoch: 0,
    normSeed: 0,
    capability: { depth: 'L2' },
    epochs: new Map([
      [0, { epoch: 0, tick: 0.5, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: ROWS }],
    ]),
    onStream: (cb: (m: StreamMsg) => void): (() => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    requestHistory: () => new Promise(() => undefined), // never resolves; not used here
  };
  return {
    state,
    emit: (m) => {
      for (const l of [...listeners]) l(m);
    },
    getState: () => state,
  };
}

describe('Renderer (fake GL harness)', () => {
  let gl: FakeGL;
  let rafQueue: Array<(ts: number) => void>;
  let asyncThrows: Array<() => void>;
  let restoreGetContext: () => void;

  function makeRenderer(capacityColsTarget = 512, benchmark = false): { r: Renderer; canvas: HTMLCanvasElement; store: FakeStore } {
    const store = makeStore();
    const canvas = document.createElement('canvas');
    const r = new Renderer(canvas, {
      getState: () => store.state as never,
    }, { capacityColsTarget, benchmark });
    return { r, canvas, store };
  }

  /** Run one rAF tick (the finally in frame() re-queues the next callback). */
  function pump(ts: number): void {
    const cb = rafQueue.shift();
    expect(cb, 'render loop scheduled a callback').toBeDefined();
    cb!(ts);
  }

  it('classifies history geometry loss separately from stale session omissions', () => {
    const { r, store } = makeRenderer(512, true);
    store.emit(makeCol(1, true));
    const sink = r as unknown as { spliceColumn(column: DepthColumn): void };
    sink.spliceColumn(makeCol(0, true, ROWS + 1));
    sink.spliceColumn(makeCol(0, true));
    r.resetForSession();
    sink.spliceColumn(makeCol(0, true));
    const s = r.benchmarkDrain()!;
    expect(s.counters.historyReceived).toBe(3);
    expect(s.counters.historyApplied).toBe(1);
    expect(s.counters['historyDiscarded:rowMismatch']).toBe(1);
    expect(s.counters['historyOmitted:staleSession']).toBe(1);
    r.dispose();
  });

  beforeEach(() => {
    gl = makeFakeGL();
    const fake2d = makeFake2D();
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function mockGetContext(this: HTMLCanvasElement, kind: string) {
        if (kind === '2d') return fake2d;
        if (kind === 'webgl2') return gl;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    restoreGetContext = () => spy.mockRestore();
    rafQueue = [];
    asyncThrows = [];
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: (ts: number) => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'setTimeout',
      vi.fn((cb: () => void) => {
        asyncThrows.push(cb);
        return 0;
      }),
    );
  });

  afterEach(() => {
    restoreGetContext();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])('removes chart BBO when recorded playback or a paused snapshot has no current quote (quoteFirst=%s)', quoteFirst => {
    const { r, store } = makeRenderer();
    store.state.capability = { depth: 'L2', depth_provenance: 'recorded-density' };
    const column = (seq: number, crossed: boolean): void => {
      const depth = makeCol(seq, true);
      if (crossed) { depth.ask!.fill(0); depth.ask![2] = 7; }
      store.emit(depth);
      store.emit({ ...depth, type: MsgType.BOOK_UPDATE, final: false });
    };
    const quote = (seq: number): void => store.emit({ type: MsgType.BBO, ts_ns: BigInt(seq) * BigInt(DT_NS),
      bid_px: 101.5, bid_sz: 5, ask_px: 102, ask_sz: 7 });
    column(0, true);
    expect(r.overlayEffectiveBboForTest()).toBeNull();
    if (quoteFirst) quote(1);
    column(1, false);
    if (!quoteFirst) quote(1);
    expect(r.overlayEffectiveBboForTest()?.bidPx).toBe(101.5);
    column(2, true);
    expect(r.overlayEffectiveBboForTest()).toBeNull();
    quote(1); // a delayed quote for the previous column cannot bring it back
    expect(r.overlayEffectiveBboForTest()).toBeNull();
    if (quoteFirst) quote(3);
    column(3, false);
    if (!quoteFirst) quote(3);
    expect(r.overlayEffectiveBboForTest()?.askPx).toBe(102);
    r.resetForSession(); column(0, true);
    expect(r.overlayEffectiveBboForTest()).toBeNull();
    r.dispose();
  });

  // --- B-1: the normalizer folds FINAL columns exactly once --------------------

  it('releases startup presentation only after a real draw of the current session', () => {
    const { r, store } = makeRenderer();
    expect(r.marketFrameReady).toBe(false);
    store.emit(makeCol(0, true));
    expect(r.marketFrameReady).toBe(false);
    pump(16);
    expect(r.marketFrameReady).toBe(true);

    // A new Hello must not release its screen using the previous session's draw.
    store.state.sessionId = 'sess-2';
    expect(r.marketFrameReady).toBe(false);
    store.emit(makeCol(0, true));
    expect(r.marketFrameReady).toBe(false);
    pump(32);
    expect(r.marketFrameReady).toBe(true);
    r.resetForSession();
    expect(r.marketFrameReady).toBe(false);
    r.dispose();
  });

  it('a lost GL context cannot advertise a ready market frame', () => {
    const { r, store, canvas } = makeRenderer();
    store.emit(makeCol(0, true));
    pump(16);
    expect(r.marketFrameReady).toBe(true);
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(r.marketFrameReady).toBe(false);
    r.dispose();
  });

  it('stages depth during compilation, ingests bounded batches, and reuses the shader on symbol changes', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const completion = 0x91b1;
    let ready = false;
    const extension = gl.getExtension.bind(gl);
    vi.spyOn(gl, 'getExtension').mockImplementation(name => name === 'KHR_parallel_shader_compile'
      ? { COMPLETION_STATUS_KHR: completion } : extension(name));
    vi.spyOn(gl, 'getProgramParameter').mockImplementation((_program, key) => {
      if (key === completion) return ready;
      return true; // overlay programs still initialize synchronously
    });
    const { r, store } = makeRenderer();
    for (let seq = 0; seq < 12; seq++) store.emit(makeCol(seq, true));
    expect(r.newestColSeq).toBe(-1);
    expect(gl.callsOf('texSubImage3D')).toHaveLength(0);
    pump(16);
    expect(r.newestColSeq).toBe(-1);
    ready = true;
    pump(32);
    expect(r.newestColSeq).toBe(7);
    pump(48);
    expect(r.newestColSeq).toBe(11);
    const links = gl.callsOf('linkProgram').length;
    r.resetForSession();
    store.state.sessionId = 'sess-2';
    store.emit(makeCol(0, true));
    expect(r.newestColSeq).toBe(0);
    expect(gl.callsOf('linkProgram')).toHaveLength(links);
    r.dispose();
  });

  it('discards staged columns from the previous instrument while compilation is pending', () => {
    const completion = 0x91b1;
    let ready = false;
    const extension = gl.getExtension.bind(gl);
    vi.spyOn(gl, 'getExtension').mockImplementation(name => name === 'KHR_parallel_shader_compile'
      ? { COMPLETION_STATUS_KHR: completion } : extension(name));
    vi.spyOn(gl, 'getProgramParameter').mockImplementation((_program, key) => key === completion ? ready : true);
    const { r, store } = makeRenderer();
    store.emit(makeCol(999, true));
    r.resetForSession();
    // A late old-session column must be rejected at arrival, rather than
    // reinterpreted using the new Hello after compilation finishes.
    store.state.epochs = new Map();
    store.emit(makeCol(888, true));
    store.state.epochs = new Map([[0, { epoch: 0, tick: 0.5, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: ROWS }]]);
    store.state.sessionId = 'sess-2';
    store.emit(makeCol(0, true));
    ready = true;
    pump(16);
    expect(r.newestColSeq).toBe(0);
    r.dispose();
  });

  it('fits the first nonempty book with a saved price lock, then preserves the manual frame', () => {
    const { r, store } = makeRenderer();
    store.state.epochs = new Map([[0, {epoch: 0, tick: 0.001, tick_multiple: 1, dt_ns: DT_NS, p0: 0.65, rows: 256}]]);
    r.setPriceFollow('off');
    const empty = makeCol(0, false, 256);
    empty.bid.fill(0); empty.ask!.fill(0);
    store.emit(empty);
    const book = makeCol(0, true, 256);
    book.bid.fill(0); book.ask!.fill(0);
    book.bid[100] = 17000; book.ask![101] = 3000;
    store.emit(book);
    expect(r.viewSnapshot.rowScale).toBeLessThan(20);
    expect(r.priceFollow).toBe('off');
    r.setViewForTest(0, 1, 120, 50);
    store.emit({...book, col_seq: 1, t0_ns: BigInt(DT_NS)});
    expect(r.viewSnapshot.rowOffset).toBe(120);
    expect(r.viewSnapshot.rowScale).toBe(50);
    r.dispose();
  });

  it('clears buffers across five live/replay generations with a panned and price-locked live policy', () => {
    const { r, store } = makeRenderer();
    const liveT = 1_791_900_000_000_000_000n, replayT = liveT - 3_600_000_000_000n;
    for (let cycle = 0; cycle < 5; cycle++) {
      r.setFollowTime(false); r.setPriceFollow('off'); r.resetForSession();
      store.state.sessionId = `live-${cycle}`;
      store.state.epochs = new Map([[0, { epoch: 0, tick: 0.5, tick_multiple: 1, dt_ns: DT_NS, p0: 83998, rows: ROWS }]]);
      store.emit({ ...makeCol(90, true), t0_ns: liveT });
      r.setViewForTest(80, 4, 2, 4);
      expect(r.following).toBe(false); expect(r.priceFollow).toBe('off');
      r.setFollowTime(true); r.setPriceFollow('fit'); r.resetForSession();
      expect(r.newestColSeq).toBe(-1);
      store.state.sessionId = `replay-${cycle}`;
      store.state.epochs = new Map([[0, { epoch: 0, tick: 0.5, tick_multiple: 1, dt_ns: DT_NS, p0: 83473, rows: ROWS }]]);
      store.emit({ ...makeCol(7, true), t0_ns: replayT });
      pump(16 + cycle * 16);
      expect(r.newestColSeq).toBe(7); expect(r.timestampAtColumn(7)).toBe(replayT);
      expect(r.timeline()?.newestSeq).toBe(7); expect(r.following).toBe(true);
      expect(r.viewSnapshot.rowScale).toBeGreaterThan(0);
    }
    r.dispose();
  });

  it('manual price zoom is free while explicit fit frames the actual historical market', () => {
    const { r, store } = makeRenderer();
    const scale = makeHybrid({ mid: 85505, rows: 4096, coreRows: 2048, coreStep: 0.01, upMult: 11, dnFloor: 0.01 })!;
    store.state.epochs = new Map([[0, { epoch: 0, tick: 0.01, tick_multiple: 1, dt_ns: DT_NS, p0: scale.coreP0, rows: 4096,
      scale_kind: 1, dn_rows: scale.dnRows, core_rows: scale.coreRows, core_p0: scale.coreP0, core_step: scale.coreStep, lo_price: scale.loPrice, hi_price: scale.hiPrice }]]);
    r.setPriceFollow('off');
    const prices = [85438, 85504.75, 85500.89, 85594.01];
    for (let col_seq = 0; col_seq < 40; col_seq++) {
      const book = makeCol(col_seq, true, 4096);
      book.bid.fill(0); book.ask!.fill(0);
      book.bid[scale.dnRows + 1023] = 5; book.ask![scale.dnRows + 1024] = 5;
      store.emit(book);
      const c = prices[col_seq % prices.length];
      r.ingestForTest({ type: MsgType.BAR_COL, epoch: 0, col_seq, t0_ns: BigInt(col_seq) * BigInt(DT_NS), o: c, h: c + 1, l: c - 1, c, v_buy: 1, v_sell: 1, cvd: 0 } as never);
    }
    r.zoomTimeForTest(1e9);
    r.zoomPriceForTest(10);
    const manual = r.viewSnapshot;
    expect(rowToPrice(scale, manual.rowOffset + manual.rowScale) - rowToPrice(scale, manual.rowOffset)).toBeGreaterThan(225);
    r.setTimeWindowMs(null); // explicit Fit, independent of manual zoom extent
    const view = r.viewSnapshot;
    expect(view.colOffset).toBe(0);
    expect(view.colScale).toBe(40);
    const low = rowToPrice(scale, view.rowOffset), high = rowToPrice(scale, view.rowOffset + view.rowScale);
    expect(low).toBeLessThan(85437);
    expect(high).toBeGreaterThan(85595.01);
    expect(high - low).toBeLessThan(225);
    expect(r.priceFollow).toBe('off');
    for (const price of prices) {
      expect(r.overlayRowCss(priceToRow(scale, price))).toBeCloseTo((high - price) / (high - low), 6);
    }
    // Check continuous drawing projection round trips in both storage wings.
    for (const price of [85450, 85510, 85580]) {
      const expected = priceToRow(scale, price);
      const row = r.canvasCssToGrid(0, r.gridToCanvasCss(0, expected).y)?.row;
      expect(row).toBeCloseTo(expected, 5);
    }
    r.dispose();
  });

  it('hybrid hover reads the centered native bucket independently of time zoom', () => {
    gl = makeFakeGL({ colorBufferFloat: true });
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    const scale = makeHybrid({ mid: 82414.24, rows: 4096, coreRows: 2048, coreStep: .01, upMult: 11, dnFloor: .01 })!;
    store.state.epochs = new Map([[0, { epoch: 0, tick: .01, tick_multiple: 1, dt_ns: DT_NS, p0: scale.coreP0, rows: scale.rows,
      scale_kind: 1, dn_rows: scale.dnRows, core_rows: scale.coreRows, core_p0: scale.coreP0, core_step: scale.coreStep,
      lo_price: scale.loPrice, hi_price: scale.hiPrice }]]);
    const row = Math.floor(priceToRow(scale, 81812));
    const column = makeCol(0, true, scale.rows);
    column.bid.fill(0); column.ask!.fill(0);
    column.bid[row] = 2; column.bid[row + 1] = 7;
    store.emit(column);
    const low = 81750, high = 81950, price = rowToPrice(scale, row + .75);
    const bottom = priceToRow(scale, low), top = priceToRow(scale, high);
    for (const span of [1, 4000]) {
      r.setViewForTest(0, span, bottom, top - bottom);
      const probe = r.probeAt(0, 600 * (high - price) / (high - low))!;
      expect(probe.row).toBe(row + 1);
      expect(probe.group).toBe(1);
      expect(probe.bid).toBe(7);
      expect(probe.priceLo).toBeCloseTo(rowToPrice(scale, row + .5), 5);
      expect(probe.priceHi).toBeCloseTo(rowToPrice(scale, row + 1.5), 5);
    }
    r.dispose();
  });

  it('hovering an older epoch maps the cursor price into that column native grid', () => {
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    store.state.epochs = new Map([
      [0, { epoch: 0, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: 64 }],
      [1, { epoch: 1, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 110, rows: 64 }],
    ]);
    const old = makeCol(0, true, 64);
    old.bid.fill(0); old.ask!.fill(0); old.bid[30] = 9;
    store.emit(old);
    store.state.gridEpoch = 1;
    store.emit({ ...makeCol(1, true, 64), epoch: 1 });
    r.setViewForTest(0, 2, 0, 20);
    const probe = r.probeAt(250, 300)!; // current row 10 is physical price 115, old row 30.
    expect(probe.row).toBe(30);
    expect(probe.price).toBe(115);
    expect(probe.bid).toBe(9);
    r.dispose();
  });

  it('linear epoch hover matches the projected native bucket after the depth step changes', () => {
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    store.state.epochs = new Map([
      [0, { epoch: 0, tick: 1, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: 64 }],
      [1, { epoch: 1, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 110, rows: 64 }],
    ]);
    const old = makeCol(0, true, 64);
    old.bid.fill(0); old.ask!.fill(0); old.bid[30] = 2; old.bid[31] = 7;
    store.emit(old);
    store.state.gridEpoch = 1;
    store.emit({ ...makeCol(1, true, 64), epoch: 1 });
    r.setViewForTest(0, 2, 0, 64);
    // Linear events/cells retain their half-row display convention. At display
    // row 41.6, the actual shader price is 110 + (41.6-.5)*.5 = 130.55,
    // which belongs to old native centered row 31, rather than row 30.
    const probe = r.probeAt(250, 600 * (1 - 41.6 / 64))!;
    r.dispose();
    expect(probe.row).toBe(31);
    expect(probe.bid).toBe(7);
  });

  it.each([
    { tick: .25, tickMultiple: 4, p0: 100.25, decimals: 2, label: '103.25' },
    { tick: 1e-9, tickMultiple: 4, p0: 1e-7, decimals: 9, label: '0.000000112' },
  ])('hover retains native tick $tick precision with grouped storage', ({ tick, tickMultiple, p0, decimals, label }) => {
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    store.state.epochs = new Map([[0, { epoch: 0, tick, tick_multiple: tickMultiple, dt_ns: DT_NS, p0, rows: ROWS }]]);
    store.emit(makeCol(0, true));
    r.setViewForTest(0, 1, 0, ROWS);
    const probe = r.probeAt(0, 600 * (1 - 3.5 / ROWS))!;
    r.dispose();
    expect(probe.row).toBe(3);
    expect(probe.priceDecimals).toBe(decimals);
    expect(probe.price?.toFixed(probe.priceDecimals)).toBe(label);
  });

  it('derived BBO preserves cached native quote prices after a new epoch is announced', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    pump(16);
    const before = r.overlayEffectiveBboForTest()!;
    (store.state.epochs as Map<number, Record<string, unknown>>).set(1,
      { epoch: 1, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 110, rows: ROWS });
    store.state.gridEpoch = 1; // EpochStart can precede the first new depth column.
    const after = r.overlayEffectiveBboForTest()!;
    r.dispose();
    expect(after.bidPx).toBe(before.bidPx);
    expect(after.askPx).toBe(before.askPx);
  });

  it('tiny native ticks retain the physical hover footprint instead of an absolute width floor', () => {
    gl = makeFakeGL({ colorBufferFloat: true });
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    const rows = 4096;
    store.state.epochs = new Map([[0, { epoch: 0, tick: 1e-10, tick_multiple: 1, dt_ns: DT_NS, p0: 1e-7, rows }]]);
    const column = makeCol(0, true, rows); column.bid.fill(1); column.ask!.fill(0);
    store.emit(column);
    r.setViewForTest(0, 1, 0, rows);
    const probe = r.probeAt(0, 300)!;
    r.dispose();
    // 4096 native rows / 600 CSS px = 6.83 rows: level1, two four-row taps.
    expect(probe.group).toBe(8);
    expect(probe.bid).toBe(8);
    expect(probe.priceDecimals).toBe(10);
  });

  it('cached probe, BBO and profile geometry survives a same-numbered Hello replacement', () => {
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    store.emit(makeCol(0, true));
    const native = r.columnCacheForTest.priceAt(0)!;
    (store.state.epochs as Map<number, Record<string, unknown>>).set(0,
      { epoch: 0, tick: .25, tick_multiple: 2, dt_ns: DT_NS, p0: 101, rows: ROWS });
    r.setViewForTest(0, 1, 0, ROWS);
    const probe = r.probeAt(0, 600 * (1 - 1.5 / ROWS))!; // current row 1 = old row 3.
    const currentBbo = r.overlayEffectiveBboForTest()!;
    const internal = r as unknown as { rawColumnScale(col: number): PriceScale | null; overlayPriceMap(): { scale: PriceScale } };
    const profile = accumulateProfile(0, 0, 0, ROWS - 1, col => r.columnCacheForTest.arrays(col),
      undefined, undefined, 1, { target: internal.overlayPriceMap().scale, source: internal.rawColumnScale });
    expect(internal.rawColumnScale(0)).toBe(native.scale);
    expect(Object.isFrozen(native)).toBe(true);
    expect(Object.isFrozen(native.scale)).toBe(true);
    expect(native.p0).toBe(100);
    expect(native.tick).toBe(.5);
    expect(probe.row).toBe(3);
    expect(probe.price).toBe(101.5);
    expect(probe.priceDecimals).toBe(1); // old native tick, despite the new .25 tick.
    expect(probe.bid).toBe(5);
    expect(currentBbo.bidPx).toBe(101.5);
    expect(currentBbo.askPx).toBe(102);
    expect(profile.bins[1]).toBe(5);
    expect(profile.bins[2]).toBe(7);
    expect(profile.bins.reduce((sum, quantity) => sum + quantity, 0)).toBe(12);
    r.dispose();
  });

  it.each([false, true])('fresh Hello reused seq clears active cache/ring/normalization (App reset=%s)', appReset => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 4; s++) store.emit(makeCol(s, true));
    const oldRing = (r as unknown as { ring: unknown }).ring;
    (r as unknown as { overlayPriceMap(): unknown }).overlayPriceMap();
    store.state.sessionId = 'sess-2';
    (store.state.epochs as Map<number, Record<string, unknown>>).set(0,
      { epoch: 0, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 300, rows: ROWS });
    if (appReset) r.resetOverlaysForNewSession('sess-2');
    const replacement = makeCol(0, true); replacement.bid[3] = 1e6;
    store.emit(replacement);
    expect((r as unknown as { ring: unknown }).ring).not.toBe(oldRing);
    expect(r.residentRange()).toEqual({ oldest: 0, newest: 0, count: 1 });
    expect(r.columnCacheForTest.size).toBe(1);
    expect(r.columnCacheForTest.has(1)).toBe(false);
    expect(r.columnCacheForTest.priceAt(0)?.p0).toBe(300);
    expect(r.normalizerForTest.totalSamples).toBe(2);
    const norm = r.normalizerForTest.updateNorm({ oldest: 0, newest: 0 }, { lo: 0, hi: ROWS - 1 }, 0);
    expect(norm).toBeGreaterThan(1000);
    expect(r.overlayEffectiveBboForTest()?.bidPx).toBe(301.5);
    r.dispose();
  });

  it('a new Hello with advancing recorded columns preserves cached native history and normalizer membership', () => {
    const { r, store } = makeRenderer();
    for (let s = 100; s < 104; s++) store.emit(makeCol(s, true));
    const oldRing = (r as unknown as { ring: unknown }).ring;
    const oldPrice = r.columnCacheForTest.priceAt(100);
    store.state.sessionId = 'sess-2';
    (store.state.epochs as Map<number, Record<string, unknown>>).set(0,
      { epoch: 0, tick: .25, tick_multiple: 2, dt_ns: DT_NS, p0: 101, rows: ROWS });
    r.resetOverlaysForNewSession('sess-2');
    store.emit(makeCol(104, true));
    expect((r as unknown as { ring: unknown }).ring).toBe(oldRing);
    expect(r.residentRange()).toEqual({ oldest: 100, newest: 104, count: 5 });
    expect(r.columnCacheForTest.priceAt(100)).toBe(oldPrice);
    expect(r.columnCacheForTest.priceAt(100)?.p0).toBe(100);
    expect(r.columnCacheForTest.priceAt(104)?.p0).toBe(101);
    expect(r.normalizerForTest.totalSamples).toBe(10);
    // An overlapping raw history response must use its cached geometry even
    // though Hello overwrote epoch zero in the global parameter table.
    (r as unknown as { spliceColumn(column: DepthColumn): void }).spliceColumn(makeCol(100, true));
    expect(r.columnCacheForTest.priceAt(100)).toBe(oldPrice);
    expect(r.normalizerForTest.totalSamples).toBe(10);
    r.dispose();
  });

  it('a new Hello reused seq with a different timestamp resets the active timeline', () => {
    const { r, store } = makeRenderer();
    for (let seq = 0; seq < 4; seq++) store.emit(makeCol(seq, true));
    const oldRing = (r as unknown as { ring: unknown }).ring;
    store.state.sessionId = 'sess-2';
    r.resetOverlaysForNewSession('sess-2');
    store.emit({ ...makeCol(0, true), t0_ns: 10_000_000_000n });
    expect((r as unknown as { ring: unknown }).ring).not.toBe(oldRing);
    expect(r.columnCacheForTest.size).toBe(1);
    expect(r.normalizerForTest.totalSamples).toBe(2);
    expect(r.columnCacheForTest.timeAt(0)).toBe(10_000_000_000n);
    r.dispose();
  });

  it('price Fit unions old and new epoch book extents at their physical prices', () => {
    const { r, store } = makeRenderer();
    store.state.epochs = new Map([
      [0, { epoch: 0, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: 64 }],
      [1, { epoch: 1, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 110, rows: 64 }],
    ]);
    const old = makeCol(0, true, 64);
    old.bid.fill(0); old.ask!.fill(0); old.bid[30] = 9; old.ask![31] = 7;
    store.emit(old);
    store.state.gridEpoch = 1;
    const current = { ...makeCol(1, true, 64), epoch: 1 };
    current.bid.fill(0); current.ask!.fill(0); current.bid[10] = 9; current.ask![11] = 7;
    store.emit(current);
    r.setViewForTest(0, 2, 0, 64);
    r.setPriceFollow('fit');
    const view = r.viewSnapshot;
    expect(110 + view.rowOffset * .5).toBe(113.5);
    expect(110 + (view.rowOffset + view.rowScale) * .5).toBe(117.5);
    r.dispose();
  });

  it('a linear recorded epoch uses nearest native bins on the projected hybrid screen', () => {
    gl = makeFakeGL({ colorBufferFloat: true });
    const { r, canvas, store } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    const scale = makeHybrid({ mid: 81812, rows: 4096, coreRows: 2048, coreStep: .01, upMult: 11, dnFloor: .01 })!;
    store.state.epochs = new Map([
      [0, { epoch: 0, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 81000, rows: 4096 }],
      [1, { epoch: 1, tick: .01, tick_multiple: 1, dt_ns: DT_NS, p0: scale.coreP0, rows: scale.rows,
        scale_kind: 1, dn_rows: scale.dnRows, core_rows: scale.coreRows, core_p0: scale.coreP0, core_step: scale.coreStep,
        lo_price: scale.loPrice, hi_price: scale.hiPrice }],
    ]);
    const old = makeCol(0, true, 4096);
    old.bid.fill(0); old.ask!.fill(0); old.bid[1624] = 9;
    store.emit(old);
    store.state.gridEpoch = 1;
    store.emit({ ...makeCol(1, true, 4096), epoch: 1 });
    const bottom = priceToRow(scale, 81750), top = priceToRow(scale, 81950);
    r.setViewForTest(0, 4000, bottom, top - bottom);
    const probe = r.probeAt(0, 600 * (81950 - 81811.875) / 200)!;
    expect(probe.row).toBe(1624);
    expect(probe.group).toBe(1);
    expect(probe.bid).toBe(9);
    expect(probe.price).toBeCloseTo(81811.875, 5);
    expect(probe.priceLo).toBe(81811.75);
    expect(probe.priceHi).toBe(81812.25);
    r.dispose();
  });


  it('time presets preserve a history position and follow policy, then fit all loaded data', () => {
    const { r, store } = makeRenderer();
    for (let i = 0; i < 200; i++) store.emit(makeCol(i, true));
    r.setFollowTime(false);
    r.setViewForTest(60, 40, 0, 256);
    const end = r.viewSnapshot.colOffset + r.viewSnapshot.colScale;
    expect(r.setTimeWindowMs(250)).toBe(true);
    expect(r.viewSnapshot.colOffset + r.viewSnapshot.colScale).toBeCloseTo(end);
    expect(r.following).toBe(false);
    expect(r.setTimeWindowMs(null)).toBe(true);
    expect(r.viewSnapshot.colOffset).toBe(0);
    expect(r.viewSnapshot.colScale).toBe(200);
    expect(r.following).toBe(false);
    r.dispose();
  });

  it('price Fit honors immutable native maps even when both books use epoch zero', () => {
    const { r, store } = makeRenderer();
    store.state.epochs = new Map([[0, { epoch: 0, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: 64 }]]);
    const old = makeCol(0, true, 64);
    old.bid.fill(0); old.ask!.fill(0); old.bid[30] = 9; old.ask![31] = 7;
    store.emit(old);
    (store.state.epochs as Map<number, Record<string, unknown>>).set(0,
      { epoch: 0, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 110, rows: 64 });
    const current = makeCol(1, true, 64);
    current.bid.fill(0); current.ask!.fill(0); current.bid[10] = 9; current.ask![11] = 7;
    store.emit(current);
    r.setViewForTest(0, 2, 0, 64);
    r.setPriceFollow('fit');
    const view = r.viewSnapshot;
    expect(110 + view.rowOffset * .5).toBe(113.5);
    expect(110 + (view.rowOffset + view.rowScale) * .5).toBe(117.5);
    r.dispose();
  });

  it('linear viewport normalization excludes the adjacent offscreen native row', () => {
    const { r, store } = makeRenderer();
    const column = makeCol(0, true);
    column.bid.fill(0); column.ask!.fill(0); column.bid[0] = .01; column.bid[1] = 1e6;
    store.emit(column);
    r.setViewForTest(0, 1, 0, 1);
    (r as unknown as { updateNormalization(): void }).updateNormalization();
    expect(r.currentNorm).toBeGreaterThan(.009);
    expect(r.currentNorm).toBeLessThan(.012);
    r.dispose();
  });

  it('frames a deep book before its first bar and clears foreign price limits on a symbol switch', () => {
    const { r, store } = makeRenderer();
    const scale = makeHybrid({ mid: 85500, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01 })!;
    store.state.epochs = new Map([[0, { epoch: 0, tick: 0.01, tick_multiple: 50, dt_ns: DT_NS, p0: scale.coreP0, rows: 4096,
      scale_kind: 1, dn_rows: scale.dnRows, core_rows: scale.coreRows, core_p0: scale.coreP0, core_step: scale.coreStep, lo_price: scale.loPrice, hi_price: scale.hiPrice }]]);
    r.setPriceFollow('off');
    const book = makeCol(0, true, 4096);
    book.bid.fill(0); book.ask!.fill(0);
    book.bid[scale.dnRows] = 3;
    book.bid[scale.dnRows + 1023] = 4;
    book.ask![scale.dnRows + 1024] = 4;
    book.ask![scale.dnRows + 2047] = 3;
    store.emit(book);
    const span = () => rowToPrice(scale, r.viewSnapshot.rowOffset + r.viewSnapshot.rowScale) - rowToPrice(scale, r.viewSnapshot.rowOffset);
    expect(span()).toBeCloseTo(32);
    expect(r.setTimeWindowMs(null)).toBe(true);
    expect(span()).toBeCloseTo(32);
    const camera = (r as unknown as { camera: { priceZoomBounds: unknown; priceScale: unknown } }).camera;
    expect(camera.priceZoomBounds).not.toBeNull();
    r.resetForSession();
    expect(camera.priceZoomBounds).toBeNull();
    expect(camera.priceScale).toBeNull();
    r.dispose();
  });

  it('lets a cold duration preset fill as data arrives and lets All retain the loaded history', () => {
    const { r, store } = makeRenderer();
    for (let i = 0; i < 10; i++) store.emit(makeCol(i, true));
    expect(r.setTimeWindowMs(1000)).toBe(true);
    expect(r.following).toBe(true);
    for (let i = 10; i < 60; i++) store.emit(makeCol(i, true));
    expect(r.viewSnapshot.colScale).toBeCloseTo(40);
    expect(r.timeWindowMs).toBe(1000);
    r.setTimeWindowMs(null);
    for (let i = 60; i < 80; i++) store.emit(makeCol(i, true));
    expect(r.viewSnapshot.colScale).toBe(80);
    r.zoomTimeForTest(0.5);
    expect(r.timeWindowMs).toBeUndefined();
    const span = r.viewSnapshot.colScale;
    r.goLive();
    store.emit(makeCol(80, true));
    expect(r.viewSnapshot.colScale).toBe(span);
    r.dispose();
  });

  it('folds only final columns, and a re-sent column id never double-counts', () => {
    const { r, store } = makeRenderer();

    // A forming edge column is re-sent every flush — none of those may fold.
    store.emit(makeCol(5, false));
    store.emit(makeCol(5, false));
    expect(r.normalizerForTest.totalSamples).toBe(0);

    // The final send folds exactly once (bid[3]=5 + ask[4]=7 → 2 samples).
    store.emit(makeCol(5, true));
    expect(r.normalizerForTest.totalSamples).toBe(2);

    // History pages overlap by design: the same final column re-arriving must
    // not fold again.
    store.emit(makeCol(5, true));
    expect(r.normalizerForTest.totalSamples).toBe(2);

    // A genuinely new final column folds.
    store.emit(makeCol(6, true));
    expect(r.normalizerForTest.totalSamples).toBe(4);
  });

  // --- B-6: the clear color IS the ramp's LUT entry 0 ---------------------------

  it('clears with the active ramp background (single source of truth, no reset flash)', () => {
    makeRenderer();
    const bg = clearColorForRamp();
    const clears = gl.callsOf('clearColor');
    expect(clears.length).toBeGreaterThan(0);
    for (const c of clears) {
      expect(c.args[0]).toBe(bg[0]);
      expect(c.args[1]).toBe(bg[1]);
      expect(c.args[2]).toBe(bg[2]);
      expect(c.args[3]).toBe(1);
    }
  });

  // --- B-3: one GL error must not kill the render loop --------------------------

  it('reschedules the rAF loop after a throwing draw and surfaces the error once', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));

    pump(16); // clean frame: draws, no error surfaced
    expect(asyncThrows.length).toBe(0);

    // Failing frame: the draw throws, the loop must still reschedule...
    gl.failDraw = true;
    store.emit(makeCol(1, true)); // re-dirty so the draw path runs again
    pump(32);
    expect(rafQueue.length).toBe(1); // finally() re-armed the loop
    // ...and the failure is surfaced exactly once (async re-throw).
    expect(asyncThrows.length).toBe(1);
    expect(() => asyncThrows[0]()).toThrow('simulated GL draw failure');

    // A persistently broken draw is NOT re-reported every frame.
    store.emit(makeCol(2, true));
    pump(48);
    expect(rafQueue.length).toBe(1);
    expect(asyncThrows.length).toBe(1);

    // A clean frame re-arms the guard: a NEW failure episode is reported.
    gl.failDraw = false;
    pump(64);
    gl.failDraw = true;
    store.emit(makeCol(3, true));
    pump(80);
    expect(asyncThrows.length).toBe(2);
    expect(r.drawCount).toBeGreaterThan(0);
  });

  it('keeps the store fanout alive when a DEPTH_COL ingest throws', () => {
    const { r, store } = makeRenderer();
    // After construction (initGL warns about the missing float ext), the spy
    // counts ONLY ingest warnings.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bad = makeCol(0, true);
    Object.defineProperty(bad, 'bid', {
      get() {
        throw new Error('malformed column');
      },
    });
    expect(() => store.emit(bad)).not.toThrow();
    expect(() => store.emit(bad)).not.toThrow();
    // Warned once (suppressed after the first), never propagated to the fanout.
    expect(warn).toHaveBeenCalledTimes(1);

    // The stream still works: a good column flows through the whole path.
    store.emit(makeCol(0, true));
    expect(r.normalizerForTest.totalSamples).toBe(2);
    warn.mockRestore();
  });

  // --- W2 SEAMS: forward col_seq skips must not blank the whole chart -----------

  it('repairs a small forward skip by zeroing the band and keeping validFrom', () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));
    expect(r.validFromSeq).toBe(10);
    const uploadsBefore = gl.callsOf('texSubImage3D').length;

    // A server tx_lag drop burst: cols 15..17 are gone; 18 arrives.
    store.emit(makeCol(18, true));

    expect(r.residentRange()).toEqual({ oldest: 10, newest: 18, count: 9 });
    expect(r.validFromSeq).toBe(10); // NOT 18 — the old behavior blacked out [10..17]
    const zeroUploads = gl.callsOf('texSubImage3D').slice(uploadsBefore, uploadsBefore + 3);
    expect(zeroUploads.length).toBe(3); // one zero texel column per skipped seq
    for (const call of zeroUploads) {
      const data = call.args[10] as Float32Array;
      expect(Array.from(data).every((v) => v === 0)).toBe(true);
    }
  });

  it('keeps the conservative gate for a skip larger than the repair cap', () => {
    const { r, store } = makeRenderer(); // capacity 512
    for (let s = 0; s <= 4; s++) store.emit(makeCol(s, true));
    store.emit(makeCol(1000, true)); // band 995 > GAP_ZERO_MAX_COLS
    expect(r.validFromSeq).toBe(1000);
  });

  // --- F24: a repaired skip band is refetched from the session grid ring ------

  /** Await the loader's async band refetch (requestHistory → splice loop). */
  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('reloads the visible suffix after a large jump even when residency claims it', async () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s <= 4; s++) store.emit(makeCol(s, true));
    store.emit(makeCol(1000, true));
    const request = vi.fn(async (_before: bigint, _count: number, range?: HistoryOverviewRequest) => ({
      type: MsgType.HISTORY_RESP, req_id: 1, epoch: 0,
      oldest_available_t_ns: 0n,
      depth_cols: [994, 995, 996, 997, 998, 999]
        .filter(seq => range && seq >= range.start_col && seq <= range.end_col)
        .map(s => makeCol(s, true)),
      bar_cols: [], markers: [], big_trades: [],
    }));
    store.state.requestHistory = request;
    r.setFollowTime(false);
    r.setViewForTest(994, 7, 0, ROWS);
    pump(16);
    await flushMicrotasks();
    expect(request).toHaveBeenCalledTimes(1);
    const [, count, sourceRange] = request.mock.calls[0];
    expect(sourceRange).toMatchObject({ end_col: 999, stride: 1 });
    expect(sourceRange!.start_col).toBeLessThanOrEqual(994);
    expect(count).toBe(sourceRange!.end_col - sourceRange!.start_col + 1);
    expect(count).toBeLessThanOrEqual(256);
    expect(r.validFromSeq).toBe(994);
    for (let s = 994; s <= 1000; s++) expect(r.columnCacheForTest.has(s)).toBe(true);
    r.dispose();
  });

  it('manual forward pan can reach newly received columns while old history stays resident', () => {
    const { r, store } = makeRenderer();
    for (let seq = 0; seq <= 4; seq++) store.emit(makeCol(seq, true));
    r.setFollowTime(false);
    r.setViewForTest(0, 128, 2, 4);
    const resident = r.residentRange();

    store.emit(makeCol(1000, true));
    expect(r.newestColSeq).toBe(1000);
    expect(r.residentRange()).toEqual(resident);
    expect(r.columnCacheForTest.has(1000)).toBe(false);
    r.panColumnsForTest(900);
    expect(r.viewSnapshot.colOffset).toBe(900);
    expect(r.following).toBe(false);
    r.dispose();
  });

  it('a live price epoch change preserves the manual time window during history reload', () => {
    const { r, store } = makeRenderer();
    for (let seq = 0; seq <= 4; seq++) store.emit(makeCol(seq, true));
    r.setFollowTime(false);
    store.emit(makeCol(1000, true));
    r.setViewForTest(900, 64, 2, 4);
    const before = r.viewSnapshot;
    const resident = r.residentRange();
    (store.state.epochs as Map<number, Record<string, unknown>>).set(1,
      { epoch: 1, tick: .5, tick_multiple: 1, dt_ns: DT_NS, p0: 101, rows: ROWS });
    store.state.gridEpoch = 1;

    store.emit({ ...makeCol(1100, true), epoch: 1 });
    pump(16);
    expect(r.viewSnapshot.colOffset).toBe(before.colOffset);
    expect(r.viewSnapshot.colScale).toBe(before.colScale);
    expect(r.following).toBe(false);
    expect(r.residentRange()).toEqual(resident);
    expect(r.columnCacheForTest.has(1100)).toBe(false);
    r.dispose();
  });

  it('refetches a repaired skip band from history and splices the REAL columns', async () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));

    const calls: Array<{ n: number; range?: HistoryOverviewRequest }> = [];
    store.state.requestHistory = (_before_t: bigint, n: number, range?: HistoryOverviewRequest) => {
      calls.push({ n, range });
      // The server evicted only OUR queue; its exact source page still holds
      // the missing band. Respect the request so a wrong target stays missing.
      const depth_cols = [13, 14, 15, 16, 17]
        .filter(seq => range && seq >= range.start_col && seq <= range.end_col)
        .map((s) => makeCol(s, true));
      return Promise.resolve({
        type: MsgType.HISTORY_RESP,
        req_id: 1,
        epoch: 0,
        oldest_available_t_ns: 0n,
        depth_cols,
        bar_cols: [],
        markers: [],
        big_trades: [],
      });
    };

    // A server tx_lag drop burst: cols 15..17 are gone; 18 arrives.
    store.emit(makeCol(18, true));
    expect(r.validFromSeq).toBe(10); // the synchronous repair contract first

    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ n: 3, range: { start_col: 15, end_col: 17, stride: 1 } });
    // The zeroes were replaced by the real columns: they are cached/resident now.
    for (const s of [15, 16, 17]) expect(r.columnCacheForTest.has(s)).toBe(true);
    expect(r.validFromSeq).toBe(10); // in-place splices never move validity
  });

  it('a failed band refetch leaves the honest zeroes in place (no throw)', async () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));
    store.state.requestHistory = () => Promise.reject(new Error('history request timed out'));

    expect(() => store.emit(makeCol(18, true))).not.toThrow();
    await flushMicrotasks();
    expect(r.validFromSeq).toBe(10);
    expect(r.columnCacheForTest.has(15)).toBe(false); // zeroes still the fallback
  });

  it('an empty band page (server no longer holds it) keeps the zeroes', async () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));
    store.state.requestHistory = () =>
      Promise.resolve({
        type: MsgType.HISTORY_RESP,
        req_id: 1,
        epoch: 0,
        oldest_available_t_ns: 0n,
        depth_cols: [],
        bar_cols: [],
        markers: [],
        big_trades: [],
      });

    store.emit(makeCol(18, true));
    await flushMicrotasks();
    expect(r.validFromSeq).toBe(10);
    expect(r.columnCacheForTest.has(15)).toBe(false);
  });

  // --- B-7(d): the CPU column cache covers the ring (profile window honesty) ----

  it('keeps every resident column cached so the profile window matches residency', () => {
    const { r, store } = makeRenderer(4096); // ring 4096 > the old 2048 cache default
    const n = 2100;
    for (let s = 0; s < n; s++) store.emit(makeCol(s, true));

    const range = r.residentRange();
    expect(range).not.toBeNull();
    expect(r.residentBudgetCols).toBe(4096);
    // The old 2048-entry cache would have evicted [0..51] — the profile (and
    // the crosshair) would then silently under-report resident history.
    for (let c = range!.oldest; c <= range!.newest; c++) {
      expect(r.columnCacheForTest.has(c), `column ${c} cached`).toBe(true);
    }
  });

  // --- B-9: snapshot() -----------------------------------------------------------

  it('snapshot() forces a synchronous frame then returns the PNG data URL', () => {
    const { r, canvas, store } = makeRenderer();
    store.emit(makeCol(0, true));

    const toDataURL = vi.fn(() => 'data:image/png;base64,TEST');
    canvas.toDataURL = toDataURL as unknown as typeof canvas.toDataURL;
    const drawsBefore = gl.callsOf('drawArrays').length;

    const url = r.snapshot();
    expect(url).toBe('data:image/png;base64,TEST');
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    // "Force one synchronous full frame": heatmap + overlays actually drew.
    expect(gl.callsOf('drawArrays').length).toBeGreaterThan(drawsBefore);
  });

  it('snapshot() returns null on a lost context without touching GL', () => {
    const { r, canvas } = makeRenderer();
    const toDataURL = vi.fn(() => 'data:image/png;base64,TEST');
    canvas.toDataURL = toDataURL as unknown as typeof canvas.toDataURL;
    const drawsBefore = gl.callsOf('drawArrays').length;

    gl.contextLost = true;
    expect(r.snapshot()).toBeNull();
    expect(gl.callsOf('drawArrays').length).toBe(drawsBefore);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  // --- C2: depth channel modes ---------------------------------------------------

  /** The u_channel value of every heatmap draw since `before`. */
  function channelValues(before: number): number[] {
    return gl
      .callsOf('uniform1i')
      .slice(before)
      .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === 'u_channel')
      .map((c) => c.args[1] as number);
  }

  it('C2: the default channel is sum (u_channel 0) on every draw', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const before = gl.callsOf('uniform1i').length;
    store.emit(makeCol(1, true));
    pump(16);
    expect(r.getDepthChannel()).toBe('sum');
    expect(channelValues(before)).toEqual([0]);
  });

  it('C2: setDepthChannel cycles u_channel; invalid values fall back to sum', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    let before = gl.callsOf('uniform1i').length;

    r.setDepthChannel('bid');
    expect(r.getDepthChannel()).toBe('bid');
    pump(32);
    expect(channelValues(before)).toEqual([1]);

    before = gl.callsOf('uniform1i').length;
    r.setDepthChannel('ask');
    r.setDepthChannel('imbalance');
    pump(48);
    // One draw between captures renders the LATEST setter value.
    expect(channelValues(before)).toEqual([3]);

    // A settings-persisted garbage value never poisons the shader.
    before = gl.callsOf('uniform1i').length;
    r.setDepthChannel('nonsense' as never);
    expect(r.getDepthChannel()).toBe('sum');
    pump(64);
    expect(channelValues(before)).toEqual([0]);
  });

  it('C2 honesty: a SYNTH session forces u_channel 0 whatever the user picked', () => {
    const { r, store } = makeRenderer();
    store.state.capability = { depth: 'SYNTH' }; // §7 honesty tier
    store.emit(makeCol(0, true)); // MODE_L2 column, but capability says SYNTH
    r.setDepthChannel('imbalance');
    const before = gl.callsOf('uniform1i').length;
    store.emit(makeCol(1, true));
    pump(16);
    expect(r.getDepthChannel()).toBe('imbalance'); // the SETTING is remembered...
    expect(channelValues(before)).toEqual([0]); // ...but SYNTH renders sum
  });

  it('keeps synthetic depth in Sum for every themed synthetic ramp', () => {
    const { r, store } = makeRenderer();
    store.state.capability = { depth: 'SYNTH' };
    store.emit(makeCol(0, true));
    r.setColormap('theme');
    for (const [index, id] of THEME_IDS.entries()) {
      r.setChartTheme({ id, density: THEMES[id].chart.density, synth: THEMES[id].chart.synth });
      r.setDepthChannel('imbalance');
      const before = gl.callsOf('uniform1i').length;
      pump((index + 1) * 16);
      expect(channelValues(before), id).toEqual([0]);
    }
    expect(r.getDepthChannel()).toBe('imbalance');
    r.setChartTheme(null);
  });

  it('normalization moves the white endpoint and keeps a lower coordinated knee', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const n = r.normalizerForTest;
    r.setNormPercentile(80);
    expect(n.whitePercentile).toBe(80);
    expect(n.percentile).toBeCloseTo(77.3);
    r.setNormPercentile(100);
    expect(n.whitePercentile).toBe(100);
    expect(n.percentile).toBeCloseTo(97.3);
    r.setNormPercentile(Number.NaN);
    expect(n.whitePercentile).toBe(99.7);
    expect(n.percentile).toBeCloseTo(97);
    r.setNormPercentile(20);
    expect(n.whitePercentile).toBe(80);
  });

  // --- C3: renderer.stats() ------------------------------------------------------

  it('C3: stats() EMA-converges fps, counts uploads/draws, and reports cache bytes', () => {
    const { r, store } = makeRenderer();
    const s0 = r.stats();
    expect(s0.fps).toBe(0); // no frame yet
    expect(s0.frameMs).toBe(0);
    expect(s0.uploads).toBe(0);
    expect(s0.draws).toBe(0);
    expect(s0.cacheBytes).toBeGreaterThan(0); // slot metadata (pool fills on put)

    const n = 12;
    for (let s = 0; s < n; s++) store.emit(makeCol(s, true));
    expect(r.stats().uploads).toBe(n);

    let ts = 1000;
    for (let f = 0; f < 60; f++) {
      pump(ts);
      ts += 16.667; // 60 fps rAF cadence
    }
    const s1 = r.stats();
    expect(s1.fps).toBeGreaterThan(55); // converged near 60
    expect(s1.fps).toBeLessThanOrEqual(60);
    expect(s1.frameMs).toBeGreaterThanOrEqual(0);
    expect(s1.draws).toBeGreaterThan(0);
    expect(s1.cacheBytes).toBeGreaterThan(0);
    const draws1 = s1.draws;

    // A hung tab (delta > 1 s) is skipped, not folded in as a fake 1 fps.
    pump(ts + 5000);
    expect(r.stats().fps).toBeGreaterThan(55);

    // Cumulative counters stay monotonic.
    expect(r.stats().draws).toBeGreaterThanOrEqual(draws1);
  });

  it('C3: cacheBytes grows only PAGE-WISE and is fixed once the touched pages stop growing', () => {
    // Paged pool (fix 2026-09-10 F1-1): pages of 256 slots allocate once on
    // first touch; re-puts / ring wraps inside resident pages never allocate.
    const { r, store } = makeRenderer(512);
    for (let s = 0; s < 100; s++) store.emit(makeCol(s, true)); // page 0 only
    const bytes = r.stats().cacheBytes;
    for (let s = 100; s < 250; s++) store.emit(makeCol(s, true)); // still page 0
    expect(r.stats().cacheBytes).toBe(bytes);
    for (let s = 250; s < 700; s++) store.emit(makeCol(s, true)); // touches page 1, then wraps
    expect(r.stats().cacheBytes).toBeGreaterThan(bytes); // one extra page max
    const capped = r.stats().cacheBytes;
    for (let s = 700; s < 1200; s++) store.emit(makeCol(s, true)); // wrap within 2 pages
    expect(r.stats().cacheBytes).toBe(capped);
  });

  // --- survey #6a: the normalization memo -----------------------------------------

  it('repeated dirty frames with an unchanged window do NOT re-merge tile histograms', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 4; s++) store.emit(makeCol(s, true));
    pump(100); // first draw: the merge actually runs once
    const norm = r.normalizerForTest;
    const mergesAfterFold = norm.mergeCount;
    expect(mergesAfterFold).toBeGreaterThan(0);

    // Redraw the same view several times: the memo must hold.
    for (let f = 0; f < 5; f++) pump(120 + f * 16);
    expect(norm.mergeCount).toBe(mergesAfterFold);

    // A NEW final column folds (tilesVersion bump) → the next frame re-merges.
    store.emit(makeCol(5, true));
    pump(220);
    expect(norm.mergeCount).toBeGreaterThan(mergesAfterFold);
  });

  // --- campaign 4: tick grouping, prune guard, restore, frame ms, view seam -----

  /** The value of the LAST uniform1i call for a named uniform (GL transcript). */
  function lastUniform(name: string): unknown {
    const calls = gl
      .callsOf('uniform1i')
      .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
    return calls.length > 0 ? calls[calls.length - 1].args[1] : undefined;
  }

  /** A 512-row epoch so the mip-capable (rows % 16 === 0) path is active. */
  function setEpochRows(store: FakeStore, rows: number): void {
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(0, {
      epoch: 0,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: 100,
      rows,
    });
  }

  it('P1: tickGrouping floors the mip level; n=1 restores the natural selection', () => {
    gl = makeFakeGL({ colorBufferFloat: true }); // mips exist → levels 0/1/2
    const { r, store, canvas } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: gl.drawingBufferWidth });
    Object.defineProperty(canvas, 'clientHeight', { value: gl.drawingBufferHeight });
    setEpochRows(store, 512);
    store.emit(makeCol(0, true, 512));
    pump(16);
    // Default: the natural selection (rowsPerPixel ≈ 2.1 → level 0).
    expect(r.getTickGrouping()).toBe(1);
    expect(lastUniform('u_level')).toBe(0);
    expect(lastUniform('u_blk')).toBe(1);

    // n=4 → the 4-row block; n=16 → the 16-row block.
    r.setTickGrouping(4);
    store.emit(makeCol(1, true, 512));
    pump(32);
    expect(lastUniform('u_level')).toBe(1);
    expect(lastUniform('u_blk')).toBe(4);

    r.setTickGrouping(16);
    store.emit(makeCol(2, true, 512));
    pump(48);
    expect(lastUniform('u_level')).toBe(2);
    expect(lastUniform('u_blk')).toBe(16);
    expect(r.currentMipLevel).toBe(2);

    // The crosshair reports the TRUE displayed block (group-consistent).
    r.setViewForTest(0, 64, 0, 512);
    const px = r.cellToCanvasCss(10, 200);
    expect(r.probeAt(px.x, px.y)?.group).toBe(16);

    // Non-power-of-4 requests round UP to the next mip block (4^k only): 2 → 4.
    r.setTickGrouping(2);
    store.emit(makeCol(3, true, 512));
    pump(64);
    expect(lastUniform('u_level')).toBe(1);
    expect(lastUniform('u_blk')).toBe(4);

    // Clamp + n=1 identity: the coarsest representable block wins (R1-L2).
    r.setTickGrouping(999);
    expect(r.getTickGrouping()).toBe(16);
    r.setTickGrouping(1);
    store.emit(makeCol(4, true, 512));
    pump(80);
    // F10 (2026-09-14) moved ROW_MIP_EDGE 2.5 → 1.5 for the sampler coverage
    // fix; at this view (rowScale 512 over the harness buffer) the natural
    // selection is now the ROW-MIP path itself: level 0, blk 4, rowFade > 0.
    expect(lastUniform('u_level')).toBe(0);
    expect(lastUniform('u_blk')).toBe(4);
  });

  it('P1: the tick-grouping floor does NOT suppress history backfill', () => {
    gl = makeFakeGL({ colorBufferFloat: true });
    const { r, store } = makeRenderer();
    setEpochRows(store, 512);
    for (let s = 0; s < 8; s++) store.emit(makeCol(s, true, 512));
    pump(16);
    // `history` is private; a spy on ensureVisible is the only way to observe
    // the O(1) backfill gate's level argument.
    const hist = (
      r as unknown as { history: { ensureVisible: (v: { level: number }) => void } }
    ).history;
    const ensure = vi.spyOn(hist, 'ensureVisible');

    r.setTickGrouping(16); // display level 2
    r.setViewForTest(0, 64, 0, 512); // natural level 0 (rowsPerPixel ≈ 2.1)
    pump(32);

    expect(ensure).toHaveBeenCalled();
    const lastCall = ensure.mock.calls[ensure.mock.calls.length - 1][0];
    // The gate tracks the NATURAL zoom level, not the forced display block: a
    // grouped view still needs resident columns for the crosshair/profile and
    // for its own mip generation.
    expect(lastCall.level).toBe(0);
    // …while the display (and probeAt) really are at the forced level.
    expect(r.currentMipLevel).toBe(2);
  });

  it('B-2: overlay prune is skipped until the window edge moves beyond the pad', () => {
    const { r, store } = makeRenderer();
    const overlays = (r as unknown as { overlays: { prune: (...a: number[]) => void } }).overlays;
    const spy = vi.spyOn(overlays, 'prune');

    store.emit(makeCol(0, true));
    expect(spy).toHaveBeenCalledTimes(1); // first window: one sweep

    // The forming edge re-sends the SAME column: the window is static → skip.
    for (let i = 0; i < 40; i++) store.emit(makeCol(0, false));
    expect(spy).toHaveBeenCalledTimes(1);

    // Slide the newest edge past the pad (64) → exactly one more sweep.
    for (let s = 1; s <= 65; s++) store.emit(makeCol(s, true));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][2]).toBe(64); // the pad is passed explicitly
  });

  it('B-4: context restore keeps the user follow intent instead of re-arming it', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    pump(16);

    r.setFollowTime(false);
    pump(32);
    expect(r.following).toBe(false);
    expect(r.priceFollow).toBe('track'); // time release promotes fit → track

    // The webglcontextrestored handler (private; e2e drives it via loseContextForTest).
    (r as unknown as { onContextRestored(): void }).onContextRestored();
    expect(r.contextRestoredCount).toBe(1);
    // Before the fix this was silently true again while the UI showed OFF.
    expect(r.following).toBe(false);
    expect(r.priceFollow).toBe('track');
  });

  it('restores a wide manually owned frame and calibrated tolerance after GPU context loss', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(10000, true));
    pump(16);
    r.setTimeWindowMs(null);
    r.setPriceFollow('off');
    r.setTolerance(50);
    const view = r.viewSnapshot;
    (r as unknown as { onContextRestored(): void }).onContextRestored();
    expect(r.viewSnapshot).toEqual(view);
    expect(r.priceFollow).toBe('off');
    expect((r as unknown as { heatmap: { toleranceValue: number } }).heatmap.toleranceValue).toBe(50);
    r.dispose();
  });

  it('B-5: stats().frameMs measures the FULL frame — the overlay pass included', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const overlays = (r as unknown as { overlays: { draw: (ctx: unknown) => void } }).overlays;
    const drawSpy = vi.spyOn(overlays, 'draw');

    let reads = 0;
    let overlaysDrawnBySpanEnd = false;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      reads += 1;
      if (reads === 1) return 1000; // t0
      // The span END read: the overlay pass must already have run for the HUD
      // sample to include it (reverting to the old order makes this false).
      overlaysDrawnBySpanEnd = drawSpy.mock.calls.length > 0;
      return 1007;
    });
    pump(16);
    nowSpy.mockRestore();

    expect(drawSpy).toHaveBeenCalled(); // overlays actually drew
    expect(overlaysDrawnBySpanEnd).toBe(true);
    expect(r.stats().frameMs).toBeCloseTo(7, 5); // the whole frame, not just the heatmap
  });

  it('stretch: onViewChanged fires on camera moves, isolates throws, unsubscribes', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));

    let fired = 0;
    const off = r.onViewChanged(() => {
      fired += 1;
    });
    r.panColumnsForTest(-5);
    expect(fired).toBe(1);
    r.setViewForTest(0, 32, 0, 32);
    expect(fired).toBe(2);

    off();
    r.panColumnsForTest(-5);
    expect(fired).toBe(2);

    // A throwing listener is warned once and never breaks the camera move.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off2 = r.onViewChanged(() => {
      throw new Error('bad listener');
    });
    expect(() => r.panColumnsForTest(-5)).not.toThrow();
    r.panColumnsForTest(-5);
    expect(warn).toHaveBeenCalledTimes(1); // report-once guard
    off2();
    warn.mockRestore();
  });

  // --- chart bug-fix campaign (2026-09-11): B2 renderer + follow ---------------

  interface PrivRenderer {
    trackedRowN: number | null;
    trackedEpoch: number | null;
    priceEpoch: number | null;
    forcedRemapFrom: unknown;
    lastPriceMapCache: unknown;
    overlayPriceMap(): unknown;
    camera: { remapPrice(rowCenter: number, rowSpan: number): void };
  }

  function priv(r: Renderer): PrivRenderer {
    return r as unknown as PrivRenderer;
  }

  function overlaysOf(r: Renderer): { reset: () => void; clearInk?: () => void } {
    return (r as unknown as { overlays: { reset: () => void } }).overlays;
  }

  function makeColAt(
    seq: number,
    epoch: number,
    bidRow: number,
    askRow: number,
    rows: number,
    t0?: bigint,
  ): DepthColumn {
    const bid = new Float32Array(rows);
    bid[bidRow] = 5;
    const ask = new Float32Array(rows);
    ask[askRow] = 7;
    return {
      type: MsgType.DEPTH_COL,
      epoch,
      col_seq: seq,
      t0_ns: t0 ?? BigInt(seq) * BigInt(DT_NS),
      mode: MODE_L2,
      final: true,
      bid,
      ask,
    };
  }

  it('B2-CP1: liveEdgeVisible follows the newest column, not the follow mode', () => {
    const { r, store } = makeRenderer();
    expect(r.liveEdgeVisible).toBe(false); // no column yet
    store.emit(makeCol(0, true));
    expect(r.liveEdgeVisible).toBe(true);
    store.emit(makeCol(1000, true)); // real earlier history can be inspected
    r.panColumnsForTest(-100000); // scrolled back: edge off-screen, TRACK cannot act
    expect(r.following).toBe(false);
    expect(r.liveEdgeVisible).toBe(false);
    r.goLive();
    expect(r.liveEdgeVisible).toBe(true);
  });

  it('GO LIVE preserves the user TIME zoom exactly (owner contract 2026-09-14)', () => {
    const { r, store } = makeRenderer();
    // Enough resident data that the preserved span is not clamped by the
    // available-column count (real sessions carry thousands).
    for (let s = 0; s < 200; s++) store.emit(makeCol(s, true));
    pump(16);
    const priv = r as unknown as {
      controller: {
        zoomTimeAtFraction: (f: number, x: number) => void;
        goLive: () => void;
      };
      camera: { state: { colSpan: number } };
    };
    const defaultSpan = priv.camera.state.colSpan;
    expect(defaultSpan).toBeGreaterThan(0);

    // Zoom OUT via the wheel path (follow releases; span becomes user-owned).
    priv.controller.zoomTimeAtFraction(2, 0.5);
    const zoomedOut = priv.camera.state.colSpan;
    expect(zoomedOut).toBeGreaterThan(defaultSpan);
    // GO LIVE re-pins the right edge but must keep THAT span — the old code
    // re-derived the default window here (the "GO LIVE → çok yakın" bug).
    priv.controller.goLive();
    expect(priv.camera.state.colSpan).toBeCloseTo(zoomedOut, 6);
    expect(r.liveEdgeVisible).toBe(true);

    // The zoom-IN case is symmetric: a deliberate close-up survives GO LIVE.
    priv.controller.zoomTimeAtFraction(0.2, 0.5);
    const zoomedIn = priv.camera.state.colSpan;
    expect(zoomedIn).toBeLessThan(zoomedOut);
    priv.controller.goLive();
    expect(priv.camera.state.colSpan).toBeCloseTo(zoomedIn, 6);
    expect(r.liveEdgeVisible).toBe(true);
  });

  it('B2-CP1: resetOverlaysForNewSession rewinds cursors + clears ink but KEEPS the ring', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 5; s++) store.emit(makeCol(s, true));
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;
    const range = r.residentRange();
    expect(range).not.toBeNull();

    r.resetOverlaysForNewSession();

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(inkSpy).toHaveBeenCalledTimes(1);
    expect(r.newestColSeq).toBe(-1);
    expect(priv(r).trackedRowN).toBeNull();
    // Cursor-only: the resident ring (scrolled-back history) survives.
    expect(r.residentRange()).toEqual(range);
    expect(r.isResidentFullRes(0)).toBe(true);
  });

  it('B2-H1/C3: resetForSession clears overlay ink + data even while the GL context is lost', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;

    gl.contextLost = true;
    r.resetForSession();

    expect(inkSpy).toHaveBeenCalledTimes(1); // BEFORE the glLost early return
    expect(resetSpy).toHaveBeenCalledTimes(1); // CPU teardown is unconditional now
    expect(r.newestColSeq).toBe(-1); // cursors rewound even while lost
  });

  it('B2-H2: recreateRingForRows clears the stale GL image when it rebuilds the ring', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const clears = gl.callsOf('clear').length;
    (r as unknown as { recreateRingForRows(rows: number): void }).recreateRingForRows(64);
    expect(gl.callsOf('clear').length).toBeGreaterThan(clears);
  });

  it('B2-C2: drawOverlays clears leftover 2D ink when every overlay is off', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const overlays = overlaysOf(r);
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;
    r.setOverlayVisibility({
      bubbles: false,
      bbo: false,
      vwap: false,
      profile: false,
      markers: false,
      axes: false,
      price: false,
      volume: false, // F26 lane's strip: an explicit off, or anyVisible stays true
      gex: false,
    });
    (r as unknown as { drawOverlays(): void }).drawOverlays();
    expect(inkSpy).toHaveBeenCalledTimes(1);
  });

  it('B2-C2: drawOverlays clears ink when neither the price nor the time map exists', () => {
    const { r, store } = makeRenderer();
    const overlays = overlaysOf(r);
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;
    (store.state as unknown as { gridEpoch: number | null }).gridEpoch = null; // no price affine
    (r as unknown as { drawOverlays(): void }).drawOverlays();
    expect(inkSpy).toHaveBeenCalledTimes(1);
  });

  it('B2-D3: tracked row is epoch-scoped — no wing corruption across an epoch change', () => {
    const { r, store } = makeRenderer();
    setEpochRows(store, 64);
    store.emit(makeColAt(0, 0, 3, 4, 64)); // epoch-0 book, inside quote rows 3/4
    expect(priv(r).trackedRowN).toBe(4);
    expect(priv(r).trackedEpoch).toBe(0);

    // The new epoch's first column arrives BEFORE its params are in the store:
    // remapPriceEpoch refuses to advance, and the tracked row must NOT be
    // recorded from a book whose affine is still unknown (the D3 incident).
    store.emit(makeColAt(1, 1, 30, 31, 64));
    expect(priv(r).priceEpoch).toBe(0); // no params → epoch not advanced
    expect(priv(r).trackedRowN).toBe(4); // still the old epoch's row
    expect(priv(r).trackedEpoch).toBe(0);

    // Params land. The stale row read through the new affine (p0 = −924) would
    // land at row 2052 of a 64-row grid — the exact wing-park. The fix drops
    // the invalid remap; this same column re-derives from the new book.
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(1, {
      epoch: 1,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: -924,
      rows: 64,
    });
    store.emit(makeColAt(2, 1, 40, 40, 64)); // same-row two-sided → 40.5
    expect(priv(r).priceEpoch).toBe(1);
    expect(priv(r).trackedRowN).toBe(40.5);
    expect(priv(r).trackedEpoch).toBe(1);
  });

  it('B2-D3: a remap with an unknown/mismatched trackedEpoch drops the row', () => {
    const { r, store } = makeRenderer();
    setEpochRows(store, 64);
    store.emit(makeColAt(0, 0, 3, 4, 64));
    expect(priv(r).trackedRowN).toBe(4);
    priv(r).trackedEpoch = null; // legacy state with no epoch provenance
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(1, {
      epoch: 1,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: 100,
      rows: 64,
    });
    (r as unknown as { remapPriceEpoch(epoch: number): void }).remapPriceEpoch(1);
    expect(priv(r).trackedRowN).toBeNull();
    expect(priv(r).trackedEpoch).toBeNull();
  });

  it('B2-D3: a remap that would clamp an interior row into a wing drops it instead', () => {
    const { r, store } = makeRenderer();
    setEpochRows(store, 64);
    store.emit(makeColAt(0, 0, 3, 4, 64));
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(1, {
      epoch: 1,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: -924,
      rows: 64,
    });
    (r as unknown as { remapPriceEpoch(epoch: number): void }).remapPriceEpoch(1);
    // The old code clamped row 2052 → 64 (an off-grid wing); the fix drops it.
    expect(priv(r).trackedRowN).toBeNull();
  });

  it('B2-D5: a col_seq regression rewinds the overlay cursors (same-subscription restart)', () => {
    const { r, store } = makeRenderer(512); // ring capacity 512
    for (let s = 0; s < 600; s++) store.emit(makeCol(s, true));
    expect(r.newestColSeq).toBe(599);
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;

    store.emit(makeCol(0, true)); // restarted col_seq: 0 + 512 < 599
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(inkSpy).toHaveBeenCalledTimes(1);
    expect(r.newestColSeq).toBe(0); // accepted as the new newest
  });

  it('B2-D5: a store sessionId change rewinds once, on the first column of the new session', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 5; s++) store.emit(makeCol(s, true));
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    (store.state as unknown as { sessionId: string }).sessionId = 'sess-2';
    store.emit(makeCol(6, true));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(r.newestColSeq).toBe(6);
    store.emit(makeCol(7, true));
    expect(resetSpy).toHaveBeenCalledTimes(1); // stable session → no further resets
  });

  it('B2-CP2: the piecewise t0 table reports real candle times for reconstructed history', () => {
    const { r, store } = makeRenderer();
    const candleNs = 60_000_000_000n;
    for (let s = 0; s < 4; s++) {
      store.emit(makeColAt(s, 0, 3, 4, ROWS, BigInt(s) * candleNs));
    }
    // The epoch says 25 ms/col; the table says 60 s/col (the S2/D1 time warp).
    expect(r.colToTsForTest(1)).toBe(candleNs);
    expect(r.colToTsForTest(3)).toBe(3n * candleNs);
    expect(r.colForTsForTest(2n * candleNs)).toBeCloseTo(2, 6);
    expect(r.colForTsForTest((3n * candleNs) / 2n)).toBeCloseTo(1.5, 6);
    const tm = (
      r as unknown as {
        overlayTimeMap(): { slots?: { startSeq: number; t0: Float64Array } } | null;
      }
    ).overlayTimeMap();
    expect(tm?.slots).toBeDefined();
    expect(tm!.slots!.startSeq).toBe(0);
    expect(tm!.slots!.t0[3]).toBe(180_000_000_000);
  });

  it('keeps actual timestamps across a wrapped resident run and caches the linear table', () => {
    const { r, store } = makeRenderer(512);
    const seam = 500;
    for (let s = 0; s < 520; s++) {
      const col = makeCol(s, true);
      col.t0_ns = BigInt(s) * BigInt(DT_NS) + (s >= seam ? 10_000_000_000n : 0n);
      store.emit(col);
    }
    const p = r as unknown as { overlaySlotsFor(): unknown };
    const table = p.overlaySlotsFor();
    expect(table).not.toBeNull();
    expect(p.overlaySlotsFor()).toBe(table);
    expect(r.timestampAtColumn(498)).toBe(498n * BigInt(DT_NS));
    expect(r.columnAtTimestamp(498n * BigInt(DT_NS))).toBe(498);
    expect(r.timestampAtColumn(501)).toBe(501n * BigInt(DT_NS) + 10_000_000_000n);
    const update = makeCol(519, false);
    update.t0_ns += 10_000_000_000n;
    store.emit(update);
    expect(p.overlaySlotsFor()).not.toBe(table);
  });

  it('R1-M1: a warm attach (first column mid-sequence) still serves the piecewise table', () => {
    const { r, store } = makeRenderer(1024);
    const candleNs = 60_000_000_000n;
    // The client attaches to an already-running grid: the first accepted column
    // is 502, so nothing ever writes slot 0.
    for (let s = 502; s < 566; s++) {
      store.emit(makeColAt(s, 0, 3, 4, ROWS, BigInt(s) * candleNs));
    }
    expect(r.colToTsForTest(510)).toBe(510n * candleNs);
    const tm = (
      priv(r) as unknown as {
        overlayTimeMap(): { slots?: { startSeq: number; t0: Float64Array } } | null;
      }
    ).overlayTimeMap();
    expect(tm?.slots, 'warm attach must serve the slot table').toBeDefined();
    expect(tm!.slots!.startSeq).toBe(502);
  });

  it('R1-M2: same-numbered session replacement forces a price-preserving remap', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 4; s++) store.emit(makeCol(s, true));
    priv(r).overlayPriceMap(); // populate lastPriceMapCache (as a draw would)
    expect(priv(r).lastPriceMapCache).not.toBeNull();

    const cam = priv(r).camera;
    const spy = vi.spyOn(cam, 'remapPrice');
    // New server session: SAME epoch number (0), DIFFERENT params under it.
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(0, {
      epoch: 0,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: 300,
      rows: ROWS,
    });
    (store.state as unknown as { sessionId: string }).sessionId = 'sess-2';
    r.resetOverlaysForNewSession('sess-2');
    store.emit(makeCol(0, true));

    expect(spy, 'the replacement must remap, not silently reinterpret').toHaveBeenCalledTimes(1);
    expect(priv(r).forcedRemapFrom).toBeNull();
    spy.mockRestore();
  });

  it('publishes one coherent camera view when price and time glide together', () => {
    const { r, store, canvas } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    const ep = (store.state.epochs as Map<number, { rows: number }>).get(0)!;
    ep.rows = 128;
    for (let seq = 0; seq < 400; seq++) store.emit(makeCol(seq, true, 128));
    r.setPriceFollow('track');
    (r as unknown as { controller: { zoomTimeAtFraction(f: number, x: number): void } })
      .controller.zoomTimeAtFraction(0.5, 1);
    r.setFollowTime(true);
    const internal = r as unknown as {
      camera: { setPriceFrame(bottom: number, span: number): void };
      trackedRowN: number | null;
      liveLag: number;
      glideWasFollowing: boolean;
      glideLastTs: number;
      priceStepTs: number;
    };
    internal.camera.setPriceFrame(30, 20);
    internal.trackedRowN = 80;
    internal.liveLag = 1;
    internal.glideWasFollowing = true;
    internal.glideLastTs = 100;
    internal.priceStepTs = 100;
    // Establish the eased view without starting the vertical glide.
    internal.trackedRowN = 40;
    pump(116);
    const before = r.viewSnapshot;
    internal.trackedRowN = 80;
    const views: typeof before[] = [];
    const off = r.onViewChanged(() => views.push(r.viewSnapshot));
    pump(132);
    expect(views).toHaveLength(1);
    expect(views[0].rowOffset).toBeGreaterThan(before.rowOffset);
    expect(views[0].colOffset - before.colOffset).toBeGreaterThan(0);
    expect(views[0].colOffset - before.colOffset).toBeLessThan(1);
    off();
  });

  it('retargets an in-flight price glide when the price reverses', () => {
    const { r, store, canvas } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    (store.state.epochs as Map<number, { rows: number }>).get(0)!.rows = 128;
    for (let seq = 0; seq < 400; seq++) store.emit(makeCol(seq, true, 128));
    r.setPriceFollow('track');
    const internal = r as unknown as {
      camera: { setPriceFrame(bottom: number, span: number): void };
      trackedRowN: number | null;
      priceStepTs: number;
    };
    internal.camera.setPriceFrame(30, 20);
    internal.trackedRowN = 80;
    internal.priceStepTs = 100;
    pump(116);
    const high = r.viewSnapshot.rowOffset;
    internal.trackedRowN = 20;
    pump(132);
    expect(r.viewSnapshot.rowOffset).toBeLessThan(high);
  });

  it('tracks the visible last price instead of an old book midpoint', () => {
    const { r, store, canvas } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    (store.state.epochs as Map<number, { rows: number }>).get(0)!.rows = 128;
    for (let seq = 0; seq < 400; seq++) store.emit(makeCol(seq, true, 128));
    r.setPriceFollow('track');
    const internal = r as unknown as {
      camera: { setPriceFrame(bottom: number, span: number): void };
      trackedRowN: number | null;
      priceStepTs: number;
    };
    internal.camera.setPriceFrame(30, 20);
    internal.trackedRowN = 80;
    internal.priceStepTs = 100;
    const bar = (price: number): void => store.emit({
      type: MsgType.BAR_COL, epoch: 0, col_seq: 399,
      t0_ns: 399n * BigInt(DT_NS), o: price, h: price, l: price, c: price,
      vol_buy: 0, vol_sell: 0, cvd_cum: 0, vwap_num_cum: 0, vwap_den_cum: 0,
    });
    // p0=100, tick=0.5: price 120 is row 40, safely in the frame.
    bar(120);
    pump(116);
    expect(r.viewSnapshot.rowOffset).toBe(30);
    // The book midpoint is now inside, but the actual price exits above.
    internal.trackedRowN = 40;
    bar(140);
    pump(132);
    expect(r.viewSnapshot.rowOffset).toBeGreaterThan(30);
  });

  it('holds both camera axes while the user inspects past-only history', () => {
    const { r, store, canvas } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    (store.state.epochs as Map<number, { rows: number }>).get(0)!.rows = 128;
    for (let seq = 0; seq < 400; seq++) store.emit(makeCol(seq, true, 128));
    r.setPriceFollow('track');
    r.setViewForTest(0, 100, 30, 20);
    r.setFollowTime(false);
    r.setPriceFollow('track');
    const internal = r as unknown as { trackedRowN: number | null };
    internal.trackedRowN = 80;
    pump(100);
    const before = r.viewSnapshot;
    store.emit(makeCol(400, true, 128));
    internal.trackedRowN = 90;
    pump(116);
    expect(r.viewSnapshot).toEqual(before);
    expect(r.priceFollow).toBe('track');
  });

  // --- eased live-edge scroll: bursts must absorb, never jump ------------------

  it('keeps scrolling through a late column every four seconds', () => {
    const { r, store, canvas } = makeRenderer();
    Object.defineProperty(canvas, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    (store.state.epochs as Map<number, { dt_ns: number }>).get(0)!.dt_ns = 250_000_000;
    for (let seq = 0; seq < 250; seq++) store.emit(makeCol(seq, true));
    let next = 1;
    let previous = 0;
    let holds = 0;
    for (let frame = 0; frame < 2400; frame++) {
      const elapsed = frame * 1000 / 60;
      while (elapsed >= next * 250 + (next % 16 === 0 ? 150 : 0)) {
        store.emit(makeCol(249 + next++, true));
      }
      pump(100 + elapsed);
      const x = r.viewSnapshot.colOffset;
      if (frame > 300 && x - previous < 0.00001) holds++;
      previous = x;
    }
    expect(holds, 'clock motion must not stop during ordinary 150ms arrival jitter').toBe(0);
  });

  it('advances the drawn view smoothly through bursty arrivals (no perde-perde jumps)', () => {
    const { r, store, canvas } = makeRenderer();
    // jsdom reports clientWidth 0, which degenerates the follow frame into
    // fill-the-whole-window mode; give the canvas a real viewport width so the
    // steady-state follow frame (right edge at newest+1) is exercised.
    Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    let ts = 0;
    let seq = 0;
    const stepFrame = (ms: number): number => {
      ts += ms;
      pump(ts);
      return r.viewSnapshot.colOffset;
    };
    // Warm up PAST the fill phase: the follow frame pins the right edge only
    // once the resident count exceeds the visible span (~800/4 ≈ 196 px).
    for (let i = 0; i < 1400; i++) {
      if (i % 4 === 0) store.emit(makeCol(seq++, true));
      stepFrame(16.7);
    }
    // Bursty real-feed pattern: 0,0,3,0,2,0,1 arrivals per 250 ms interval.
    let prev = r.viewSnapshot.colOffset;
    let maxJump = 0;
    let advanced = 0;
    const pattern = [0, 0, 3, 0, 2, 0, 1];
    for (let interval = 0; interval < 24; interval++) {
      const arrivals = pattern[interval % pattern.length];
      for (let k = 0; k < arrivals; k++) store.emit(makeCol(seq++, true));
      for (let f = 0; f < 15; f++) {
        const now = stepFrame(16.7);
        const jump = now - prev;
        if (jump > maxJump) maxJump = jump;
        if (jump > 0) advanced += jump;
        prev = now;
      }
    }
    // Steady state: the drawn view advances at the data rate with NO frame
    // jumping more than a fraction of a column (a clamped burst used to lurch
    // 2-3 columns at once — the "perde perde" regression).
    expect(maxJump).toBeLessThan(1);
    // And over the window it still advanced at the arrival rate (not stalled).
    expect(advanced).toBeGreaterThan(10);
  });

});
