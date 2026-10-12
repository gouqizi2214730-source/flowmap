import type { Marker } from '../proto/types';

/** Internal history metadata: physical source resolution survived aggregation. */
export const DEPTH_RESOLUTION_PREFIX = 'flowmap.depth-resolution.v1 ';
export type DepthResolutionRange = readonly [low: number, high: number, width: number];

export function isDepthResolution(marker: Marker): boolean {
  return marker.kind === 'info' && marker.text.startsWith(DEPTH_RESOLUTION_PREFIX);
}

export function depthResolution(markers: readonly Marker[]): Map<number, readonly DepthResolutionRange[]> {
  const result = new Map<number, readonly DepthResolutionRange[]>();
  for (const marker of markers) {
    if (!isDepthResolution(marker)) continue;
    try {
      const value = JSON.parse(marker.text.slice(DEPTH_RESOLUTION_PREFIX.length));
      if (!Number.isSafeInteger(value.col_seq) || value.col_seq < 0 || !Array.isArray(value.ranges)) continue;
      const ranges: DepthResolutionRange[] = [];
      for (const range of value.ranges) {
        if (!Array.isArray(range) || range.length !== 3 || !range.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) continue;
        if (range[0] < 0 || !(range[1] > range[0]) || !(range[2] > 0)) continue;
        ranges.push([range[0], range[1], range[2]]);
      }
      result.set(value.col_seq, ranges);
    } catch { /* An invalid metadata record cannot take down history loading. */ }
  }
  return result;
}
