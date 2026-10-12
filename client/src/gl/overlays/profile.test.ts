import { describe, expect, it, vi } from 'vitest';
import { GridMap } from './coords';
import type { OverlayFrame } from './frame';
import { accumulateProfile, Profile } from './profile';
import { makeHybrid, priceToRow, rowToPrice, type PriceScale } from '../priceScale';

describe('profile physical price intervals', () => {
  it('a missing last column does not erase the full cached profile window', async () => {
    const scale: PriceScale = { kind: 'linear', rows: 8, p0: 0, step: 1 };
    const bid = new Float32Array(8); bid[3] = 9;
    const gm = new GridMap({ colOffset: 0, colScale: 3, rowOffset: 0, rowScale: 8 },
      { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 }, null, { p0: 0, step: 1, scale });
    const badge = vi.fn();
    const profile = new Profile({ maxCols: 2 });
    const frame = { gm, resident: { oldest: 0, newest: 2 },
      columnArrays: (col: number) => col === 2 ? null : { bid, ask: null },
      solid: { begin: () => {}, addRect: () => {}, flush: () => {} }, text: { badge },
    } as unknown as OverlayFrame;
    profile.draw(frame);
    await vi.waitFor(() => { profile.draw(frame); expect(profile.last?.max).toBe(18); });
    expect(profile.last?.sampled).toBe(true);
    expect(badge.mock.calls.at(-1)![2]).toBe('≈POC 3');
    profile.dispose();
  });
  it('retains visible wing buckets and centers their bar and POC despite a coarse frame mip', () => {
    const scale = makeHybrid({ mid: 82414.24, rows: 4096, coreRows: 2048, coreStep: .01, upMult: 11, dnFloor: .01 })!;
    const row = Math.floor(priceToRow(scale, 81812)) + 1;
    const bid = new Float32Array(scale.rows); bid[row] = 7;
    const bottom = priceToRow(scale, 81750), top = priceToRow(scale, 81950);
    const gm = new GridMap({ colOffset: 0, colScale: 1, rowOffset: bottom, rowScale: top - bottom },
      { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 }, null,
      { p0: scale.coreP0, step: scale.coreStep, scale });
    const rect = vi.fn(), badge = vi.fn();
    const profile = new Profile();
    profile.draw({ gm, resident: { oldest: 0, newest: 0 }, mipLevel: 2,
      columnArrays: () => ({ bid, ask: null }), columnScale: () => ({ ...scale }),
      solid: { begin: () => {}, addRect: rect, flush: () => {} }, text: { badge },
    } as unknown as OverlayFrame);
    expect(profile.last?.pocRow).toBe(row);
    expect(profile.last?.sampled).toBe(false);
    expect(rect).toHaveBeenCalledTimes(1);
    expect(rect.mock.calls[0][1]).toBeCloseTo(gm.clipY(row - .5));
    expect(rect.mock.calls[0][3]).toBeCloseTo(gm.clipY(row + .5));
    expect(badge.mock.calls[0][1]).toBeCloseTo(gm.cssY(row));
    expect(badge.mock.calls[0][2]).toBe(`POC ${rowToPrice(scale, row).toFixed(2)}`);
  });

  it.each([
    { tick: .25, step: 1, p0: 100.25, label: 'POC 103.25' },
    { tick: 1e-9, step: 4e-9, p0: 1e-7, label: 'POC 0.000000112' },
  ])('uses native tick $tick for the POC label even with coarse buckets', async ({ tick, step, p0, label }) => {
    const scale: PriceScale = { kind: 'linear', rows: 8, p0, step };
    const bid = new Float32Array(8); bid[3] = 9;
    const gm = new GridMap({ colOffset: 0, colScale: 2, rowOffset: 0, rowScale: 8 },
      { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 }, null, { p0, step, tick, scale });
    const badge = vi.fn();
    const profile = new Profile({ maxCols: 1 });
    const frame = { gm, resident: { oldest: 0, newest: 1 }, columnArrays: () => ({ bid, ask: null }),
      solid: { begin: () => {}, addRect: () => {}, flush: () => {} }, text: { badge },
    } as unknown as OverlayFrame;
    profile.draw(frame);
    await vi.waitFor(() => { profile.draw(frame); expect(profile.last?.sampled).toBe(false); });
    expect(badge.mock.calls.at(-1)![2]).toBe(label);
    profile.dispose();
  });

  it('combines old and new epochs by their physical price instead of row number', () => {
    const source: PriceScale = { kind: 'linear', rows: 8, p0: 100, step: 1 };
    const target: PriceScale = { kind: 'linear', rows: 8, p0: 101, step: 1 };
    const old = new Float32Array(8); old[2] = 9;
    const current = new Float32Array(8); current[1] = 3;
    const result = accumulateProfile(0, 1, 0, 7, col => ({ bid: col === 0 ? old : current, ask: null }),
      undefined, undefined, 1, { target, source: col => col === 0 ? source : target });
    expect(result.bins[1]).toBe(12);
    expect(result.bins[2]).toBe(0);
    expect(result.sampled).toBe(true); // Resampling is disclosed by the approximate POC label.
  });

  it('conserves quantity when a source interval straddles destination bins', () => {
    const source: PriceScale = { kind: 'linear', rows: 8, p0: 100, step: 1 };
    const target: PriceScale = { kind: 'linear', rows: 8, p0: 100.25, step: 1 };
    const bid = new Float32Array(8); bid[1] = 10;
    const result = accumulateProfile(0, 0, 0, 7, () => ({ bid, ask: null }),
      undefined, undefined, 1, { target, source: () => source });
    expect(result.bins[0]).toBeCloseTo(2.5);
    expect(result.bins[1]).toBeCloseTo(7.5);
    expect(result.bins.reduce((sum, value) => sum + value, 0)).toBeCloseTo(10);
  });

  it('conserves a broad old wing bucket across a newly centered core', () => {
    const old = makeHybrid({ mid: 82414.24, rows: 4096, coreRows: 2048, coreStep: .01, upMult: 11, dnFloor: .01 })!;
    const target = makeHybrid({ mid: 81812, rows: 4096, coreRows: 2048, coreStep: .01, upMult: 11, dnFloor: .01 })!;
    const bid = new Float32Array(old.rows); bid[Math.round(priceToRow(old, 81812))] = 50;
    const result = accumulateProfile(0, 0, 0, target.rows - 1, () => ({ bid, ask: null }),
      undefined, undefined, 1, { target, source: () => old });
    expect(result.bins.reduce((sum, value) => sum + value, 0)).toBeCloseTo(50, 6);
    expect(result.bins[target.dnRows + 1024]).toBeGreaterThan(0);
  });
});
