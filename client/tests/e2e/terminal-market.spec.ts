import { expect, test } from '@playwright/test';

test('inside quotes and tape keep exchange precision with grouped depth', async ({ page }) => {
  await page.goto('/?panels=1');
  await page.waitForFunction(() => window.__flowmapLive);
  await page.evaluate(() => {
    window.__flowmapLive!.store.setState({ status: 'live', capability: { depth: 'L2', tape: 'tick' },
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live' }, gridEpoch: 1,
      epochs: new Map([[1, { epoch: 1, tick: .01, tick_multiple: 50, dt_ns: 250000000, p0: 85600, rows: 256 }]]) });
  });
  await expect(page.getByTestId('venue')).toContainText('BTCUSDT');
  await page.evaluate(() => {
    const b = window.__flowmapLive!.bookStore;
    b.ingestForTest({ type: 6, ts_ns: 10n, bid_px: 85636.92, bid_sz: 1.25, ask_px: 85636.93, ask_sz: 2.5 } as never);
    b.ingestForTest({ type: 5, ts_ns: 10n, price: 85636.93, size: .0123, side: 1, side_src: 1, venue: 'binance-spot' } as never);
    const bid = new Float32Array(256), ask = new Float32Array(256);
    bid[74] = 10; ask[74] = 20;
    b.ingestForTest({ type: 3, epoch: 1, col_seq: 1, t0_ns: 1n, mode: 0, final: true, bid, ask } as never);
    b.flushForTest();
  });
  await expect(page.getByTestId('market-bid')).toHaveText('85636.92');
  await expect(page.getByTestId('market-ask')).toHaveText('85636.93');
  await expect(page.getByTestId('market-spread')).toHaveText('0.01');
  await expect(page.getByTestId('tape-row').first()).toHaveAttribute('data-price', '85636.93');
  await expect(page.getByTestId('ladder-resolution')).toHaveText('Δ 0.50');
  await expect(page.locator('[data-testid="ladder-row"][data-row="74"]')).toHaveClass(/is-bestbid.*is-bestask/);
  // Changing quantity updates one cell in place; no remount-driven strobe.
  await page.evaluate(() => {
    (window as unknown as { savedCell: Element | null }).savedCell = document.querySelector('[data-row="74"] .ladder__sz');
    const b = window.__flowmapLive!.bookStore, book = b.getSnapshot().book!;
    const bid = book.bid.slice(); bid[74] = 11;
    b.ingestForTest({ type: 35, epoch: 1, col_seq: 2, t0_ns: 2n, mode: 0, final: false, bid, ask: book.ask } as never);
    b.flushForTest();
  });
  await expect(page.locator('[data-row="74"]')).toHaveAttribute('data-bid', '11.0000');
  expect(await page.evaluate(() => document.querySelector('[data-row="74"] .ladder__sz') === (window as unknown as { savedCell: Element }).savedCell)).toBe(true);
  const prices = await page.getByTestId('ladder-row').evaluateAll(rows => rows.map(r => r.getAttribute('data-price')));
  expect(new Set(prices).size).toBe(prices.length);
});

test('the terminal restores the selected instrument on reload', async ({ page }) => {
  await page.goto('/?spy=1');
  await page.evaluate(() => localStorage.setItem('flowmap.active-symbol.v1', JSON.stringify({ market: 'binance-spot', symbol: 'RUNEUSDT' })));
  await page.reload();
  await expect(page.getByTestId('venue')).toContainText('RUNEUSDT');
  await page.waitForFunction(() => (window as unknown as { __flowmapControls?: Array<{ type: number }> }).__flowmapControls?.some(m => m.type === 64));
  const first = await page.evaluate(() => (window as unknown as { __flowmapControls: Array<{ type: number; market?: string; symbol?: string }> }).__flowmapControls.find(m => m.type === 64));
  expect(first?.market).toBe('binance-spot');
  expect(first?.symbol).toBe('RUNEUSDT');
});

test('time presets retain live follow and All continues to cover arriving history', async ({ page }) => {
  await page.goto('/?spy=1');
  await page.waitForFunction(() => (window.__flowmapLive?.renderer.timeline()?.newestSeq ?? -1) >= 10);
  await page.getByTestId('time-window-1m').click();
  expect(await page.evaluate(() => ({ follow: window.__flowmapLive!.renderer.following,
    ms: window.__flowmapLive!.renderer.timeWindowMs }))).toEqual({ follow: true, ms: 60000 });
  await page.getByTestId('time-window-All').click();
  const before = await page.evaluate(() => window.__flowmapLive!.renderer.timeline()!.newestSeq);
  await page.waitForFunction(before => window.__flowmapLive!.renderer.timeline()!.newestSeq >= before + 10, before);
  const result = await page.evaluate(() => {
    const r = window.__flowmapLive!.renderer, tl = r.timeline()!;
    return { following: r.following, span: tl.viewEndCol - tl.viewStartCol, count: tl.newestSeq - tl.oldestSeq + 1 };
  });
  expect(result.following).toBe(true);
  expect(result.span).toBeCloseTo(result.count, 4);
  await expect(page.getByTestId('time-window-All')).toHaveAttribute('aria-pressed', 'true');
});
