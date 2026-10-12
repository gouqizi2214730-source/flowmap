import { describe, expect, it } from 'vitest';
import { OverviewSurface } from './overviewSurface';
import { makeFakeGL } from './mockGL';
import { OverviewBars } from './overlays/overviewBars';
import { scatterVolumes } from './overlays/volbars';
import { MODE_L2, MsgType, type BarColumn } from '../proto/types';

function bar(col: number, buy: number): BarColumn {
  return { type: MsgType.BAR_COL, epoch: 0, col_seq: col, t0_ns: BigInt(col),
    o: 100, h: 100, l: 100, c: 100, vol_buy: buy, vol_sell: 0,
    cvd_cum: buy, vwap_num_cum: 100 * buy, vwap_den_cum: buy };
}

describe('deep chart audit regressions', () => {
  it('updates normalization when an overview bucket is refreshed under its stable id', () => {
    const gl = makeFakeGL();
    const surface = new OverviewSurface({ gl, caps: { maxTextureImageUnits: 16,
      maxArrayTextureLayers: 2048, maxTextureSize: 8192, colorBufferFloat: false } },
      16, {} as WebGLTexture, 16);
    const append = (quantity: number) => {
      const bid = new Float32Array(16); bid[4] = quantity;
      surface.column({ type: MsgType.DEPTH_COL, epoch: 0, col_seq: 0,
        t0_ns: 0n, mode: MODE_L2, final: true, bid, ask: new Float32Array(16) });
    };
    append(10);
    const before = surface.normalizer.viewportPercentiles({ oldest: 0, newest: 0 }, { lo: 0, hi: 15 }, 0).white;
    append(10000);
    const after = surface.normalizer.viewportPercentiles({ oldest: 0, newest: 0 }, { lo: 0, hi: 15 }, 0).white;
    expect(surface.cache.arrays(0)!.bid[4]).toBe(10000);
    surface.dispose();
    expect(after / before).toBeGreaterThan(500);
  });

  it('keeps aggregated overview traded volume out of omitted groups', () => {
    const bars = new OverviewBars();
    bars.add(bar(0, 100));
    bars.add(bar(2, 200));
    const buy = new Float64Array(3); const sell = new Float64Array(3);
    scatterVolumes([bars.volume.valueAt(0)!, bars.volume.valueAt(2)!], 0, 2, buy, sell);
    expect(Array.from(buy)).toEqual([100, 0, 200]);
  });
});
