import type { HybridScale } from './priceScale';

/** A quiet market still needs enough depth levels to read its liquidity. */
export function priceOverviewBounds(scale: HybridScale, prices: { low: number; high: number }): { low: number; high: number } {
  const center = (prices.low + prices.high) / 2;
  const span = Math.max((prices.high - prices.low) * 1.4, Math.min(64, scale.coreRows) * scale.coreStep);
  return { low: Math.max(scale.loPrice, center - span / 2), high: Math.min(scale.hiPrice, center + span / 2) };
}
