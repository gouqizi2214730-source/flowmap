import { describe, expect, it } from 'vitest';
import { ColumnGeometry } from './columnGeometry';
import { makeFakeGL } from './mockGL';
import { depthResolution, DEPTH_RESOLUTION_PREFIX } from '../net/depthResolution';
import { MsgType, type Marker } from '../proto/types';

describe('exact source resolution atlas', () => {
  it('sorts and splits overlapping widths while preserving real holes', () => {
    const gl = makeFakeGL(), geometry = new ColumnGeometry(gl, 4, 2);
    geometry.setResolution(0, { kind: 'linear', p0: 100, step: 1, rows: 64 },
      [[110, 112, 4], [101, 105, 2], [103, 107, 5], [102, 104, 3]]);
    geometry.flushResolution();
    const data = gl.callsOf('texSubImage2D').at(-1)!.args.at(-1) as Float32Array;
    expect(data[1]).toBe(4);
    expect(Array.from(data.slice(data[0] * 4, (data[0] + data[1]) * 4))).toEqual([
      1, 2, 2, 1, 2, 3, 3, 1, 3, 7, 5, 1, 10, 12, 4, 1,
    ]);
  });
  it('retains twelve disjoint ranges without inventing uncertainty in the holes', () => {
    const ranges = Array.from({ length: 12 }, (_, i) => [100 + i * 2, 101 + i * 2, 3] as const);
    const marker: Marker = { type: MsgType.MARKER, ts_ns: 1n, kind: 'info',
      text: DEPTH_RESOLUTION_PREFIX + JSON.stringify({ col_seq: 0, ranges }), price: null, size: null };
    expect(depthResolution([marker]).get(0)).toEqual(ranges);
    const gl = makeFakeGL(), geometry = new ColumnGeometry(gl, 4, 2);
    geometry.setResolution(0, { kind: 'linear', p0: 100, step: 1, rows: 64 }, ranges);
    geometry.flushResolution();
    const data = gl.callsOf('texSubImage2D').at(-1)!.args.at(-1) as Float32Array;
    expect(data[1]).toBe(12); // atlas header count; no eight-range cap
    const at = data[0] * 4;
    expect(Array.from(data.slice(at + 11 * 4, at + 12 * 4))).toEqual([22, 23, 3, 1]);
    geometry.setResolution(8, { kind: 'linear', p0: 100, step: 1, rows: 64 });
    geometry.flushResolution();
    const cleared = gl.callsOf('texSubImage2D').at(-1)!.args.at(-1) as Float32Array;
    expect(cleared[1]).toBe(0);
  });
});
