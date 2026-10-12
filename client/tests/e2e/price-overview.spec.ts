import { expect, test } from '@playwright/test';

test('a wide hybrid view plots every price on one uniform dollar axis', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite production module
    const { makeHybrid, priceToRow } = await import('/src/gl/priceScale.ts');
    // @ts-expect-error Vite production module
    const { GridMap } = await import('/src/gl/overlays/coords.ts');
    // @ts-expect-error Vite production module
    const { priceAxisModel } = await import('/src/gl/overlays/axes.ts');
    const scale = makeHybrid({ mid: 85505, rows: 4096, coreRows: 2048, coreStep: 0.01, upMult: 11, dnFloor: 0.01 });
    const lo = priceToRow(scale, 85400), hi = priceToRow(scale, 85600);
    const gm = new GridMap({ colOffset: 0, colScale: 100, rowOffset: lo, rowScale: hi - lo },
      { cssW: 1000, cssH: 600, drawW: 1000, drawH: 600 }, null, { p0: scale.coreP0, step: scale.coreStep, scale });
    const prices = [85420, 85440, 85460, 85480, 85500, 85520, 85540, 85560];
    return { ys: prices.map(p => gm.cssY(gm.priceEventToRow(p))), labels: priceAxisModel(gm, 600, 56) };
  });
  for (let i = 1; i < result.ys.length; i++) expect(result.ys[i - 1] - result.ys[i]).toBeCloseTo(60, 5);
  expect(result.labels.length).toBeGreaterThanOrEqual(4);
});

test('GPU heatmap agrees with the price axis across a hybrid core boundary', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => window.__flowmapTest);
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite production module
    const { makeHybrid, priceToRow } = await import('/src/gl/priceScale.ts');
    const api = window.__flowmapTest!;
    const scale = makeHybrid({ mid: 1000, rows: 64, coreRows: 32, coreStep: 1, upMult: 11, dnFloor: 0.01 });
    api.init(64, 1, 256, 600, true);
    api.setPriceScale(scale);
    api.setEncoding(1, 5000, false);
    const bid = Array(64).fill(0);
    bid[Math.round(priceToRow(scale, 1000))] = 5000;
    for (let c = 0; c < 32; c++) api.appendColumn(c, bid, Array(64).fill(0));
    const lo = priceToRow(scale, 900), hi = priceToRow(scale, 1100);
    api.setView({ colOffset: 0, colScale: 32, rowOffset: lo, rowScale: hi - lo });
    const pixels = api.readPixels(128, 0, 1, 600);
    const bright: number[] = [];
    for (let y = 0; y < 600; y++) if (Math.max(...pixels.slice(y * 4, y * 4 + 3)) > 80) bright.push(y);
    api.dispose();
    return { bright };
  });
  expect(errors).toEqual([]);
  expect(result.bright.length).toBeGreaterThan(0);
  const center = result.bright.reduce((a,b) => a+b,0) / result.bright.length;
  expect(Math.abs(center - 300)).toBeLessThan(5);
});

