import { expect, test, type Route } from '@playwright/test';

// Known observations are fixtures. Every external preview request remains
// unanswered, so a graph can only pass by reading its persisted observation.
const entries = [
  { market: 'equity', symbol: 'AAPL', price: 343.46, changePct: 1,
    spark: [340, 345, 343.46], asOf: 1792180800000000000 },
  { market: 'binance-spot', symbol: 'BTCUSDT', price: 81000, changePct: -1,
    spark: [82000, 81500, 81000], asOf: 1792340000000000000 },
  { market: 'binance-spot', symbol: 'ETHUSDT', price: 3200, changePct: 2,
    spark: [3100, 3150, 3200], asOf: 1792340000000000000 },
];

test('cached previews are correct on the first frame while every provider is blocked', async ({ page }, testInfo) => {
  await page.addInitScript(({ quotes }) => {
    localStorage.setItem('flowmap.recents', JSON.stringify(quotes.map(q => `${q.market}:${q.symbol}`)));
    localStorage.setItem('flowmap.preview-quotes.v1', JSON.stringify({ version: 1,
      entries: quotes.map(quote => ({ quote, fetchedAt: Date.now() - 60_000 })) }));
  }, { quotes: entries });
  const held: Route[] = [];
  await page.route(/\/api\/(?:quote|movers|universe|venues)(?:\?|$)/, route => { held.push(route); });
  await page.routeWebSocket(/\/ws$/, () => {});
  await page.goto('/');
  await expect(page.getByTestId('symbol-search-trigger')).toBeVisible();
  const opened = await page.evaluate(async () => {
    const start = performance.now();
    document.querySelector<HTMLButtonElement>('[data-testid="symbol-search-trigger"]')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return { elapsedMs: performance.now() - start,
      symbol: document.querySelector('.sympal__pv-sym')?.textContent,
      price: document.querySelector('.sympal__pv-px')?.textContent,
      path: document.querySelector('.sympal__pv-spark path')?.getAttribute('d'),
      rows: document.querySelectorAll('[data-testid="symbol-row"]').length };
  });
  expect(opened.symbol).toBe('AAPL');
  expect(opened.price).toBe('343.46');
  expect(opened.path).toBeTruthy();
  expect(opened.rows).toBe(260);
  await expect(page.locator('.sympal__pv-stale')).toBeVisible();
  const samples = [];
  for (let index = 0; index < 12; index++) {
    const sample = await page.evaluate(async ({ key, expectedSymbol }) => {
      const start = performance.now();
      let committedMs: number | null = null;
      const observer = new MutationObserver(() => {
        if (document.querySelector('.sympal__pv-sym')?.textContent === expectedSymbol) {
          committedMs = performance.now() - start;
          observer.disconnect();
        }
      });
      observer.observe(document.querySelector('.sympal__preview')!, { subtree: true, childList: true, characterData: true, attributes: true });
      document.querySelector('input[data-testid="symbol-search-input"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      observer.disconnect();
      return { committedMs, frameMs: performance.now() - start,
        symbol: document.querySelector('.sympal__pv-sym')?.textContent,
        price: document.querySelector('.sympal__pv-px')?.textContent,
        path: document.querySelector('.sympal__pv-spark path')?.getAttribute('d') };
    }, { key: index % 2 === 0 ? 'ArrowDown' : 'ArrowUp', expectedSymbol: index % 2 === 0 ? 'BTCUSDT' : 'AAPL' });
    expect(sample.symbol).toBe(index % 2 === 0 ? 'BTCUSDT' : 'AAPL');
    expect(sample.price).toBe(index % 2 === 0 ? '81,000' : '343.46');
    expect(sample.path).toBeTruthy();
    expect(sample.committedMs).not.toBeNull();
    samples.push(sample);
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('symbol-search-trigger').click();
  await expect(page.locator('.sympal__pv-sym')).toHaveText('AAPL');
  await expect(page.locator('.sympal__pv-spark path')).toHaveCount(1);
  expect(held.length).toBeGreaterThan(0);
  await testInfo.attach('preview-latency.json', { body: JSON.stringify({ opened, samples, blockedRequests: held.length }), contentType: 'application/json' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
