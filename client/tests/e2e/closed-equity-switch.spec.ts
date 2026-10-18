import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test';

const directory: { crypto_market: string; crypto_symbols: string[]; equity_tickers: string[] } =
  JSON.parse(readFileSync(new URL('../../../server/src/flowmap_server/data/universe.json', import.meta.url), 'utf8'));

// Ordinary App + real Connection/decoder/startup gate. Only the transport's
// server side is deterministic; no renderer/store data-injection path is used.
const SUNDAY = Date.parse('2026-10-18T15:30:00Z');
const FRIDAY = BigInt(Date.parse('2026-10-16T19:00:00Z')) * 1_000_000n;
const MINUTE = 60_000_000_000n;
const EQUITY_CAP = { depth: 'SYNTH', tape: 'poll', trade_side: 'na', vwap: 'approx',
  markers: ['gap', 'session_break'] };
const CRYPTO_CAP = { depth: 'L2', tape: 'tick', trade_side: 'exchange', vwap: 'exact' };

function frame(type: number, payload: Buffer, flags = 0): Buffer {
  const out = Buffer.alloc(8 + ((payload.length + 3) & ~3));
  out.writeUInt8(type, 0); out.writeUInt8(1, 1);
  out.writeUInt16LE(flags, 2); out.writeUInt32LE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}

function cold(type: number, value: unknown): Buffer {
  return frame(type, Buffer.from(JSON.stringify(value)), 1);
}

function closeAt(col: number, equity: boolean): number {
  return equity ? 343.2 + Math.sin(col * .22) * .6 + col * .015
    : 81_000 + Math.sin(col * .22) * 80 + col * 2;
}

function origin(equity: boolean): bigint {
  return equity ? FRIDAY : BigInt(SUNDAY - 60_000) * 1_000_000n;
}

function interval(equity: boolean): bigint { return equity ? MINUTE : 250_000_000n; }

function epoch(equity: boolean) {
  return { epoch: 0, tick: equity ? .25 : 100, tick_multiple: 1,
    dt_ns: Number(interval(equity)), p0: equity ? 338 : 79_000, rows: equity ? 64 : 32 };
}

function column(col: number, equity: boolean): Buffer {
  const params = epoch(equity);
  const payload = Buffer.alloc(24 + params.rows * 8);
  payload.writeUInt32LE(0, 0); payload.writeUInt32LE(col, 4);
  payload.writeBigInt64LE(origin(equity) + BigInt(col) * interval(equity), 8);
  payload.writeUInt8(equity ? 1 : 0, 16); // SYNTH's two-sided display profile / L2
  payload.writeUInt8(1, 17); payload.writeUInt32LE(params.rows, 20);
  const mid = Math.round((closeAt(col, equity) - params.p0) / params.tick);
  for (let row = 0; row < params.rows; row++) {
    const size = Math.max(0, 40 - Math.abs(row - mid) * 7);
    payload.writeFloatLE(row <= mid ? size : 0, 24 + row * 4);
    payload.writeFloatLE(row > mid ? size : 0, 24 + params.rows * 4 + row * 4);
  }
  return frame(3, payload);
}

function bar(col: number, equity: boolean): Buffer {
  const payload = Buffer.alloc(88);
  payload.writeUInt32LE(0, 0); payload.writeUInt32LE(col, 4);
  payload.writeBigInt64LE(origin(equity) + BigInt(col) * interval(equity), 8);
  const close = closeAt(col, equity), delta = equity ? .05 : 5;
  // Real historical OHLC observations are chart input, not fabricated exchange
  // prints: unknown aggressor volumes/CVD remain zero and no Trade is emitted.
  [close - delta, close + delta, close - delta * 2, close, 0, 0, 0, close * (col + 1), col + 1]
    .forEach((value, index) => payload.writeDoubleLE(value, 16 + index * 8));
  return frame(4, payload);
}