for (const wing of ['lower', 'upper'] as const) {
  for (const floor of [0, 0.0014]) {
    for (const columnsPerPixel of [0.25, 4, 16]) {
    test(`GPU ${wing} wing retains quantity and extent at contrast 88, floor ${floor}, ${columnsPerPixel} columns/pixel`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('/?test=heatmap');
      const result = await page.evaluate(async ({ wing, floor, columnsPerPixel }) => {
        // @ts-expect-error Vite production module
        const { makeHybrid, priceToRow, rowToPrice } = await import('/src/gl/priceScale.ts');
        // @ts-expect-error Vite production module
        const { initGL } = await import('/src/gl/context.ts');
        // @ts-expect-error Vite production module
        const { Heatmap, gammaForContrast } = await import('/src/gl/heatmap.ts');
        // @ts-expect-error Vite production module
        const { TileRing } = await import('/src/gl/tileRing.ts');
        // @ts-expect-error Vite production module
        const { createLUTTexture, RAMP_FLOW } = await import('/src/gl/lut.ts');
        // @ts-expect-error Vite production module
        const { MipChain } = await import('/src/gl/mips.ts');

        const canvas = document.createElement('canvas');
        canvas.width = columnsPerPixel > 1 ? 16 : 128;
        canvas.height = 600;
        document.body.append(canvas);
        const ctx = initGL(canvas, { requireColorBufferFloat: false });
        const ring = new TileRing(ctx.gl, 4096, 1);
        const lut = createLUTTexture(ctx.gl);
        const heatmap = new Heatmap(ctx, ring, lut);
        const mips = columnsPerPixel > 1 ? new MipChain(ctx, 256, 4096, 1) : null;
        heatmap.mips = mips;
        const scale = makeHybrid({ mid: 85600, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01 });
        const row = Math.round(priceToRow(scale, wing === 'lower' ? 84053 : 88000));
        const bucketLow = rowToPrice(scale, row - 0.5);
        const bucketHigh = rowToPrice(scale, row + 0.5);
        const bucketWidth = bucketHigh - bucketLow;
        const low = bucketLow - 0.75 * bucketWidth;
        const high = bucketHigh + 0.75 * bucketWidth;
        const view = {
          colOffset: 0, colScale: canvas.width * columnsPerPixel,
          rowOffset: priceToRow(scale, low),
          rowScale: priceToRow(scale, high) - priceToRow(scale, low),
        };
        const bid = new Float32Array(4096);
        for (let col = 0; col < view.colScale; col++) {
          // Coarse-time pixels average a pulse and quiet columns. Price extent
          // remains one bucket, even though actual square mips are available.
          bid[row] = columnsPerPixel > 1 ? (col % columnsPerPixel === 0 ? 80 * columnsPerPixel : 0) : 80;
          ring.append(col, 0, bid, new Float32Array(4096), 4096);
          mips?.updateFrom(ring, col);
        }
        heatmap.priceScale = scale;
        // Shader density is quantity per native fine-step price interval.
        // Calibrate the white point in that same unit while keeping raw80lots.
        heatmap.encoding = { decodeScale: 1, norm: 100 * scale.coreStep / bucketWidth, ramp: RAMP_FLOW };
        heatmap.gamma = gammaForContrast(88);
        heatmap.floor = floor;
        heatmap.draw(view);
        const pixels = new Uint8Array(600 * 4);
        ctx.gl.readPixels(canvas.width / 2, 0, 1, 600, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, pixels);
        const background = Array.from(pixels.slice(0, 3));
        const visible: number[] = [];
        for (let y = 0; y < 600; y++) {
          if (Math.max(...pixels.slice(y * 4, y * 4 + 3).map((channel, c) => Math.abs(channel - background[c]))) > 20) visible.push(y);
        }
        heatmap.dispose();
        mips?.dispose();
        ring.dispose();
        ctx.gl.deleteTexture(lut);
        canvas.remove();
        return {
          visible, gamma: gammaForContrast(88), bucketWidth,
          expectedLow: (bucketLow - low) / (high - low) * 600,
          expectedHigh: (bucketHigh - low) / (high - low) * 600,
        };
      }, { wing, floor, columnsPerPixel });
      expect(errors).toEqual([]);
      expect(result.gamma).toBeCloseTo(1.292, 12);
      expect(result.bucketWidth).toBeGreaterThan(200);
      expect(result.visible.length).toBeGreaterThan(200);
      expect(Math.abs(result.visible[0] - result.expectedLow)).toBeLessThan(2);
      expect(Math.abs(result.visible.at(-1)! + 1 - result.expectedHigh)).toBeLessThan(2);
    });
    }
  }
}

