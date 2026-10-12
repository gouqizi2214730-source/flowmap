import { expect, it } from 'vitest';
import { ViewWorkerEngine } from './viewWorkerEngine';

it('accumulates all 1400 profile columns, preserving an old dominant price level', () => {
  const engine = new ViewWorkerEngine({ kind: 'profile', rowLo: 0, rowHi: 1,
    target: { kind: 'linear', p0: 10, step: 1, rows: 2 }, normalizeWidths: false });
  for (let col = 0; col < 1400; col++) engine.add({ bid: new Float32Array(col === 0 ? [2000, 0] : [0, 1]), ask: null,
    scale: { kind: 'linear', p0: 10, step: 1, rows: 2 } });
  const result = engine.finish();
  expect(Array.from(result.bins)).toEqual([2000, 1399]);
  expect(result.columns).toBe(1400);
});

it('histogram worker excludes offscreen rows and applies the physical density unit', () => {
  const engine = new ViewWorkerEngine({ kind: 'histogram', rowLo: 0, rowHi: 2,
    priceLo: 99.5, priceHi: 100.5, referenceStep: 1,
    channel: 0, bins: 256, histMin: 1e-8, histMax: 1e15 });
  engine.add({ bid: new Float32Array([2, 1e9, 0]), ask: new Float32Array([3, 0, 0]),
    scale: { kind: 'linear', p0: 100, step: 1, rows: 3 } });
  const result = engine.finish();
  expect(result.total).toBe(1);
  expect(Array.from(result.bins).reduce((a, b) => a + b, 0)).toBe(1);
});
