import type { Marker } from '../proto/types';

export interface HistoryGap {
  leftCol: number; rightCol: number;
  leftStart: bigint; leftEnd: bigint; rightStart: bigint;
}
/** Optional source-clock metadata in the existing marker envelope. */
export function historyGap(marker: Marker): HistoryGap | null {
  if (marker.kind !== 'gap' || !marker.text.startsWith('history-gap:v1 ')) return null;
  try {
    const value = JSON.parse(marker.text.slice('history-gap:v1 '.length));
    if (!Number.isSafeInteger(value.left_col) || !Number.isSafeInteger(value.right_col) || value.left_col < 0 || value.right_col <= value.left_col) return null;
    if (![value.left_t0_ns, value.left_end_t_ns, value.right_t0_ns].every(v => typeof v === 'string' && /^\d{1,20}$/.test(v))) return null;
    const leftStart = BigInt(value.left_t0_ns), leftEnd = BigInt(value.left_end_t_ns), rightStart = BigInt(value.right_t0_ns);
    if (leftEnd < leftStart || rightStart <= leftEnd) return null;
    return { leftCol: value.left_col, rightCol: value.right_col, leftStart, leftEnd, rightStart };
  } catch { return null; }
}
export function displayHistoryGap(marker: Marker): Marker {
  const gap = historyGap(marker);
  return gap ? { ...marker, text: `GAP ${(Number(gap.rightStart - gap.leftEnd) / 1e9).toFixed(1)} s` } : marker;
}