for (const level of [1, 2]) {
  for (const edge of ['left', 'right'] as const) {
    test(`GPU price mip ${level} averages its partial ${edge} time block without a black edge`, async ({ page }) => {
      await page.goto('/?test=heatmap');
      const result = await page.evaluate(async ({ level, edge }) => {
        // @ts-expect-error Vite production module
        const { makeHybrid, priceToRow } = await import('/src/gl/priceScale.ts');
        // @ts-expect-error Vite production module
        const { initGL } = await import('/src/gl/context.ts');
        // @ts-expect-error Vite production module
        const { Heatmap } = await import('/src/gl/heatmap.ts');
        // @ts-expect-error Vite production module
        const { TileRing } = await import('/src/gl/tileRing.ts');
        // @ts-expect-error Vite production module
        const { MipChain } = await import('/src/gl/mips.ts');
        // @ts-expect-error Vite production module
        const { createLUTTexture, RAMP_CLASSIC } = await import('/src/gl/lut.ts');
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        document.body.append(canvas);
        const ctx = initGL(canvas, { requireColorBufferFloat: true });
        const ring = new TileRing(ctx.gl, 4096, 1);
        const lut = createLUTTexture(ctx.gl);
        const heatmap = new Heatmap(ctx, ring, lut);
        const mips = new MipChain(ctx, 256, 4096, 1);
        heatmap.mips = mips;
        const scale = makeHybrid({ mid: 10000, rows: 4096, coreRows: 2048, coreStep: 1, upMult: 11, dnFloor: 0.01 });
        const block = 4 ** level;
        const first = edge === 'left' ? block + 1 : 0;
        const newest = edge === 'right' ? 8 * block : 16 * block - 1;
        const bid = new Float32Array(4096);
        bid.fill(100);
        for (let col = first; col <= newest; col++) {
          ring.append(col, 0, bid, new Float32Array(4096), 4096);
          mips.updateFrom(ring, col);
        }
        const targetColumn = edge === 'right' ? newest : first;
        const priceSpan = canvas.height * block * 1.25;
        const low = 10000 - priceSpan / 2;
        heatmap.priceScale = scale;
        heatmap.encoding = { decodeScale: 1, norm: 1000, ramp: RAMP_CLASSIC };
        heatmap.floor = 0;
        heatmap.draw({
          colOffset: targetColumn + 0.25 - 8.5 * block, colScale: canvas.width * block,
          rowOffset: priceToRow(scale, low), rowScale: priceToRow(scale, low + priceSpan) - priceToRow(scale, low),
        });
        const pixel = new Uint8Array(4);
        ctx.gl.readPixels(8, 8, 1, 1, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, pixel);
        heatmap.dispose();
        mips.dispose();
        ring.dispose();
        ctx.gl.deleteTexture(lut);
        canvas.remove();
        return Array.from(pixel);
      }, { level, edge });
      expect(Math.max(...result.slice(0, 3))).toBeGreaterThan(80);
    });
  }
}

test('GPU coarse price sampling falls back when the row-only mip is unavailable', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite production module
    const { makeHybrid, priceToRow } = await import('/src/gl/priceScale.ts');
    // @ts-expect-error Vite production module
    const { initGL } = await import('/src/gl/context.ts');
    // @ts-expect-error Vite production module
    const { Heatmap } = await import('/src/gl/heatmap.ts');
    // @ts-expect-error Vite production module
    const { TileRing } = await import('/src/gl/tileRing.ts');
    // @ts-expect-error Vite production module
    const { MipChain } = await import('/src/gl/mips.ts');
    // @ts-expect-error Vite production module
    const { createLUTTexture, RAMP_CLASSIC } = await import('/src/gl/lut.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 16;
    document.body.append(canvas);
    const ctx = initGL(canvas, { requireColorBufferFloat: true });
    const ring = new TileRing(ctx.gl, 4096, 1);
    const lut = createLUTTexture(ctx.gl);
    const heatmap = new Heatmap(ctx, ring, lut);
    const mips = new MipChain(ctx, 256, 4096, 1);
    Object.defineProperty(mips, 'rowUsable', { get: () => false });
    heatmap.mips = mips;
    const scale = makeHybrid({ mid: 10000, rows: 4096, coreRows: 2048, coreStep: 1, upMult: 11, dnFloor: 0.01 });
    const bid = new Float32Array(4096);
    bid.fill(100);
    // Leave mip textures empty: the native fallback must supply this pixel.
    for (let col = 0; col < 32; col++) ring.append(col, 0, bid, new Float32Array(4096), 4096);
    heatmap.priceScale = scale;
    heatmap.encoding = { decodeScale: 1, norm: 1000, ramp: RAMP_CLASSIC };
    heatmap.draw({ colOffset: 0, colScale: 32, rowOffset: priceToRow(scale, 9960), rowScale: priceToRow(scale, 10040) - priceToRow(scale, 9960) });
    const pixel = new Uint8Array(4);
    ctx.gl.readPixels(64, 8, 1, 1, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, pixel);
    heatmap.dispose();
    mips.dispose();
    ring.dispose();
    ctx.gl.deleteTexture(lut);
    canvas.remove();
    return Array.from(pixel);
  });
  expect(Math.max(...result.slice(0, 3))).toBeGreaterThan(80);
});

