import { describe, expect, it } from 'vitest';
import { depthResolution, isDepthResolution, DEPTH_RESOLUTION_PREFIX } from './depthResolution';
import { MsgType, type Marker } from '../proto/types';

const marker = (payload: unknown): Marker => ({ type: MsgType.MARKER, kind: 'info', ts_ns: 1n,
  price: null, size: null, text: DEPTH_RESOLUTION_PREFIX + JSON.stringify(payload) });

describe('coarse recorded price resolution', () => {
  it('retains exact physical intervals and hides only reserved info markers', () => {
    const item = marker({ col_seq: 512, ranges: [[81703.6267, 81983.05885, 279.43215]] });
    expect(depthResolution([item]).get(512)).toEqual([[81703.6267, 81983.05885, 279.43215]]);
    expect(isDepthResolution(item)).toBe(true);
    expect(isDepthResolution({ ...item, kind: 'gap' })).toBe(false);
  });
  it('rejects malformed and invalid metadata while accepting more than eight intervals', () => {
    expect(depthResolution([{ ...marker({}), text: DEPTH_RESOLUTION_PREFIX + '{' },
      marker({ col_seq: -1, ranges: [[1, 2, 1]] })]).size).toBe(0);
    expect(depthResolution([marker({ col_seq: 0, ranges: Array(9).fill([1, 2, 1]) })]).get(0)).toHaveLength(9);
    expect(depthResolution([marker({ col_seq: 2, ranges: [[2, 1, 1], [1, 2, -1], [1, 2, 1]] })]).get(2)).toEqual([[1, 2, 1]]);
  });
});
