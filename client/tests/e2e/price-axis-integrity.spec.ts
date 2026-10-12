import { test, expect } from '@playwright/test';

test('deep BTC view labels the actual small price move instead of implying thousands of dollars', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // @ts-expect-error production modules are served by Vite during e2e
    const { GridMap } = await import('/src/gl/overlays/coords.ts');
    // @ts-expect-error production modules are served by Vite during e2e
    const { makeHybrid, rowToPrice } = await import('/src/gl/priceScale.ts');
    // @ts-expect-error production modules are served by Vite during e2e
    const { priceFrame } = await import('/src/gl/camera.ts');
    // @ts-expect-error production modules are served by Vite during e2e
    const { priceAxisModel } = await import('/src/gl/overlays/axes.ts');
    // @ts-expect-error production modules are served by Vite during e2e
    const { PriceLine } = await import('/src/gl/overlays/priceLine.ts');
    // @ts-expect-error production modules are served by Vite during e2e
    const { TextLayer } = await import('/src/gl/textLayer.ts');
    const scale = makeHybrid({ mid: 85505, rows: 4096, coreRows: 2048, coreStep: 0.01, upMult: 11, dnFloor: 0.01 });
    const dims = { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 };
    const time = { anchorSeq: 0, anchorT0Ns: 0n, dtNs: 250000000 };
    const map = { p0: scale.coreP0, step: scale.coreStep, scale };
    const fit = priceFrame(scale.dnRows, scale.dnRows + scale.coreRows - 1, scale.rows, 0.08, 3, scale);
    const view = { colOffset: 0, colScale: 2, rowOffset: fit.rowBottom, rowScale: fit.rowSpan };
    const gm = new GridMap(view, dims, time, map);
    const labels = priceAxisModel(gm, 600, 56);
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const text = new TextLayer(canvas, false);
    text.syncSize(1000, 600, 1);
    const captured: { x: number; y: number }[] = [];
    const paint = text.polyline.bind(text);
    text.polyline = (points: { x: number; y: number }[], opts: { width: number; color: string; alpha?: number }) => {
      if (captured.length === 0) captured.push(...points);
      paint(points, opts);
    };
    const line = new PriceLine();
    const prices = [85504.75, 85500.89];
    prices.forEach((c, col_seq) => line.add({ c, col_seq }));
    line.draw({ gm, text, resident: { oldest: 0, newest: 1 } });
    const coreLabels = labels.filter((l: { label: string }) => Math.abs(Number(l.label) - 85505) < 15);
    const readFromAxis = captured.map(point => {
      const ordered = [...coreLabels].sort((a,b) => a.pos - b.pos);
      const lower = ordered.find(l => l.pos >= point.y)!;
      const upper = ordered.filter(l => l.pos <= point.y).at(-1)!;
      const f = (point.y - upper.pos) / (lower.pos - upper.pos);
      return Number(upper.label) + f * (Number(lower.label) - Number(upper.label));
    });
    return { prices, readFromAxis, coreLabels, fittedPriceSpan: rowToPrice(scale, fit.rowBottom + fit.rowSpan) - rowToPrice(scale, fit.rowBottom) };
  });
  expect(result.coreLabels.length).toBeGreaterThanOrEqual(4);
  result.prices.forEach((price, i) => expect(result.readFromAxis[i]).toBeCloseTo(price, 1));
  expect(result.readFromAxis[0] - result.readFromAxis[1]).toBeCloseTo(3.86, 2);
  expect(result.fittedPriceSpan).toBeLessThan(25);
});

test('prices in hybrid wings stay at their exact dollar value', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // @ts-expect-error production module is served by Vite
    const { GridMap } = await import('/src/gl/overlays/coords.ts');
    // @ts-expect-error production module is served by Vite
    const { makeHybrid } = await import('/src/gl/priceScale.ts');
    // @ts-expect-error production module is served by Vite
    const { fractionRow } = await import('/src/gl/priceProjection.ts');
    // @ts-expect-error production module is served by Vite
    const { PriceLine } = await import('/src/gl/overlays/priceLine.ts');
    const scale = makeHybrid({ mid: 85505, rows: 4096, coreRows: 2048, coreStep: 0.01, upMult: 11, dnFloor: 0.01 });
    const dims = { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 };
    const gm = new GridMap({ colOffset: 0, colScale: 2, rowOffset: 0, rowScale: 4096 }, dims,
      { anchorSeq: 0, anchorT0Ns: 0n, dtNs: 250000000 }, { p0: scale.coreP0, step: scale.coreStep, scale });
    const prices = [80000, 85505]; // a REAL $5,505 move must remain a real $5,505 move
    let points: { x: number; y: number }[] = [];
    const line = new PriceLine();
    prices.forEach((c, col_seq) => line.add({ c, col_seq }));
    line.draw({ gm, resident: { oldest: 0, newest: 1 }, text: {
      polyline: (p: { x: number; y: number }[]) => { if (!points.length) points = p; }, dashedLine: () => {},
    } });
    return { prices, plotted: points.map(p => gm.rowToPrice(fractionRow(gm.view, scale, 1 - p.y / 600))) };
  });
  result.prices.forEach((price, i) => expect(result.plotted[i]).toBeCloseTo(price, 6));
  expect(result.plotted[1] - result.plotted[0]).toBeCloseTo(5505, 6);
});