for (const wing of ['lower', 'upper'] as const) {
  test(`weak GPU ${wing} wing uses its local tolerance footprint in a view crossing the core`, async ({ page }) => {
    await page.goto('/?test=heatmap');
    const result = await page.evaluate(async wing => {
      // @ts-expect-error Vite production module
      const { makeHybrid, priceToRow, rowToPrice } = await import('/src/gl/priceScale.ts');
      // @ts-expect-error Vite production module
      const { initGL } = await import('/src/gl/context.ts');
      // @ts-expect-error Vite production module
      const { Heatmap, DEFAULT_DISPLAY_GAMMA } = await import('/src/gl/heatmap.ts');
      // @ts-expect-error Vite production module
      const { TileRing } = await import('/src/gl/tileRing.ts');
      // @ts-expect-error Vite production module
      const { MipChain } = await import('/src/gl/mips.ts');
      // @ts-expect-error Vite production module
      const { createLUTTexture, RAMP_CLASSIC } = await import('/src/gl/lut.ts');

      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 600;
      document.body.append(canvas);
      const ctx = initGL(canvas, { requireColorBufferFloat: true });
      const ring = new TileRing(ctx.gl, 4096, 1);
      const lut = createLUTTexture(ctx.gl);
      const heatmap = new Heatmap(ctx, ring, lut);
      const mips = new MipChain(ctx, 256, 4096, 1);
      heatmap.mips = mips;
      const scale = makeHybrid({ mid: 85600, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01 });
      const row = Math.round(priceToRow(scale, wing === 'lower' ? 84053 : 88000));
      const bucketLow = rowToPrice(scale, row - 0.5);
      const bucketHigh = rowToPrice(scale, row + 0.5);
      const low = wing === 'lower' ? bucketLow - 100 : scale.coreP0 + scale.coreRows * scale.coreStep - 1000;
      const high = wing === 'lower' ? scale.coreP0 + 1000 : bucketHigh + 100;
      const bid = new Float32Array(4096);
      bid[row] = 0.4; // 0.004 of the width-correct white point below.
      for (let col = 0; col < 32; col++) {
        ring.append(col, 0, bid, new Float32Array(4096), 4096);
        mips.updateFrom(ring, col);
      }
      heatmap.priceScale = scale;
      heatmap.encoding = { decodeScale: 1, norm: 100 * scale.coreStep / (bucketHigh - bucketLow), ramp: RAMP_CLASSIC };
      heatmap.gamma = DEFAULT_DISPLAY_GAMMA;
      heatmap.floor = 0.0014;
      heatmap.draw({ colOffset: 0, colScale: 32, rowOffset: priceToRow(scale, low), rowScale: priceToRow(scale, high) - priceToRow(scale, low) });
      const pixels = new Uint8Array(600 * 4);
      ctx.gl.readPixels(64, 0, 1, 600, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, pixels);
      const expectedLow = (bucketLow - low) / (high - low) * 600;
      const expectedHigh = (bucketHigh - low) / (high - low) * 600;
      const y = Math.floor((expectedLow + expectedHigh) / 2);
      const bucket = Array.from(pixels.slice(y * 4, y * 4 + 3));
      const background = Array.from(pixels.slice(0, 3));
      heatmap.dispose();
      mips.dispose();
      ring.dispose();
      ctx.gl.deleteTexture(lut);
      canvas.remove();
      return { bucket, background };
    }, wing);
    expect(Math.max(...result.bucket.map((v, c) => Math.abs(v - result.background[c])))).toBeGreaterThan(2);
  });
}