function snapshot(id: string, equity: boolean, columns = 60): Buffer {
  const params = epoch(equity), capability = equity ? EQUITY_CAP : CRYPTO_CAP;
  const parts = [cold(1, { protocol_version: 1, session_id: id, grid_epoch: 0,
    epoch_params: params, capability, norm_seed: 25 }),
  cold(2, { epoch: 0, epoch_params: params })];
  for (let col = 0; col < columns; col++) parts.push(column(col, equity), bar(col, equity));
  parts.push(cold(8, { feed_state: equity ? 'closed' : 'live', capability,
    next_open_ts: equity ? Date.parse('2026-10-19T13:30:00Z') * 1e6 : null,
    latency_ms: null, clock_skew_ms: null }));
  return Buffer.concat(parts);
}

async function fixture(page: Page, market: 'equity' | 'binance-spot', emptyHistory = false) {
  await page.clock.setFixedTime(SUNDAY);
  await page.addInitScript(({ market }) => {
    localStorage.setItem('flowmap.active-symbol.v1', JSON.stringify({ market,
      symbol: market === 'equity' ? 'AAPL' : 'BTCUSDT' }));
    localStorage.setItem('flowmap.settings.v1', JSON.stringify({ settingsVersion: 2,
      historyDepth: 'off', overlays: { price: true, axes: false, bubbles: false,
        bbo: false, vwap: false, profile: false, markers: false, cvd: false,
        volume: false, gex: false } }));
  }, { market });
  let socket: WebSocketRoute;
  let subscriptions = 0;
  let delayed = false;
  let pending: { equity: boolean; id: string } | null = null;
  let staleDelivered: (() => void) | null = null;
  await page.routeWebSocket(/\/ws$/, ws => {
    socket = ws;
    ws.onMessage(data => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (bytes[0] === 0x40) {
        const sub = JSON.parse(bytes.subarray(8, 8 + bytes.readUInt32LE(4)).toString());
        const equity = sub.market === 'equity', id = `fixture-${++subscriptions}-${sub.symbol}`;
        if (delayed) pending = { equity, id };
        else ws.send(snapshot(id, equity, emptyHistory ? 0 : 60));
      } else if (bytes[0] === 0x47) {
        staleDelivered?.(); staleDelivered = null;
      } else if (bytes[0] === 0x46) {
        // History is exhausted beyond this fixture; no network/default sim can
        // inject a different market into the deterministic closed session.
        const request = JSON.parse(bytes.subarray(8, 8 + bytes.readUInt32LE(4)).toString());
        const header = Buffer.alloc(24);
        header.writeUInt32LE(request.req_id, 0); header.writeBigInt64LE(FRIDAY, 8);
        ws.send(frame(0x0a, header));
      }
    });
  });
  await page.goto('/');
  return {
    delay() { delayed = true; },
    pending() { return pending; },
    stale(equity: boolean) {
      const acknowledged = new Promise<void>(resolve => { staleDelivered = resolve; });
      const ping = Buffer.alloc(8); ping.writeBigInt64LE(123n);
      socket.send(Buffer.concat([column(900, equity), bar(900, equity), frame(9, ping)]));
      return acknowledged; // Pong proves the preceding stale frames were routed.
    },
    release() { if (!pending) throw new Error('No pending subscription');
      socket.send(snapshot(pending.id, pending.equity)); pending = null; delayed = false; },
  };
}

async function ready(page: Page, market: string): Promise<void> {
  await page.waitForFunction(market => {
    const live = window.__flowmapLive;
    return live?.store.getState().subscription?.market === market
      && live.renderer.marketFrameReady && live.renderer.timeline()?.newestSeq === 59;
  }, market);
  await expect(page.getByTestId('chart-startup-gate')).toBeHidden();
}

