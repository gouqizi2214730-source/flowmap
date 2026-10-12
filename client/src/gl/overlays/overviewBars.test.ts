import { afterEach, describe, expect, it, vi } from 'vitest';
import { MsgType, type BarColumn } from '../../proto/types';
import { makeFakeGL } from '../mockGL';
import * as axes from './axes';
import { OverlayManager, type OverlayDrawContext } from './manager';
import { OverviewBars } from './overviewBars';

function bar(col: number, close = 101, volume = 5): BarColumn {
  return {
    type: MsgType.BAR_COL, epoch: 0, col_seq: col, t0_ns: BigInt(col) * 6_400_000_000n,
    o: close - 1, h: close + 2, l: close - 2, c: close,
    vol_buy: volume, vol_sell: volume / 2,
    cvd_cum: col * 3, vwap_num_cum: close * 20, vwap_den_cum: 20,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('OverviewBars independent coarse overlay sources', () => {
  it('stores local group prices, volumes and cumulative values without averaging cumulants', () => {
    const overview = new OverviewBars();
    overview.add(bar(17));
    overview.add(bar(18, 103, 10));
    expect(overview.price.valueAt(17)).toBe(101);
    expect(overview.price.priceRange(17, 18)).toEqual({ low: 99, high: 105 });
    expect(overview.price.last()).toEqual({ col: 18, price: 103 });
    expect(overview.vwap.valueAt(18)).toBe(103);
    expect(overview.volume.valueAt(18)).toMatchObject({ col: 18, buy: 10, sell: 5, span: 1 });
    expect(overview.cvd.series(17, 18)).toEqual([{ col: 17, cvd: 51 }, { col: 18, cvd: 54 }]);
  });

  it('refreshes forming groups in place and handles out-of-order history', () => {
    const overview = new OverviewBars();
    overview.add(bar(20, 105));
    overview.add(bar(18, 101));
    overview.add(bar(19, 102));
    overview.add(bar(20, 106, 12));
    expect(overview.price.size).toBe(3);
    expect(overview.volume.size).toBe(3);
    expect(overview.price.last()).toEqual({ col: 20, price: 106 });
    expect(overview.volume.valueAt(20)?.buy).toBe(12);
    expect(overview.cvd.series(18, 20).map(p => p.col)).toEqual([18, 19, 20]);
  });

  it('bounds every coarse source with prune/reset', () => {
    const overview = new OverviewBars();
    for (let col = 0; col < 1000; col++) overview.add(bar(col));
    overview.prune(400, 655);
    for (const source of [overview.price, overview.vwap, overview.volume, overview.cvd]) expect(source.size).toBe(256);
    expect(Number.isNaN(overview.price.valueAt(0))).toBe(true);
    overview.reset();
    for (const source of [overview.price, overview.vwap, overview.volume, overview.cvd]) expect(source.size).toBe(0);
    expect(overview.price.last()).toBeNull();
  });

  it('draws coarse sources and the matching price pill, then restores raw sources', () => {
    const context = new Proxy({ measureText: () => ({ width: 20 }) }, {
      get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => undefined,
      set: (target, key, value) => { Reflect.set(target, key, value); return true; },
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const manager = new OverlayManager(makeFakeGL(), document.createElement('canvas'));
    manager.attachAxes(document.createElement('canvas'), document.createElement('canvas'));
    manager.setVisibility({ price: true, vwap: true, volume: true, axes: true });
    manager.onBar(bar(1, 102));
    const overview = new OverviewBars();
    overview.add(bar(1, 103));
    const coarsePrice = vi.spyOn(overview.price, 'draw').mockImplementation(() => undefined);
    const coarseVwap = vi.spyOn(overview.vwap, 'draw').mockImplementation(() => undefined);
    const coarseVolume = vi.spyOn(overview.volume, 'draw').mockImplementation(() => undefined);
    const axis = vi.spyOn(axes, 'drawPriceAxis').mockImplementation(() => undefined);
    const frame: OverlayDrawContext = {
      view: { colOffset: 0, colScale: 8, rowOffset: 0, rowScale: 8 },
      dims: { drawW: 640, drawH: 480, cssW: 640, cssH: 480 }, dpr: 1,
      resident: { oldest: 0, newest: 8 }, capability: null,
      time: { anchorSeq: 8, anchorT0Ns: 2_000_000_000n, dtNs: 250_000_000 },
      price: { p0: 100, step: 0.5 }, columnArrays: () => null, newestArrays: null,
      overviewBars: overview,
    };
    manager.draw(frame);
    expect(coarsePrice).toHaveBeenCalledOnce();
    expect(coarseVwap).toHaveBeenCalledOnce();
    expect(coarseVolume).toHaveBeenCalledOnce();
    expect(axis.mock.calls[0][2]).toEqual({ col: 1, price: 103 });
    manager.draw({ ...frame, overviewBars: null });
    expect(coarsePrice).toHaveBeenCalledOnce();
    expect(coarseVwap).toHaveBeenCalledOnce();
    expect(coarseVolume).toHaveBeenCalledOnce();
    expect(axis.mock.calls[1][2]).toEqual({ col: 1, price: 102 });
    expect(manager.lastPrice()).toBe(102);
    manager.dispose();
  });
});
