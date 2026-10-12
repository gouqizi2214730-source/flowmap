import type { HeatmapView } from './heatmap';
import { priceToRow, rowToPrice, type PriceScale } from './priceScale';

/** Storage rows are nonuniform. Screen distance must represent price distance,
 *  independently of which storage segment happens to contain a trade. */
export function rowFraction(view: HeatmapView, scale: PriceScale | null, row: number): number {
  if (scale?.kind !== 'hybrid') return (row - view.rowOffset) / view.rowScale;
  const low = rowToPrice(scale, view.rowOffset);
  const span = rowToPrice(scale, view.rowOffset + view.rowScale) - low;
  return (rowToPrice(scale, row) - low) / span;
}

export function fractionRow(view: HeatmapView, scale: PriceScale | null, fraction: number): number {
  if (scale?.kind !== 'hybrid') return view.rowOffset + view.rowScale * fraction;
  const low = rowToPrice(scale, view.rowOffset);
  const span = rowToPrice(scale, view.rowOffset + view.rowScale) - low;
  return priceToRow(scale, Math.max(Number.MIN_VALUE, low + span * fraction));
}

/** Maximum local storage footprint. Used for diagnostics/normalization; the
 *  shader selects its actual footprint separately for each price segment. */
export function projectedRowsPerPixel(view: HeatmapView, scale: PriceScale | null, height: number): number {
  if (scale?.kind !== 'hybrid') return view.rowScale / Math.max(1, height);
  const low = rowToPrice(scale, view.rowOffset);
  const high = rowToPrice(scale, view.rowOffset + view.rowScale);
  return (high - low) / scale.coreStep / Math.max(1, height);
}
