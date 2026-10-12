import { describe, expect, it } from 'vitest';
import { Camera, limitsFor, screenToGrid } from './camera';
import { fractionRow, rowFraction } from './priceProjection';
import { makeHybrid, priceToRow, rowToPrice } from './priceScale';
import { GridMap } from './overlays/coords';

describe('price-uniform projection across storage boundaries', () => {
  for (const [symbol, mid, step] of [['BTC', 85505, 0.01], ['RUNE', 0.8, 0.0001], ['DOGE', 0.12, 0.00001]] as const) {
    const scale = makeHybrid({ mid, rows: 4096, coreRows: 2048, coreStep: step, upMult: 11, dnFloor: 0.01 })!;
    const low = Math.min(scale.coreP0 * 0.99, scale.coreP0 - 16 * step);
    const high = Math.max(mid * 1.01, scale.coreP0 + scale.coreRows * step + 16 * step);
    const bottom = priceToRow(scale, low);
    const top = priceToRow(scale, high);
    const view = { colOffset: 0, colScale: 100, rowOffset: bottom, rowScale: top - bottom };
    it(`${symbol}: equal price changes have equal screen distance across core and wings`, () => {
      const gm = new GridMap(view, { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 }, null, { p0: scale.coreP0, step, scale });
      for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const price = low + (high - low) * fraction;
        const row = priceToRow(scale, price);
        expect(gm.cssY(row)).toBeCloseTo(600 * (1 - fraction), 5);
        expect(rowFraction(view, scale, row)).toBeCloseTo(fraction, 8);
        const cursor = screenToGrid(view, 500, gm.cssY(row), 1000, 600, scale);
        expect(rowToPrice(scale, cursor.rowf)).toBeCloseTo(price, 7);
      }
    });
    it(`${symbol}: price zoom preserves the actual cursor price`, () => {
      const camera = new Camera(limitsFor(4096, 256));
      camera.priceScale = scale;
      camera.setPriceFrame(bottom, top - bottom);
      const anchor = fractionRow(camera.toView(), scale, 0.7);
      camera.zoomPrice(0.8, anchor);
      expect(rowFraction(camera.toView(), scale, anchor)).toBeCloseTo(0.7, 7);
    });
    it(`${symbol}: a vertical pan keeps the dollar span, including a sub-row wing viewport`, () => {
      const camera = new Camera(limitsFor(4096, 256));
      camera.priceScale = scale;
      const wingLow = priceToRow(scale, scale.coreP0 * 0.9);
      const wingHigh = priceToRow(scale, scale.coreP0 * 0.9 + 10 * step);
      camera.setPriceFrame(wingLow, wingHigh - wingLow);
      const before = camera.toView();
      const span = rowToPrice(scale, before.rowOffset + before.rowScale) - rowToPrice(scale, before.rowOffset);
      camera.pan(0, before.rowScale / 4);
      const after = camera.toView();
      expect(rowToPrice(scale, after.rowOffset + after.rowScale) - rowToPrice(scale, after.rowOffset)).toBeCloseTo(span, 6);
      expect(rowToPrice(scale, after.rowOffset) - rowToPrice(scale, before.rowOffset)).toBeCloseTo(span / 4, 6);
    });
  }
});