async function lineProbe(page: Page, equity: boolean) {
  return page.evaluate(({ equity, start, step, prices }) => {
    const renderer = window.__flowmapLive!.renderer;
    renderer.snapshot();
    const canvas = document.querySelector('.overlay-text') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!, dpr = canvas.width / canvas.clientWidth;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const probes = [3, 16, 33, 47, 59].map(col => {
      const point = renderer.overlayPointCss(BigInt(start) + BigInt(col) * BigInt(step), prices[col])!;
      const x = Math.round(point.x * dpr), y = Math.round(point.y * dpr);
      let ink = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        if (x + dx < 0 || x + dx >= canvas.width || y + dy < 0 || y + dy >= canvas.height) continue;
        if (pixels[((y + dy) * canvas.width + x + dx) * 4 + 3] > 32) ink++;
      }
      return { col, x: point.x, y: point.y, ink,
        visible: point.x > 0 && point.x < canvas.clientWidth && point.y > 0 && point.y < canvas.clientHeight };
    });
    return { equity, probes, first: renderer.timestampAtColumn(0)?.toString(),
      last: renderer.timestampAtColumn(59)?.toString(),
      feed: window.__flowmapLive!.store.getState().feedState,
      capability: window.__flowmapLive!.store.getState().capability,
      effectiveBbo: renderer.overlayEffectiveBboForTest(),
      tape: window.__flowmapLive!.bookStore.getSnapshot().trades.length };
  }, { equity, start: origin(equity).toString(), step: interval(equity).toString(),
    prices: Array.from({ length: 60 }, (_, col) => closeAt(col, equity)) });
}

test('closed equity opens Friday historical prices on Sunday without waiting for a live print', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page, 'equity');
  await ready(page, 'equity');
  const result = await lineProbe(page, true);
  expect(result.first).toBe(FRIDAY.toString());
  expect(result.last).toBe((FRIDAY + 59n * MINUTE).toString());
  expect(result.feed).toBe('closed');
  expect(result.capability).toMatchObject(EQUITY_CAP);
  expect(result.effectiveBbo, 'no fabricated NBBO from synthetic profile').toBeNull();
  expect(result.tape, 'historical bars are not current exchange prints').toBe(0);
  for (const probe of result.probes) {
    expect(probe.visible, `historical close ${probe.col}, including final tail, is in view`).toBe(true);
    expect(probe.ink, `price polyline actually paints historical close ${probe.col}`).toBeGreaterThan(3);
  }
  await expect(page.getByTestId('closed-banner')).toBeVisible();
  await expect(page.getByTestId('tape-badge')).toHaveText('TAPE POLL');
  // Prove the probes see price ink, rather than some unrelated chart overlay.
  await page.evaluate(() => window.__flowmapLive!.renderer.setOverlayVisibility({ price: false }));
  const hidden = await lineProbe(page, true);
  expect(hidden.probes.every(probe => probe.ink === 0)).toBe(true);
  await page.evaluate(() => window.__flowmapLive!.renderer.setOverlayVisibility({ price: true }));
  expect((await lineProbe(page, true)).probes.every(probe => probe.ink > 3)).toBe(true);
  expect(errors).toEqual([]);
});

test('closed equity with no provider or recorded history displays a completed unavailable result', async ({ page }) => {
  await fixture(page, 'equity', true);
  const gate = page.getByTestId('chart-startup-gate');
  await expect(gate).toContainText('Historical data unavailable');
  await expect(gate).toContainText('No recorded or provider history is available. Choose another symbol or try again.');
  await expect(gate.locator('.chart-startup__mark')).toHaveCount(0);
  expect(await page.evaluate(() => window.__flowmapLive!.renderer.residentRange())).toBeNull();
  await expect(page.getByTestId('market-last')).toHaveText('—');
  await expect(page.getByTestId('tape-row')).toHaveCount(0);
});

