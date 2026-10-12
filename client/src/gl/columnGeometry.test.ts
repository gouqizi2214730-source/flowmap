import { describe, expect, it } from 'vitest';
import { ColumnGeometry, densityForScale } from './columnGeometry';
import { makeHybrid, priceToRow, rowToPrice } from './priceScale';
import { makeFakeGL } from './mockGL';
import { ViewportNormalizer } from './normalize';

describe('recorded depth physical density', () => {
  it('conserves quantity and does not make a 278-dollar bucket a fine wall', () => {
    const scale = makeHybrid({ mid: 82916, rows: 4096, coreRows: 2048, coreStep: .5, upMult: 11, dnFloor: .01 })!;
    const source = new Float32Array(4096);
    const wing = Math.round(priceToRow(scale, 81812));
    const core = Math.round(priceToRow(scale, 82916));
    source[wing] = 200; source[core] = 7;
    const density = densityForScale(scale, source, new Float32Array(4096));
    expect(density[wing]).toBeLessThan(1);
    expect(density[core]).toBe(7);
    let mass = 0;
    for (let r = 0; r < density.length; r++) mass += density[r] * (rowToPrice(scale, r + .5) - rowToPrice(scale, r - .5)) / scale.coreStep;
    expect(mass).toBeCloseTo(207, 4);
  });

  it('normalizes the visible physical price region across native epochs and channels', () => {
    const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1 });
    const scale = { kind: 'linear' as const, p0: 81000, step: .5, rows: 4096 };
    const next = { ...scale, p0: 82000 };
    const bid = new Float32Array(4096), ask = new Float32Array(4096);
    bid[100] = 2; ask[100] = 3; bid[3000] = 1e6;
    norm.foldColumnFinal(0, bid, ask, scale);
    const other = new Float32Array(4096); other[100] = 1e7;
    norm.foldColumnFinal(1, other, null, next);
    const cols = { oldest: 0, newest: 1 }, visible = { lo: 0, hi: 4095, priceLo: 81040, priceHi: 81060 };
    expect(norm.updateNorm(cols, visible, 0)).toBeGreaterThan(4);
    expect(norm.current).toBeLessThan(6);
    norm.channel = 1;
    expect(norm.updateNorm(cols, visible, 0)).toBeLessThan(2.5);
    norm.channel = 2;
    expect(norm.updateNorm(cols, visible, 0)).toBeGreaterThan(2.5);
    expect(norm.current).toBeLessThan(3.5);
    norm.channel = 0;
    expect(norm.updateNorm(cols, { ...visible, priceLo: 82480, priceHi: 82520 }, 0)).toBeGreaterThan(1e5);
  });

  it('keeps column metadata bounded to native ring slots and flushes only changes', () => {
    const gl = makeFakeGL();
    const geometry = new ColumnGeometry(gl, 256, 2);
    const scale = { kind: 'linear' as const, p0: 81000, step: .5, rows: 4096 };
    geometry.set(0, scale, 1); geometry.set(512, { ...scale, p0: 82000 }, 2);
    geometry.flush();
    const uploads = gl.callsOf('texSubImage2D');
    expect(uploads).toHaveLength(1);
    geometry.flush();
    expect(gl.callsOf('texSubImage2D')).toHaveLength(1);
    geometry.dispose();
  });

  it('replaces a revised overview bucket without stale ranks or duplicate samples', () => {
    const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1 });
    const scale = { kind: 'linear' as const, p0: 100, step: .5, rows: 128 };
    const first = new Float32Array(128); first[20] = 2;
    const next = new Float32Array(128); next[20] = 200;
    const col = { oldest: 0, newest: 0 }, row = { lo: 0, hi: 127, priceLo: 100, priceHi: 150 };
    norm.replaceColumn(0, first, null, scale);
    expect(norm.updateNorm(col, row, 0)).toBeLessThan(3);
    for (let i = 0; i < 10; i++) norm.replaceColumn(0, next, null, scale);
    expect(norm.totalSamples).toBe(1);
    expect(norm.updateNorm(col, row, 0)).toBeGreaterThan(180);
    norm.replaceColumn(0, new Float32Array(128), null, scale);
    expect(norm.totalSamples).toBe(0);
  });

  it('preserves relative sub-cent provenance and clears revised slots without native allocation', () => {
    const gl = makeFakeGL(), geometry = new ColumnGeometry(gl, 256, 2);
    const scale = { kind: 'linear' as const, p0: 59000.01, step: .01, rows: 4096 };
    geometry.setResolution(0, scale); geometry.flushResolution();
    expect(gl.callsOf('texSubImage2D')).toHaveLength(0);
    geometry.setResolution(0, scale, [[59000.015, 59000.025, .01]]); geometry.flushResolution();
    const data = gl.callsOf('texSubImage2D')[0].args.at(-1) as Float32Array;
    const at = data[0] * 4;
    expect(data[at]).toBeCloseTo(.005, 7); expect(data[at + 1]).toBeCloseTo(.015, 7);
    geometry.setResolution(512, scale); geometry.flushResolution();
    expect(data[0]).toBe(0); expect(data[1]).toBe(0);
    geometry.dispose();
  });

  it('invalidates mip groups whose intermediate core moves and returns to the same endpoints', () => {
    const gl = makeFakeGL(), geometry = new ColumnGeometry(gl, 256, 2);
    const scale = { kind: 'linear' as const, p0: 59000, step: .01, rows: 4096 };
    for (let c = 0; c < 16; c++) geometry.set(c, scale, c);
    geometry.flush();
    const data = gl.callsOf('texSubImage2D')[0].args.at(-1) as Float32Array;
    const flags = (col: number) => data[256 * 4 + col * 4 + 2];
    expect(flags(0)).toBe(3); expect(flags(15)).toBe(3);
    geometry.set(1, { ...scale, p0: 59000.01 }, 100);
    expect(flags(0)).toBe(0); expect(flags(3)).toBe(0);
    expect(flags(4)).toBe(1); expect(flags(15)).toBe(1);
    geometry.set(1, scale, 101);
    expect(flags(0)).toBe(3); expect(flags(15)).toBe(3);
    geometry.dispose();
  });
});
