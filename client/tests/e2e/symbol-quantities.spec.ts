import { expect, test } from '@playwright/test';

test('large venue quantities retain the same wall contrast at every zoom level', async ({ page }) => {
  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window);
  const comparisons = await page.evaluate(() => {
    const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
    api.init(1024, 2, 256, 64, true);
    const draw = (size: number) => {
      const bid = new Array(1024).fill(0);
      bid[512] = size;
      bid[528] = size / 5;
      const ask = new Array(1024).fill(0);
      for (let col = 0; col < 196; col++) api.appendColumn(col, bid, ask);
      api.setEncoding(1, size, false);
      return [32, 256, 1024].map(rowScale => {
        api.setView({colOffset: 140, colScale: 20, rowOffset: 512-rowScale/2, rowScale});
        return Array.from(api.readPixels(128, 0, 1, 64)) as number[];
      });
    };
    const small = draw(100);
    const large = draw(2_000_000_000);
    return small.map((pixels, level) => ({
      level,
      maxError: Math.max(...pixels.map((value, i) => Math.abs(value-large[level][i]))),
      brightness: Math.max(...large[level].filter((_, i) => i%4 !== 3)),
    }));
  });
  for (const result of comparisons) {
    expect(result.brightness).toBeGreaterThan(100);
    expect(result.maxError).toBeLessThanOrEqual(2);
  }
});
