import { describe, expect, it } from 'vitest';
import { OverviewSurface } from './overviewSurface';
import { makeFakeGL } from './mockGL';
import { slotColToTsNs, slotTsToCol } from './overlays/coords';
import { MODE_L2, MsgType } from '../proto/types';

function surface(stride = 16) {
  const gl = makeFakeGL();
  return new OverviewSurface({ gl, caps: { maxTextureImageUnits: 16, maxArrayTextureLayers: 2048, maxTextureSize: 8192, colorBufferFloat: false } }, 16, {} as WebGLTexture, stride);
}
function add(s: OverviewSurface, group: number, time: bigint) {
  const bid = new Float32Array(16); bid[4] = 10;
  s.column({ type: MsgType.DEPTH_COL, epoch: 1, col_seq: group * s.stride, t0_ns: time, mode: MODE_L2, final: true, bid, ask: new Float32Array(16) });
}
describe('coarse history surface', () => {
  it('inherits both normalization ranks from the active heatmap on every draw', () => {
    const main = surface();
    const overview = surface();
    main.normalizer.percentile = 77.3;
    main.normalizer.whitePercentile = 80;
    overview.draw({ colOffset: 0, colScale: 16, rowOffset: 0, rowScale: 16 }, main.heatmap);
    expect(overview.normalizer.percentile).toBe(77.3);
    expect(overview.normalizer.whitePercentile).toBe(80);
    main.normalizer.percentile = 97.3;
    main.normalizer.whitePercentile = 100;
    overview.draw({ colOffset: 0, colScale: 16, rowOffset: 0, rowScale: 16 }, main.heatmap);
    expect(overview.normalizer.percentile).toBe(97.3);
    expect(overview.normalizer.whitePercentile).toBe(100);
    overview.dispose();
    main.dispose();
  });
  it('keeps genuine depth on both sides of a missing time bucket and exposes every real clock knot', () => {
    const s = surface();
    for (const [col, time] of [[0, 1000], [1, 2000], [3, 9000], [4, 12000]]) add(s, col, BigInt(time));
    expect(s.ring.validFromSeq()).toBe(0);
    expect(s.ring.residentRange()).toEqual({ oldest: 0, newest: 4, count: 5 });
    expect(s.cache.arrays(0)).not.toBeNull();
    expect(s.cache.arrays(2)).toBeNull();
    const local = s.timeMap(1)!;
    expect(Array.from(local.slots!.cols!)).toEqual([0, 1, 3, 4]);
    expect(slotColToTsNs(local.slots!, 3)).toBe(9000n);
    expect(slotTsToCol(local.slots!, 9000n)).toBe(3);
    const original = s.originalTimeMap(1)!;
    expect(Array.from(original.slots!.cols!)).toEqual([0, 16, 48, 64]);
    expect(slotColToTsNs(original.slots!, 48)).toBe(9000n);
    expect(s.originalTimeMap(1)).toBe(original);
    s.dispose();
  });

  it('never claims cache data outside the fixed 512-column GPU window', () => {
    const s = surface();
    for (let col = 0; col < 800; col++) add(s, col, BigInt(col + 1));
    expect(s.ring.residentRange()).toEqual({ oldest: 288, newest: 799, count: 512 });
    expect(s.timeMap(1)!.slots!.t0.length).toBe(512);
    expect(s.cache.arrays(0)).toBeNull();
    s.dispose();
  });

  it('preserves both real clocks of a restart inside one averaged time bin', () => {
    const s = surface(4);
    add(s, 0, 0n);
    s.page({ type: MsgType.HISTORY_RESP, req_id: 1, epoch: 1, oldest_available_t_ns: 0n,
      depth_cols: [], bar_cols: [], big_trades: [], markers: [{ type: MsgType.MARKER, kind: 'gap', ts_ns: 120000000000n, price: null, size: null,
        text: 'history-gap:v1 ' + JSON.stringify({ left_col: 1, right_col: 2, left_t0_ns: '250000000', left_end_t_ns: '500000000', right_t0_ns: '120000000000' }) }] });
    const original = s.originalTimeMap(250000000)!;
    expect(slotColToTsNs(original.slots!, 1)).toBe(250000000n);
    expect(slotColToTsNs(original.slots!, 2)).toBe(120000000000n);
    expect(slotTsToCol(original.slots!, 120000000000n)).toBe(2);
    s.dispose();
  });
});