test('crypto and closed equity switch without stale price or timeline during delayed handshakes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const transport = await fixture(page, 'binance-spot');
  await ready(page, 'binance-spot');
  for (const market of ['equity', 'binance-spot'] as const) {
    transport.delay();
    await page.evaluate(market => window.__flowmapLive!.store.getState().connectAndSubscribe(
      market, market === 'equity' ? 'AAPL' : 'BTCUSDT', 'live', 'native'), market);
    await expect.poll(() => transport.pending()?.equity).toBe(market === 'equity');
    // Old in-flight depth/bar packets arriving BEFORE the replacement Hello
    // must not recreate a chart with the old source's price or timestamp.
    await transport.stale(market !== 'equity');
    await expect(page.getByTestId('chart-startup-gate')).toBeVisible();
    expect(await page.evaluate(() => ({ range: window.__flowmapLive!.renderer.residentRange(),
      time: window.__flowmapLive!.renderer.timeline(),
      ready: window.__flowmapLive!.renderer.marketFrameReady })))
      .toEqual({ range: null, time: null, ready: false });
    transport.release();
    await ready(page, market);
    const equity = market === 'equity', result = await lineProbe(page, equity);
    expect(result.first).toBe(origin(equity).toString());
    // Renderer timestamp knots use Float64 ns, whose ULP is 256 ns in 2026.
    // The retained historical clock must be correct to that representation.
    expect(Math.abs(Number(BigInt(result.last!) - origin(equity) - 59n * interval(equity))))
      .toBeLessThanOrEqual(256);
    expect(result.probes.every(probe => probe.visible && probe.ink > 3)).toBe(true);
    expect(result.capability).toMatchObject(equity ? EQUITY_CAP : CRYPTO_CAP);
    await expect(page.getByTestId('closed-banner')).toHaveCount(equity ? 1 : 0);
  }
  expect(errors).toEqual([]);
});

test('first All markets open paints the complete selectable directory before any provider answers', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const held: Route[] = [];
  await page.route(/\/api\/(?:universe|movers|venues|quote)(?:\?|$)/, route => { held.push(route); });
  await page.addInitScript(() => localStorage.setItem('flowmap.recents', JSON.stringify([
    'binance-spot:SANDUSDT', 'binance-spot:BTCUSDT', 'equity:AAPL',
  ])));
  await fixture(page, 'binance-spot');
  await ready(page, 'binance-spot');
  const expectedKeys = new Set([...directory.crypto_symbols.map(symbol => `${directory.crypto_market}:${symbol}`),
    ...directory.equity_tickers.map(symbol => `equity:${symbol}`),
    'binance-spot:SANDUSDT', 'binance-spot:BTCUSDT', 'equity:AAPL']);
  const firstPaint = await page.evaluate(() => new Promise<{ elapsedMs: number; keys: string[] }>(resolve => {
    const start = performance.now();
    (document.querySelector('[data-testid="symbol-search-trigger"]') as HTMLButtonElement).click();
    requestAnimationFrame(() => resolve({ elapsedMs: performance.now() - start,
      keys: Array.from(document.querySelectorAll('[data-testid="symbol-row"]'), row =>
        `${row.getAttribute('data-market')}:${row.getAttribute('data-symbol')}`) }));
  }));
  expect(new Set(firstPaint.keys), 'every bundled symbol is present on the first painted frame')
    .toEqual(expectedKeys);
  expect(firstPaint.keys.length, 'recent entries do not duplicate directory rows').toBe(expectedKeys.size);
  // First-frame completeness while every provider is held is the causal gate.
  // Keep timing as evidence; software GL and concurrent builds can delay rAF
  // without introducing a dependency on any provider response.
  await testInfo.attach('first-open-directory.json', { body: JSON.stringify(firstPaint, null, 2), contentType: 'application/json' });
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(4);
  const input = page.getByTestId('symbol-search-input');
  await input.press('End');
  await expect(page.getByTestId('symbol-row').last()).toBeInViewport();
  await input.fill('AAPL');
  await expect(page.locator('[data-testid="symbol-row"][data-market="equity"][data-symbol="AAPL"]')).toBeVisible();
  await input.press('Enter');
  await expect(page.getByTestId('symbol-search-input')).toHaveCount(0);
  await ready(page, 'equity');
  expect((await lineProbe(page, true)).probes.every(probe => probe.visible && probe.ink > 3)).toBe(true);
  // All HTTP enrichments remained unresolved through browsing AND selection.
  // Cancelling them now avoids leaving artificial requests beyond this test.
  await Promise.allSettled(held.map(route => route.abort()));
  expect(errors).toEqual([]);
});
