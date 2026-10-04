import { expect, test } from '@playwright/test';

test('the full live app gives volume its own opaque area below the price chart', async ({ page }) => {
  await page.goto('/?spy=1');
  await page.waitForFunction(() => (window as any).__flowmapLive?.renderer?.newestColSeq > 8);
  const result = await page.evaluate(async () => {
    const plot = document.querySelector<HTMLCanvasElement>('canvas#gl')!;
    const volume = document.querySelector<HTMLCanvasElement>('canvas.overlay-volume')!;
    const ink = document.querySelector<HTMLCanvasElement>('canvas.overlay-text')!;
    const samples = [];
    // Sample the composed application's live layers over several redraws.
    for (let i = 0; i < 20; i++) {
      await new Promise(requestAnimationFrame);
      const ctx = volume.getContext('2d')!;
      const pixels = ctx.getImageData(0, 0, volume.width, volume.height).data;
      let transparent = 0;
      for (let j = 3; j < pixels.length; j += 4) if (pixels[j] !== 255) transparent++;
      samples.push(transparent);
    }
    const p = plot.getBoundingClientRect(), v = volume.getBoundingClientRect(), t = ink.getBoundingClientRect();
    return { overlap: p.bottom - v.top, widthError: p.width - v.width,
      inkHeightError: p.height - t.height, transparentPixels: Math.max(...samples),
      volumeHeight: v.height, plotHeight: p.height };
  });
  expect(Math.abs(result.overlap), JSON.stringify(result)).toBeLessThan(.1);
  expect(Math.abs(result.widthError)).toBeLessThan(.1);
  expect(Math.abs(result.inkHeightError)).toBeLessThan(.1);
  expect(result.transparentPixels).toBe(0);
  expect(result.volumeHeight).toBeGreaterThanOrEqual(16);
  expect(result.volumeHeight).toBeLessThanOrEqual(44);
  expect(result.plotHeight).toBeGreaterThan(100);
});

test('each volume bar stays under its own price vertex as visible column addresses change', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    const { VolBars } = await import('/src/gl/overlays/volbars.ts');
    const { PriceLine } = await import('/src/gl/overlays/priceLine.ts');
    const { TextLayer } = await import('/src/gl/textLayer.ts');
    const { GridMap } = await import('/src/gl/overlays/coords.ts');
    const canvas = document.createElement('canvas');
    const text = new TextLayer(canvas);
    text.syncSize(1101, 640, 1);
    const bars = new VolBars();
    const price = new PriceLine();
    const bar = { col_seq: 1061, c: 101, vol_buy: 5, vol_sell: 0 };
    bars.add(bar);
    bars.add({ col_seq: 1062, vol_buy: 0, vol_sell: 0 });
    price.add(bar);
    let traceX: number | null = null;
    const paintLine = text.polyline.bind(text);
    text.polyline = (pts, options) => {
      if (traceX === null && pts.length > 0) traceX = pts[0].x;
      paintLine(pts, options);
    };
    const errors: number[] = [];
    for (let f = 0; f < 80; f++) {
      const gm = new GridMap(
        { colOffset: 1000 + f / 20, colScale: 367, rowOffset: 0, rowScale: 10 },
        { cssW: 1101, cssH: 640, drawW: 1101, drawH: 640 },
        { anchorSeq: 0, anchorT0Ns: 0n, dtNs: 250_000_000 }, { p0: 100, step: 1 },
      );
      const frame = { gm, text, resident: { oldest: 0, newest: 2000 } };
      text.clear(); traceX = null;
      bars.draw(frame); price.draw(frame);
      const px = canvas.getContext('2d')!.getImageData(0, 630, 1101, 1).data;
      let mass = 0; let moment = 0;
      for (let x = 0; x < 1101; x++) { mass += px[x * 4 + 3]; moment += (x + 0.5) * px[x * 4 + 3]; }
      errors.push(Math.abs(moment / mass - traceX!));
    }
    return { frames: errors.length, worstAddressError: Math.max(...errors) };
  });
  expect(result.frames).toBe(80);
  expect(result.worstAddressError).toBeLessThan(0.05);
});

test('completed volume bars keep their pixel height while the time viewport moves', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // Exercise the production Canvas2D painter, not a recording mock.
    const { VolBars } = await import('/src/gl/overlays/volbars.ts');
    const { TextLayer } = await import('/src/gl/textLayer.ts');
    const { GridMap } = await import('/src/gl/overlays/coords.ts');
    const canvas = document.createElement('canvas');
    const text = new TextLayer(canvas);
    text.syncSize(300, 640, 1);
    const bars = new VolBars();
    for (let col = 0; col < 60; col++) {
      bars.add({ col_seq: col, vol_buy: col < 15 ? 100 : 2, vol_sell: 0 });
    }
    const originalNow = performance.now.bind(performance);
    let ts = 100;
    performance.now = () => ts;
    const heights: number[] = [];
    try {
      for (let frame = 0; frame <= 180; frame++) {
        ts += 1000 / 60;
        const offset = frame * 16 / 180;
        const gm = new GridMap(
          { colOffset: offset, colScale: 30, rowOffset: 0, rowScale: 10 },
          { cssW: 300, cssH: 640, drawW: 300, drawH: 640 }, null, null,
        );
        text.clear();
        bars.draw({ gm, text, resident: { oldest: 0, newest: 59 } });
        const x = Math.round(gm.cssX(20.5));
        const pixels = canvas.getContext('2d')!.getImageData(x, 590, 1, 50).data;
        let first = 50;
        for (let y = 0; y < 50; y++) if (pixels[y * 4 + 3] > 127) { first = y; break; }
        heights.push(49 - first);
      }
    } finally {
      performance.now = originalNow;
    }
    return { first: heights[0], last: heights.at(-1), spread: Math.max(...heights) - Math.min(...heights) };
  });
  expect(result.spread, JSON.stringify(result)).toBeLessThanOrEqual(1);
});

test('a thin volume bar moves at fractional pixel positions without hairline snapping', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    const { VolBars } = await import('/src/gl/overlays/volbars.ts');
    const { TextLayer } = await import('/src/gl/textLayer.ts');
    const { GridMap } = await import('/src/gl/overlays/coords.ts');
    const canvas = document.createElement('canvas');
    const text = new TextLayer(canvas);
    text.syncSize(30, 100, 1);
    const bars = new VolBars();
    bars.add({ col_seq: 15, vol_buy: 1, vol_sell: 0 });
    const errors: number[] = [];
    for (let frame = 0; frame < 10; frame++) {
      const offset = frame / 10;
      const gm = new GridMap(
        { colOffset: offset, colScale: 30, rowOffset: 0, rowScale: 10 },
        { cssW: 30, cssH: 100, drawW: 30, drawH: 100 }, null, null,
      );
      text.clear();
      bars.draw({ gm, text, resident: { oldest: 0, newest: 29 } });
      const px = canvas.getContext('2d')!.getImageData(0, 95, 30, 1).data;
      let mass = 0; let moment = 0;
      for (let x = 0; x < 30; x++) { mass += px[x * 4 + 3]; moment += (x + 0.5) * px[x * 4 + 3]; }
      errors.push(Math.abs(moment / mass - gm.cssX(15.5)));
    }
    return Math.max(...errors);
  });
  // Canvas coverage is quantized; allow less than 1/25 pixel of raster error.
  // The old snapped painter was off by half a pixel and repeated positions.
  expect(result).toBeLessThan(0.04);
});
