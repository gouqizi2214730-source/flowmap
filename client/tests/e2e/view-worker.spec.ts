import { expect, test } from '@playwright/test';

test('real module worker consumes the full profile and survives cancellation', async ({ page }) => {
  await page.goto('/?test=heatmap');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite module import for a real browser worker.
    const { ViewWorker } = await import('/src/gl/viewWorker.ts');
    const scale = { kind: 'linear', rows: 2, p0: 100, step: 1 };
    function* columns() {
      for (let c = 0; c < 1400; c++) yield {
        bid: Float32Array.from(c === 0 ? [2000, 0] : [0, 1]), ask: null, scale,
      };
    }
    const worker = new ViewWorker();
    const task = { kind: 'profile', rowLo: 0, rowHi: 1, target: scale, normalizeWidths: false };
    const full = await worker.run(task, columns());
    worker.dispose();
    const cancelled = new ViewWorker();
    const pending = cancelled.run(task, columns()).then(() => false, () => true);
    cancelled.dispose();
    return { bins: [...full.bins], count: full.columns, sampled: full.sampled, cancelled: await pending };
  });
  expect(result).toEqual({ bins: [2000, 1399], count: 1400, sampled: false, cancelled: true });
});
