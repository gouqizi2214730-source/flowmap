import { expect, it, vi } from 'vitest';
import { Profile } from './overlays/profile';
import { GridMap } from './overlays/coords';
import type { OverlayFrame } from './overlays/frame';
import { ViewportNormalizer } from './normalize';

it('wide overlay includes the oldest wall instead of trimming the view', async () => {
  const scale = { kind: 'linear' as const, rows: 2, p0: 100, step: 1 };
  const profile = new Profile({ maxCols: 8 });
  const changed = vi.fn();
  const gm = new GridMap({ colOffset: 0, colScale: 1400, rowOffset: 0, rowScale: 2 },
    { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 }, null, { p0: 100, step: 1, scale });
  const frame = { gm, resident: { oldest: 0, newest: 1399 }, dataVersion: 1, changed,
    columnArrays: (c: number) => ({ bid: Float32Array.from(c === 0 ? [2000, 0] : [0, 1]), ask: null }),
    columnScale: () => scale, solid: { begin() {}, addRect() {}, flush() {} }, text: { badge() {} },
  } as unknown as OverlayFrame;
  profile.draw(frame);
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 4000 });
  profile.draw(frame);
  expect(profile.last?.bins).toEqual(Float64Array.from([2000, 1399]));
  expect(profile.last?.sampled).toBe(false);
  profile.dispose();
});

it('budget fallback computes the visible CDF asynchronously and resets safely', async () => {
  const scale = { kind: 'linear' as const, rows: 2, p0: 100, step: 1 };
  const changed = vi.fn();
  const normalizer = new ViewportNormalizer({ maxSpatialBytes: 0, useWorker: true, onAsyncReady: changed,
    floor: 0, sourceColumn: () => ({ bid: Float32Array.from([1, 1e9]), ask: null, scale }) });
  normalizer.foldColumnFinal(0, Float32Array.from([1, 1e9]), null, scale);
  const view = { lo: 0, hi: 0, priceLo: 99.5, priceHi: 100.5 };
  normalizer.viewportPercentiles({ oldest: 0, newest: 0 }, view, 0);
  expect(normalizer.calculationState).toBe('pending');
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(normalizer.viewportPercentile({ oldest: 0, newest: 0 }, view, 0)).toBeLessThan(2);
  normalizer.reset();
  expect(normalizer.calculationState).toBe('idle');
  normalizer.dispose();
});
