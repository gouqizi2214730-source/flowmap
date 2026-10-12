import { describe, expect, it } from 'vitest';
import recorded from './fixtures/recordedDepthDistributions.json';
import {
  percentileForTolerance,
  TOLERANCE_MAX_NORMALIZED_FLOOR,
  ViewportNormalizer,
} from './normalize';

const columns = { oldest: 0, newest: 0 };
const rows = { lo: 0, hi: 8191 };

/** Recreate equal-rank samples from compact real recorded depth histograms. */
function samples(bins: number[][], scale = 1): Float32Array {
  const count = bins.reduce((sum, bin) => sum + bin[1], 0);
  let index = 0;
  let through = bins[0][1];
  return Float32Array.from({ length: 8192 }, (_, rank) => {
    const target = ((rank + 0.5) / 8192) * count;
    while (through < target && index + 1 < bins.length) through += bins[++index][1];
    return bins[index][0] * scale;
  });
}

function calibrated(data: Float32Array, level = 0): ViewportNormalizer {
  const normalizer = new ViewportNormalizer({ emaAlpha: 1 });
  normalizer.addColumn(0, data, null);
  normalizer.updateNorm(columns, rows, level);
  return normalizer;
}

function surviving(data: Float32Array, normalizer: ViewportNormalizer, tolerance: number): number {
  const cut = normalizer.floorForTolerance(tolerance) * normalizer.current;
  return data.filter((value) => value > cut).length / data.length;
}

describe('density-relative tolerance calibration', () => {
  it('uses a useful positive-density rank across the whole slider', () => {
    expect([0, 1, 25, 50, 75, 100].map(percentileForTolerance)).toEqual([0, 1, 25, 50, 70, 90]);
    expect(percentileForTolerance(-1)).toBe(0);
    expect(percentileForTolerance(200)).toBe(90);
    expect(percentileForTolerance(Number.NaN)).toBe(0);
  });

  for (const symbol of ['BTCUSDT', 'RUNEUSDT'] as const) {
    it(`${symbol}: middle slider removes weaker noise while walls remain at high tolerance`, () => {
      const data = samples(recorded[symbol].bins);
      const n = calibrated(data);
      const fractions = [0, 1, 25, 50, 75, 100].map((value) => surviving(data, n, value));
      expect(fractions[0]).toBe(1);
      expect(fractions[1]).toBeGreaterThan(0.98);
      expect(fractions[3]).toBeGreaterThan(0.45);
      expect(fractions[3]).toBeLessThan(0.8);
      expect(fractions[5]).toBeGreaterThan(0.08);
      expect(fractions[5]).toBeLessThan(0.25);
      for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeLessThanOrEqual(fractions[i - 1]);
      const strongest = Math.max(...data);
      expect(n.floorForTolerance(100) * n.current).toBeLessThan(strongest * 0.5);
    });

    it(`${symbol}: base-unit changes and SUM levels preserve the filtering fraction`, () => {
      const base = samples(recorded[symbol].bins);
      const baseline = surviving(base, calibrated(base), 50);
      // Stay inside the documented 1e-8..1e15 histogram domain. A thousandfold
      // smaller BTC lot plus a millionfold larger base-unit book covers coins
      // of very different prices without testing histogram underflow instead.
      for (const scale of [1e-3, 1, 1e6]) {
        const data = samples(recorded[symbol].bins, scale);
        for (const level of [0, 1, 2]) {
          expect(surviving(data, calibrated(data, level), 50)).toBeCloseTo(baseline, 1);
        }
      }
    });
  }

  it('retains equal-density levels after physical-width sampling', () => {
    for (const quantity of [1e-6, 0.001, 1, 30, 65_000, 1e9]) {
      const n = calibrated(new Float32Array(4096).fill(quantity));
      for (const tolerance of [1, 50, 100]) {
        const floor = n.floorForTolerance(tolerance);
        expect(floor).toBeLessThanOrEqual(TOLERANCE_MAX_NORMALIZED_FLOOR);
        expect(Math.min(1, quantity / n.current)).toBeGreaterThan(floor);
      }
    }
  });

  it('handles one-bin distributions without cutting ties, including coarse histograms', () => {
    const n = new ViewportNormalizer({ bins: 64, emaAlpha: 1 });
    n.addColumn(0, new Float32Array(16).fill(0.01), null);
    n.updateNorm(columns, rows, 0);
    expect(n.floorForTolerance(100) * n.current).toBeLessThan(0.01);
  });

  it('reads the cached visible CDF without another merge and stops filtering an empty view', () => {
    const n = calibrated(samples(recorded.BTCUSDT.bins));
    const merges = n.mergeCount;
    for (let i = 0; i < 60; i++) expect(n.floorForTolerance(50)).toBeGreaterThan(0);
    expect(n.mergeCount).toBe(merges);
    n.updateNorm({ oldest: 1024, newest: 1025 }, rows, 0);
    expect(n.floorForTolerance(100)).toBe(0);
    n.reset();
    expect(n.floorForTolerance(100)).toBe(0);
    n.seed(1e9);
    expect(n.floorForTolerance(100)).toBe(0);
  });
});
