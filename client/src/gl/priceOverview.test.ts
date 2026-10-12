import { describe, expect, it } from 'vitest';
import { makeHybrid } from './priceScale';
import { priceOverviewBounds } from './priceOverview';

describe('readable price overview', () => {
  const scale = makeHybrid({ mid: 85500, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01 })!;
  it('shows a ladder around a quiet market instead of one oversized bin', () => {
    const bounds = priceOverviewBounds(scale, { low: 85500, high: 85500.01 });
    expect(bounds.high - bounds.low).toBeCloseTo(32);
    expect((bounds.high + bounds.low) / 2).toBeCloseTo(85500.005);
  });
  it('includes actual historical extremes with breathing room', () => {
    const bounds = priceOverviewBounds(scale, { low: 85400, high: 85600 });
    expect(bounds).toEqual({ low: 85360, high: 85640 });
  });
});
