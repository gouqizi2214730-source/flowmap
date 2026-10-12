import { expect, test } from '@playwright/test';

test('native price epochs stay aligned and depth controls change real GL pixels', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite module imports for real browser GL verification.
    const { initGL, checkGLError } = await import('/src/gl/context.ts');
    // @ts-expect-error Vite module
    const { TileRing } = await import('/src/gl/tileRing.ts');
    // @ts-expect-error Vite module
    const { Heatmap } = await import('/src/gl/heatmap.ts');
    // @ts-expect-error Vite module
    const { MipChain } = await import('/src/gl/mips.ts');
    // @ts-expect-error Vite module
    const { createLUTTexture } = await import('/src/gl/lut.ts');
    // @ts-expect-error Vite module
    const { makeHybrid, priceToRow } = await import('/src/gl/priceScale.ts');
    // @ts-expect-error Vite module
    const { ViewportNormalizer } = await import('/src/gl/normalize.ts');
    // @ts-expect-error Vite module
    const { densityForScale } = await import('/src/gl/columnGeometry.ts');
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
    document.body.append(canvas);
    const ctx = initGL(canvas, { preserveDrawingBuffer: true }), gl = ctx.gl;
    const ring = new TileRing(gl, 4096, 2), lut = createLUTTexture(gl), heatmap = new Heatmap(ctx, ring, lut);
    const mips = new MipChain(ctx, 256, 4096, 2); heatmap.mips = mips;
    const old = makeHybrid({ mid: 82916, rows: 4096, coreRows: 2048, coreStep: .5, upMult: 11, dnFloor: .01 });
    const current = makeHybrid({ mid: 81812, rows: 4096, coreRows: 2048, coreStep: .5, upMult: 11, dnFloor: .01 });
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    const draw = (low: number, high: number, columns = 256) => {
      heatmap.draw({ colOffset: 0, colScale: columns, rowOffset: priceToRow(heatmap.priceScale, low) + (heatmap.priceScale.kind === 'linear' ? .5 : 0),
        rowScale: priceToRow(heatmap.priceScale, high) - priceToRow(heatmap.priceScale, low) });
      checkGLError(gl, 'depth-calibration'); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    };
    const lumaAt = (x: number, price: number, low: number, high: number) => {
      const y = Math.max(0, Math.min(511, Math.floor((price - low) / (high - low) * 512)));
      let maximum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const i = (Math.max(0, Math.min(511, y + dy)) * 1024 + x) * 4;
        maximum = Math.max(maximum, .299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2]);
      }
      return maximum;
    };
    for (let c = 0; c < 256; c++) {
      const scale = c < 127 ? old : current, bid = new Float32Array(4096);
      const center = Math.round(priceToRow(scale, c < 127 ? 83000 : 81812));
      for (let d = -5; d <= 5; d++) bid[center + d] = 100;
      ring.append(c, c < 127 ? 1 : 2, bid, null, 4096); ring.geometry.set(c, scale, c < 127 ? 1 : 2);
    }
    mips.updateRange(ring, 0, 255); heatmap.priceScale = current; heatmap.encoding.norm = 100; heatmap.toleranceValue = 0;
    draw(81600, 83300);
    const alignment = { oldWall: lumaAt(200, 83000, 81600, 83300), oldVoid: lumaAt(200, 81812, 81600, 83300),
      newWall: lumaAt(800, 81812, 81600, 83300), newVoid: lumaAt(800, 83000, 81600, 83300),
      // Time-mip group124..127 straddles the native geometry boundary.
      seamOld: lumaAt(500, 83000, 81600, 83300), seamNew: lumaAt(508, 81812, 81600, 83300) };
    draw(81600, 83300, 4096);
    const temporal = { old: lumaAt(31, 83000, 81600, 83300), current: lumaAt(31, 81812, 81600, 83300),
      ghost: lumaAt(31, 82916, 81600, 83300) };
    // Supported reconnect replacement can reuse an epoch number. Compare map
    // geometry, not only the numeric ID when deciding whether a mip is valid.
    for (let c = 0; c < 256; c++) ring.geometry.set(c, c < 127 ? old : current, 1);
    draw(81600, 83300, 4096);
    const reusedEpoch = { old: lumaAt(31, 83000, 81600, 83300), current: lumaAt(31, 81812, 81600, 83300),
      ghost: lumaAt(31, 82916, 81600, 83300) };
    const norm = new ViewportNormalizer({ floor: 0, emaAlpha: 1 }); heatmap.normalizer = norm;
    const bid = new Float32Array(4096), center = Math.round(priceToRow(current, 81812));
    for (let d = -8; d <= 8; d++) bid[center + d] = (d + 9) ** 2;
    for (let c = 0; c < 256; c++) {
      ring.append(c, 2, bid, null, 4096); ring.geometry.set(c, current, 2);
      norm.foldColumnFinal(c, densityForScale(current, bid, new Float32Array(4096)), null, current);
    }
    mips.updateRange(ring, 0, 255);
    const statistics = () => {
      let bright = 0, hot = 0, total = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const l = .299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2];
        if (l > 25) bright++; if (l > 180) hot++; total += l;
      }
      return { bright, hot, mean: total / (1024 * 512) };
    };
    const paintControl = (white: number, tolerance: number) => {
      norm.whitePercentile = white; norm.percentile = white - 2.7;
      heatmap.encoding.norm = norm.updateNorm({ oldest: 0, newest: 255 }, { lo: center - 20, hi: center + 20,
        priceLo: 81802, priceHi: 81822, referenceStep: .5 }, 0);
      heatmap.toleranceValue = tolerance; draw(81802, 81822); return statistics();
    };
    const controls = { zero: paintControl(99.7, 0), medium: paintControl(99.7, 50), strong: paintControl(99.7, 100),
      saturation80: paintControl(80, 0), saturation99: paintControl(99.7, 0) };
    // The owner's exact frozen down-wing fixture, measured as area, not just
    // "some colored pixel exists". A coarse historical interval cannot be hot.
    const coarse = new Float32Array(4096); coarse[Math.round(priceToRow(old, 81812))] = 200;
    const coarseNorm = new ViewportNormalizer({ emaAlpha: 1 }); heatmap.normalizer = coarseNorm;
    for (let c = 0; c < 256; c++) {
      ring.append(c, 1, coarse, null, 4096); ring.geometry.set(c, old, 1);
      coarseNorm.foldColumnFinal(c, densityForScale(old, coarse, new Float32Array(4096)), null, old);
    }
    mips.updateRange(ring, 0, 255);
    heatmap.encoding.norm = coarseNorm.updateNorm({ oldest: 0, newest: 255 }, { lo: 0, hi: 4095,
      priceLo: 81600, priceHi: 82000, referenceStep: .5 }, 0); heatmap.toleranceValue = 0;
    draw(81600, 82000); const cloud = { ...statistics(), field: lumaAt(400, 81812, 81600, 82000), void: lumaAt(400, 81610, 81600, 82000) };
    // Sub-cent ticks at large absolute prices must not alternate 128/85/128
    // intensity solely due to Float32 cancellation in a physical bucket width.
    const fine = makeHybrid({ mid: 59000, rows: 4096, coreRows: 2048, coreStep: .01, upMult: 11, dnFloor: .01 });
    const flat = new Float32Array(4096); flat.fill(100, fine.dnRows + 1, fine.dnRows + fine.coreRows - 1);
    for (let c = 0; c < 256; c++) { ring.append(c, 3, flat, null, 4096); ring.geometry.set(c, fine, 3); }
    mips.updateRange(ring, 0, 255); heatmap.priceScale = fine; heatmap.normalizer = null; heatmap.encoding.norm = 100;
    draw(59000, 59000.03); const uniform = [59000.005, 59000.015, 59000.025].map(price => lumaAt(400, price, 59000, 59000.03));
    const linear = { kind: 'linear', p0: 59000, step: .01, rows: 4096 };
    const translated = { ...linear, p0: 59000.01 };
    for (let c = 0; c < 256; c++) {
      const bid = new Float32Array(4096); bid[c < 128 ? 1 : 4] = 100;
      const native = c < 128 ? translated : linear;
      ring.append(c, 4, bid, null, 4096); ring.geometry.set(c, native, 4);
    }
    mips.updateRange(ring, 0, 255); heatmap.priceScale = linear;
    draw(59000, 59000.06);
    const centAlignment = { oldInside: lumaAt(200, 59000.0155, 59000, 59000.06), oldOutside: lumaAt(200, 59000.0255, 59000, 59000.06),
      currentInside: lumaAt(800, 59000.04, 59000, 59000.06), wrongOld: lumaAt(200, 59000.01, 59000, 59000.06) };
    // Same first/last origin must not hide an intermediate origin change.
    // Compare against independently projected per-column sampling: both fine
    // prices are occupied, even when all sixteen columns share a time pixel.
    for (let c = 0; c < 256; c++) {
      const bid = new Float32Array(4096); bid[1] = c === 1 ? 6400 : 100;
      ring.append(c, c, bid, null, 4096); ring.geometry.set(c, c === 1 ? { ...linear, p0: linear.p0 + .16 } : linear, c);
    }
    mips.updateRange(ring, 0, 255); heatmap.encoding.norm = 25; draw(59000, 59000 + 81.92, 16384);
    const exactPixel = (x: number, y: number) => { const at = (y * 1024 + x) * 4; return .299 * pixels[at] + .587 * pixels[at + 1] + .114 * pixels[at + 2]; };
    const returningCore = { steady: exactPixel(0, 0), moved: exactPixel(0, 1), blank: exactPixel(0, 3) };
    const tiny = { kind: 'linear', p0: .0001, step: 1e-10, rows: 4096 }, tinyDepth = new Float32Array(4096);
    tinyDepth.fill(100, 0, 10);
    for (let c = 0; c < 256; c++) { ring.append(c, 1000, tinyDepth, null, 4096); ring.geometry.set(c, tiny, 1000); }
    mips.updateRange(ring, 0, 255); heatmap.priceScale = tiny; heatmap.encoding.norm = 100;
    draw(.0001, .0001 + 3e-10); const tinyTick = lumaAt(400, .0001 + 1.5e-10, .0001, .0001 + 3e-10);
    // A mixed-epoch overview can conserve quantity while projecting an old
    // wide bucket onto a newer fine grid. Source uncertainty must survive.
    const low = 81703.6267, high = 81983.05885, projected = new Float32Array(4096);
    projected.fill(7, Math.ceil(priceToRow(current, low)), Math.floor(priceToRow(current, high)));
    heatmap.priceScale = current; heatmap.encoding.norm = 7;
    for (let c = 0; c < 256; c++) { ring.append(c, 2, projected, null, 4096); ring.geometry.set(c, current, 2); }
    mips.updateRange(ring, 0, 255); draw(81600, 82000); const falseFine = statistics();
    // The visible interval is ninth: no GPU eight-range truncation may hide it.
    const disjoint = Array.from({ length: 8 }, (_, i) => [low - 1000 - i * 20, low - 990 - i * 20, 10]);
    disjoint.push([low, high, high - low]);
    for (let c = 0; c < 256; c++) ring.geometry.setResolution(c, current, disjoint);
    draw(81600, 82000); const provenance = { ...statistics(), field: lumaAt(400, 81812, 81600, 82000), void: lumaAt(400, 81610, 81600, 82000) };
    // A large exact mask keeps its distant holes and the same visible result.
    // The lookup uses logarithmic search rather than scanning every band/pixel.
    const largeMask = Array.from({ length: 1023 }, (_, i) => [low - 20000 - i * 10, low - 19995 - i * 10, 5]);
    largeMask.push([low, high, high - low]);
    for (let c = 0; c < 256; c++) ring.geometry.setResolution(c, current, largeMask);
    const maskStart = performance.now();
    draw(81600, 82000);
    const largeProvenance = { ...statistics(), drawMs: performance.now() - maskStart };
    for (let c = 0; c < 256; c++) ring.geometry.setResolution(c, current);
    draw(81600, 82000); const restoredFine = statistics();
    heatmap.dispose(); mips.dispose(); ring.dispose(); gl.deleteTexture(lut); canvas.remove();
    return { alignment, temporal, reusedEpoch, controls, cloud, uniform, centAlignment, returningCore, tinyTick, falseFine, provenance, largeProvenance, restoredFine };
  });
  console.log(JSON.stringify(result));
  expect(result.alignment.oldWall).toBeGreaterThan(100);
  expect(result.alignment.newWall).toBeGreaterThan(100);
  expect(result.alignment.oldVoid).toBeLessThan(15);
  expect(result.alignment.newVoid).toBeLessThan(15);
  expect(result.alignment.seamOld).toBeGreaterThan(25);
  expect(result.alignment.seamNew).toBeGreaterThan(25);
  for (const boundary of [result.temporal, result.reusedEpoch]) {
    expect(boundary.old).toBeGreaterThan(100);
    expect(boundary.current).toBeGreaterThan(25);
    expect(boundary.ghost).toBeLessThan(15);
  }
  expect(result.controls.medium.bright).toBeLessThan(result.controls.zero.bright * .85);
  expect(result.controls.strong.bright).toBeLessThan(result.controls.medium.bright * .7);
  expect(result.controls.strong.bright).toBeGreaterThan(100);
  expect(result.controls.saturation80.hot).toBeGreaterThan(result.controls.saturation99.hot * 1.4);
  expect(result.cloud.hot).toBeLessThan(1024 * 512 * .01);
  expect(result.cloud.field).toBeGreaterThan(result.cloud.void + 3);
  expect(result.cloud.field).toBeLessThan(45);
  expect(Math.max(...result.uniform) - Math.min(...result.uniform)).toBeLessThan(2);
  expect(result.centAlignment.oldInside).toBeGreaterThan(100);
  expect(result.centAlignment.currentInside).toBeGreaterThan(100);
  expect(result.centAlignment.oldOutside).toBeLessThan(15);
  expect(result.centAlignment.wrongOld).toBeLessThan(15);
  expect(result.returningCore.steady).toBeGreaterThan(50);
  expect(result.returningCore.moved).toBeGreaterThan(100);
  expect(result.returningCore.blank).toBeLessThan(15);
  expect(result.tinyTick).toBeGreaterThan(200);
  expect(result.falseFine.hot).toBeGreaterThan(100000);
  expect(result.provenance.hot).toBe(0);
  expect(result.provenance.field).toBeGreaterThan(result.provenance.void + 3);
  expect(result.provenance.field).toBeLessThan(45);
  expect(result.largeProvenance.hot).toBe(0);
  expect(result.largeProvenance.bright).toBe(result.provenance.bright);
  expect(result.restoredFine.hot).toBe(result.falseFine.hot);
  expect(errors).toEqual([]);
});
