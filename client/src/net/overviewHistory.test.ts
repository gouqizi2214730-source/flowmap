import { describe, expect, it, vi } from 'vitest';
import { OverviewHistory, overviewPlan, type OverviewHistoryDeps } from './overviewHistory';
import { MsgType, MODE_L2, type HistoryResponse } from '../proto/types';

function harness() {
  const columns: Array<{ seq: number; stride: number }> = [];
  const deps: OverviewHistoryDeps = {
    request: vi.fn<OverviewHistoryDeps['request']>(async (_before, n, request) => ({ type: MsgType.HISTORY_RESP, req_id: 1, epoch: 1, oldest_available_t_ns: 1n,
      depth_cols: Array.from({ length: n }, (_, i) => ({ type: MsgType.DEPTH_COL, epoch: 1,
        col_seq: request.start_col + i * request.stride, t0_ns: BigInt(request.start_col + i * request.stride) * 250000000n,
        mode: MODE_L2, final: true, bid: new Float32Array([i + 1, 0]), ask: new Float32Array([0, 2]) })),
      bar_cols: [], markers: [], big_trades: [],
    })),
    pageCols: () => 64, before: () => 10n ** 18n,
    reset: vi.fn(), column: (col, stride) => columns.push({ seq: col.col_seq, stride }),
    page: vi.fn(), changed: vi.fn(), yieldToFrame: vi.fn(async () => {}), active: () => true,
  };
  return { loader: new OverviewHistory(deps), deps, columns };
}

describe('independent historical level of detail', () => {
  it.each([0, 2])('bounds uploads by eight columns or six milliseconds at %ims per column', async (columnCost) => {
    const { loader, deps } = harness();
    let time = 0, batch = 0;
    const batches: Array<{ columns: number; duration: number }> = [];
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
    deps.pageCols = () => 32;
    deps.column = () => { batch++; time += columnCost; };
    deps.yieldToFrame = async () => { batches.push({ columns: batch, duration: batch * columnCost }); batch = 0; };
    try {
      loader.ensure({ colOffset: 0, colScale: 32, rowOffset: 0, rowScale: 10 }, 31, 0);
      await vi.waitFor(() => expect(loader.inFlight).toBe(false));
      expect(loader.complete).toBe(true);
      expect(batches.length).toBeGreaterThan(0);
      expect(batches.every(b => b.columns <= 8 && b.duration <= 6)).toBe(true);
      // Even cheap uploads yield at the hard cap. Expensive columns share a
      // six-millisecond slice before yielding, avoiding a display wait per pair.
      expect(batches[0].columns).toBe(columnCost === 0 ? 8 : 3);
    } finally { loader.dispose(); clock.mockRestore(); }
  });

  it('covers two days at 250 ms with bounded buckets instead of cutting the time range', () => {
    const plan = overviewPlan({ colOffset: 0, colScale: 691200 }, 691199)!;
    expect(plan).toEqual({ stride: 2048, lo: 0, hi: 337 });
    expect(plan.hi - plan.lo + 1).toBeLessThanOrEqual(481);
  });

  it('loads the full 54909-column real-world regression range in bounded output pages', async () => {
    const { loader, deps, columns } = harness();
    loader.ensure({ colOffset: 0, colScale: 54909, rowOffset: 0, rowScale: 10 }, 54908, 0);
    await vi.waitFor(() => expect(loader.inFlight).toBe(false));
    expect(loader.stride).toBe(128);
    expect(columns).toHaveLength(429);
    expect(columns[0].seq).toBe(0);
    expect(columns.at(-1)?.seq).toBe(54784);
    expect(loader.cachedBuckets).toBe(429);
    expect(deps.request).toHaveBeenCalledTimes(7);
    expect(deps.yieldToFrame).toHaveBeenCalled();
    loader.ensure({ colOffset: 0, colScale: 54909, rowOffset: 0, rowScale: 10 }, 54908, 500);
    expect(deps.request).toHaveBeenCalledTimes(7);
  });

  it('never lets a superseded zoom page corrupt the new level', async () => {
    const { loader, deps, columns } = harness();
    let complete!: (response: HistoryResponse) => void;
    const original = deps.request;
    deps.request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockImplementation(original);
    loader.ensure({ colOffset: 0, colScale: 4096, rowOffset: 0, rowScale: 10 }, 8000, 0);
    loader.ensure({ colOffset: 0, colScale: 8000, rowOffset: 0, rowScale: 10 }, 8000, 1);
    complete(await original(1n, 1, { start_col: 0, end_col: 15, stride: 16 }));
    await vi.waitFor(() => expect(loader.inFlight).toBe(false));
    expect(columns.every(c => c.stride === 32)).toBe(true);
    expect(deps.reset).toHaveBeenCalledTimes(2);
  });

  it('marks genuine absence covered instead of spinning requests on each frame', async () => {
    const { loader, deps } = harness();
    deps.request = vi.fn<OverviewHistoryDeps['request']>(async () => ({ type: MsgType.HISTORY_RESP, req_id: 1, epoch: 1,
      oldest_available_t_ns: 1n, depth_cols: [], bar_cols: [], markers: [], big_trades: [] }));
    const view = { colOffset: 0, colScale: 4096, rowOffset: 0, rowScale: 10 };
    loader.ensure(view, 8000, 0);
    await vi.waitFor(() => expect(loader.inFlight).toBe(false));
    for (let i = 1; i < 100; i++) loader.ensure(view, 8000, i * 16);
    expect(deps.request).toHaveBeenCalledTimes(4);
  });

  it('disposal excludes a late page after changing symbol', async () => {
    const { loader, deps, columns } = harness();
    let complete!: (response: HistoryResponse) => void;
    const original = deps.request;
    deps.request = vi.fn<OverviewHistoryDeps['request']>(() => new Promise(resolve => { complete = resolve; }));
    loader.ensure({ colOffset: 0, colScale: 4096, rowOffset: 0, rowScale: 10 }, 8000, 0);
    loader.dispose();
    complete(await original(1n, 1, { start_col: 0, end_col: 15, stride: 16 }));
    await vi.waitFor(() => expect(loader.inFlight).toBe(false));
    expect(columns).toEqual([]);
  });

  it('reloads evicted buckets when panning back at the same resolution', async () => {
    const { loader, deps } = harness();
    let oldest = -1, newest = -1;
    deps.resident = () => oldest < 0 ? null : { oldest, newest };
    deps.column = (c, stride) => {
      const col = c.col_seq / stride;
      if (oldest < 0 || col < oldest - 1) oldest = newest = col;
      else { oldest = Math.min(oldest, col); newest = Math.max(newest, col); oldest = Math.max(oldest, newest - 511); }
    };
    const view = (offset: number) => ({ colOffset: offset, colScale: 7400, rowOffset: 0, rowScale: 10 });
    for (const offset of [0, 7000, 0]) {
      loader.ensure(view(offset), 20000, offset === 0 ? 0 : 1);
      await vi.waitFor(() => expect(loader.inFlight).toBe(false));
      expect(loader.complete).toBe(true);
      const p = loader.range!;
      expect(oldest).toBeLessThanOrEqual(p.lo);
      expect(newest).toBeGreaterThanOrEqual(p.hi);
      expect(loader.cachedBuckets).toBeLessThanOrEqual(512);
    }
  });
});
