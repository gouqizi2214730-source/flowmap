import { describe, expect, it } from 'vitest';
import { PHYSICAL_NORM_FLOOR, ViewportNormalizer } from './normalize';
import { OverviewSurface } from './overviewSurface';
import { makeFakeGL } from './mockGL';

function singleRank(value: number): number {
  const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1 });
  norm.addColumn(0, Float32Array.of(value), null);
  return norm.updateNorm({ oldest: 0, newest: 0 }, { lo: 0, hi: 0 }, 0);
}

describe('physical viewport normalization and bounded indices', () => {
  it('excludes a huge offscreen row within the same 64-row histogram band', () => {
    const scale = { kind: 'linear' as const, rows: 4096, p0: 100, step: .01 };
    const bid = new Float32Array(4096); bid[100] = .01; bid[127] = 1e6;
    for (const resolved of [false, true]) {
      const norm = new ViewportNormalizer({ floor: PHYSICAL_NORM_FLOOR, emaAlpha: 1,
        sourceColumn: resolved ? col => col === 0 ? { bid, ask: null, scale } : null : undefined });
      norm.foldColumnFinal(0, bid, null, scale);
      const value = norm.updateNorm({ oldest: 0, newest: 0 }, { lo: 100, hi: 100, priceLo: 101, priceHi: 101 }, 0);
      expect(value).toBeGreaterThan(.009); expect(value).toBeLessThan(.012);
      expect(norm.updateNorm({ oldest: 0, newest: 0 }, { lo: 127, hi: 127, priceLo: 101.27, priceHi: 101.27 }, 0)).toBeGreaterThan(9e5);
    }
  });

  it('does not retain empty spatial maps as the same coarse bucket is revised', () => {
    const bid = new Float32Array(4096); bid.fill(1);
    const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1 });
    for (let i = 0; i < 256; i++) norm.replaceColumn(0, bid, null, { kind: 'linear', rows: 4096, p0: 59000 + i * .01, step: .01 });
    expect(norm.totalSamples).toBe(4096);
    expect(norm.retainedBytes).toBeLessThan(256 * 1024);
    norm.replaceColumn(0, new Float32Array(4096), null, { kind: 'linear', rows: 4096, p0: 59000, step: .01 });
    expect(norm.totalSamples).toBe(0); expect(norm.retainedBytes).toBeLessThan(4096);
  });

  it('holds a dense 512-column overview without per-column dense band histograms', () => {
    const bid = new Float32Array(4096); bid.fill(.01);
    const scale = { kind: 'linear' as const, rows: 4096, p0: 100, step: .01 };
    const norm = new ViewportNormalizer({ maxTiles: 3, floor: PHYSICAL_NORM_FLOOR });
    for (let c = 0; c < 512; c++) norm.replaceColumn(c, bid, null, scale);
    expect(norm.totalSamples).toBe(512 * 4096);
    expect(norm.retainedBytes).toBeLessThan(18 * 1024 * 1024);
  });

  it('uses exact resident data when its optional spatial index exceeds the byte budget', () => {
    const scale = { kind: 'linear' as const, rows: 256, p0: 100, step: 1 };
    const bid = new Float32Array(256); bid[10] = 2; bid[200] = 1e6;
    for (const resolved of [false, true]) {
      const norm = new ViewportNormalizer({ maxSpatialBytes: 3072, floor: 0, emaAlpha: 1,
        sourceColumn: resolved ? c => c === 0 ? { bid, ask: null, scale } : null : undefined });
      norm.foldColumnFinal(0, bid, null, scale);
      expect(norm.updateNorm({ oldest: 0, newest: 0 }, { lo: 10, hi: 10, priceLo: 110, priceHi: 110 }, 0)).toBeLessThan(2.5);
      expect(norm.totalSamples).toBe(2); expect(norm.retainedBytes).toBeLessThan(8192);
      norm.reset(); expect(norm.retainedBytes).toBe(0);
    }
  });

  it('keeps fractional base-unit density visible at the history resolution', () => {
    const gl = makeFakeGL(), ctx = { gl, caps: { maxTextureImageUnits: 16, maxArrayTextureLayers: 2048, maxTextureSize: 8192, colorBufferFloat: false } };
    const scale = { kind: 'linear' as const, rows: 128, p0: 100, step: .01 };
    const surface = new OverviewSurface(ctx, 128, {} as WebGLTexture, 4, scale);
    expect(surface.normalizer.floor).toBe(PHYSICAL_NORM_FLOOR);
    surface.dispose();
  });

  it('excludes forming columns from exact edge and budget-fallback ranks', () => {
    const scale = { kind: 'linear' as const, rows: 256, p0: 100, step: 1 };
    const final = new Float32Array(256), forming = new Float32Array(256);
    final[10] = 1; forming[10] = 1e6;
    for (const maxSpatialBytes of [0, 16 * 1024 * 1024]) {
      const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1, maxSpatialBytes,
        sourceColumn: col => col === 0 ? { bid: final, ask: null, scale } : col === 1 ? { bid: forming, ask: null, scale } : null });
      norm.foldColumnFinal(0, final, null, scale);
      expect(norm.totalSamples).toBe(1);
      expect(norm.updateNorm({ oldest: 0, newest: 1 }, { lo: 10, hi: 10, priceLo: 109.5, priceHi: 110.5 }, 0)).toBeCloseTo(singleRank(1), 12);
    }
  });

  it('does not count adjacent native cells which only touch the physical viewport', () => {
    const scale = { kind: 'linear' as const, rows: 256, p0: 100, step: 1 };
    const bid = new Float32Array(256); bid[100] = 1; bid[99] = bid[101] = 1e6;
    const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1 });
    norm.foldColumnFinal(0, bid, null, scale);
    expect(norm.updateNorm({ oldest: 0, newest: 0 }, { lo: 99.5, hi: 100.5, priceLo: 199.5, priceHi: 200.5 }, 0)).toBeCloseTo(singleRank(1), 12);
  });

  it('reads each admitted native map once per edge, rather than once per map times every column', () => {
    const sources = new Map<number, { bid: Float32Array; ask: null; scale: { kind: 'linear'; p0: number; rows: number; step: number } }>();
    let reads = 0;
    const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1, sourceColumn: col => { reads++; return sources.get(col) ?? null; } });
    for (let c = 0; c < 256; c++) {
      const bid = new Float32Array(256); bid[1] = 1;
      const scale = { kind: 'linear' as const, p0: 1000 + c * .01, rows: 256, step: .01 };
      sources.set(c, { bid, ask: null, scale }); norm.foldColumnFinal(c, bid, null, scale);
    }
    norm.updateNorm({ oldest: 0, newest: 255 }, { lo: 0, hi: 3, priceLo: 1000, priceHi: 1004 }, 0);
    expect(reads).toBeLessThanOrEqual(512);
  });

  it('excludes offscreen time columns within both full and partial price bands', () => {
    const scale = { kind: 'linear' as const, rows: 256, p0: 100, step: 1 };
    const visible = new Float32Array(256), outside = new Float32Array(256);
    visible[100] = 1; outside[100] = 1e6;
    for (const resolved of [false, true]) {
      const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1, sourceColumn: resolved ? c => c === 0 ? { bid: visible, ask: null, scale }
        : c === 255 ? { bid: outside, ask: null, scale } : null : undefined });
      norm.foldColumnFinal(0, visible, null, scale); norm.foldColumnFinal(255, outside, null, scale);
      for (const bounds of [{ lo: 99.5, hi: 100.5, priceLo: 199.5, priceHi: 200.5 }, { lo: 63.5, hi: 127.5, priceLo: 163.5, priceHi: 227.5 }]) {
        expect(norm.updateNorm({ oldest: 0, newest: 0 }, bounds, 0)).toBeCloseTo(singleRank(1), 12);
      }
    }
  });
});
