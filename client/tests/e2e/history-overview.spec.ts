import { expect, test, type Page } from '@playwright/test';
import type { OverviewSurface } from '../../src/gl/overviewSurface';
import type { PriceScale } from '../../src/gl/priceScale';

interface ObservedHistoryRequest { count: number; start?: number; end?: number; stride?: number;
  started?: number; elapsed?: number; depths?: number; bars?: number; first?: number; last?: number; error?: string }
type WorkTiming = { count: number; total: number; max: number };
type RequestWindow = Window & { __overviewHistoryRequests: ObservedHistoryRequest[];
  __overviewWork?: Record<string, WorkTiming> };
interface InspectableRenderer { camera: { priceScale: PriceScale }; overviewSurface: OverviewSurface }

const RAW_BUDGET = 512;
const OVERRUN = RAW_BUDGET * 3;

/** Copy only the production GL canvas. GL overlays are disabled so a BBO line
 * or trade bubble cannot make an empty history band pass this assertion. */
async function heatmapThirds(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const canvas = document.querySelector<HTMLCanvasElement>('canvas#gl')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const counts = [0, 0, 0];
    for (let y = 0; y < copy.height; y++) {
      for (let x = 0; x < copy.width; x++) {
        const i = (y * copy.width + x) * 4;
        if (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] > 25) {
          counts[Math.min(2, Math.floor(x * 3 / copy.width))]++;
        }
      }
    }
    return counts;
  });
}

async function waitForOverview(page: Page, minimumBuckets = 30): Promise<void> {
  const started = Date.now();
  try { await page.waitForFunction((minimum) => {
    const renderer = window.__flowmapLive?.renderer;
    const stats = renderer?.overviewStats();
    if (!renderer || !stats) return false;
    const view = renderer.viewSnapshot;
    const stride = 2 ** Math.max(0, Math.ceil(Math.log2(view.colScale / 480)));
    const lo = Math.max(0, Math.floor(view.colOffset / stride));
    const hi = Math.min(Math.floor(renderer.newestColSeq / stride), Math.ceil((view.colOffset + view.colScale) / stride) - 1);
    const plan = (renderer as unknown as { overviewHistory: { range: { stride: number; lo: number; hi: number } } }).overviewHistory?.range;
    return plan?.stride === stride && plan.lo === lo && plan.hi === hi &&
      !stats.inFlight && stats.error === null && stats.buckets >= minimum && stats.resident &&
      stats.progress.loaded === stats.progress.total;
  }, minimumBuckets, { timeout: 45_000 }); } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const live = window.__flowmapLive!;
      const r = live.renderer, s = live.store.getState();
      const inspect = r as unknown as { priceEpoch: number; overviewEpoch: number; awaitingSession: boolean;
        overviewHistory: { generation: number; range: unknown; progress: unknown; error: unknown; loaded: Set<number>; present: Set<number> } | null };
      const h = inspect.overviewHistory;
      return { view: r.viewSnapshot, timeline: r.timeline(), stats: r.stats(), newest: r.newestColSeq,
        raw: r.residentRange(), rawHistory: r.historyStats(), overview: r.overviewStats(),
        overviewEpoch: inspect.overviewEpoch, priceEpoch: inspect.priceEpoch, awaitingSession: inspect.awaitingSession,
        timeWindow: r.timeWindowMs, ready: r.marketFrameReady,
        session: s.sessionId, subscription: s.subscription, status: s.status, gridEpoch: s.gridEpoch,
        epochs: [...s.epochs.values()], loader: h && { generation: h.generation, range: h.range, progress: h.progress,
          loaded: [...h.loaded].sort((a, b) => a - b), present: [...h.present].sort((a, b) => a - b), error: h.error },
        requests: (window as RequestWindow).__overviewHistoryRequests, work: (window as RequestWindow).__overviewWork };
    });
    console.log('overview timeout diagnostics', JSON.stringify(diagnostics, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    throw error;
  }
  console.log('overview load completed', JSON.stringify({ elapsed: Date.now() - started, ...await page.evaluate(() => {
    const r = window.__flowmapLive!.renderer;
    return { overview: r.overviewStats(), raw: r.historyStats(), stats: r.stats(), view: r.viewSnapshot,
      requests: (window as RequestWindow).__overviewHistoryRequests.slice(-8), work: (window as RequestWindow).__overviewWork };
  }) }));
  await expect.poll(async () => Math.min(...await heatmapThirds(page)), { timeout: 20_000 }).toBeGreaterThan(100);
}

test('whole history uses bounded coarse detail without cutting time, price or old heatmap', async ({ page }) => {
  test.setTimeout(210_000);
  const errors: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('history overview navigation', frame.url()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('flowmap.active-symbol.v1', JSON.stringify({ market: 'sim', symbol: 'SIM-DEMO' }));
  });
  await page.goto(`/?scrollback=1&budget=${RAW_BUDGET}`);
  await page.waitForFunction((overrun) => {
    const live = window.__flowmapLive;
    return live?.store.getState().subscription?.market === 'sim' && live.renderer.marketFrameReady &&
      live.renderer.newestColSeq >= overrun && live.renderer.residentBudgetCols === 512;
  }, OVERRUN, { timeout: 120_000 });

  const before = await page.evaluate(async () => {
    // Time production calls without changing their work or upload/yield limits.
    // @ts-expect-error Vite production module
    const { OverviewSurface } = await import('/src/gl/overviewSurface.ts');
    // @ts-expect-error Vite production module
    const { OverviewHistory } = await import('/src/net/overviewHistory.ts');
    const work: Record<string, WorkTiming> = Object.fromEntries(['column', 'draw', 'page', 'yield'].map(key => [key, { count: 0, total: 0, max: 0 }]));
    (window as RequestWindow).__overviewWork = work;
    const record = (key: string, start: number) => {
      const duration = performance.now() - start, timing = work[key];
      timing.count++; timing.total += duration; timing.max = Math.max(timing.max, duration);
    };
    const surfacePrototype = OverviewSurface.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const key of ['column', 'draw', 'page']) {
      const originalCall = surfacePrototype[key];
      surfacePrototype[key] = function (...args: unknown[]) {
        const start = performance.now();
        try { return originalCall.apply(this, args); } finally { record(key, start); }
      };
    }
    const originalEnsure = OverviewHistory.prototype.ensure;
    const timed = new WeakSet();
    OverviewHistory.prototype.ensure = function (...args: unknown[]) {
      if (!timed.has(this)) {
        timed.add(this);
        const deps = (this as unknown as { deps: { yieldToFrame: () => Promise<void> } }).deps;
        const originalYield = deps.yieldToFrame;
        deps.yieldToFrame = async () => { const start = performance.now(); await originalYield(); record('yield', start); };
      }
      return originalEnsure.apply(this, args);
    };
    const { renderer, store } = window.__flowmapLive!;
    const state = store.getState();
    const original = state.requestHistory;
    const requests: ObservedHistoryRequest[] = [];
    (window as RequestWindow).__overviewHistoryRequests = requests;
    store.setState({ requestHistory: (time, count, overview) => {
      const record: ObservedHistoryRequest = { count, start: overview?.start_col, end: overview?.end_col,
        stride: overview?.stride, started: performance.now() };
      requests.push(record);
      return original(time, count, overview).then(response => {
        Object.assign(record, { elapsed: performance.now() - record.started!, depths: response.depth_cols.length,
          bars: response.bar_cols.length, first: response.depth_cols[0]?.col_seq, last: response.depth_cols.at(-1)?.col_seq });
        return response;
      }, error => { record.elapsed = performance.now() - record.started!; record.error = String(error); throw error; });
    } });
    renderer.setFollowTime(false);
    renderer.setOverlayVisibility({ bubbles: false, bbo: false, vwap: false, profile: false, markers: false, gex: false });
    renderer.setTolerance(0);
    renderer.setTimeWindowMs(null);
    return { range: renderer.residentRange(), newest: renderer.newestColSeq, session: state.sessionId };
  });
  expect(before.range!.oldest).toBeGreaterThan(0);
  await waitForOverview(page);

  const whole = await page.evaluate(async () => {
    // @ts-expect-error Vite production module
    const { rowToPrice } = await import('/src/gl/priceScale.ts');
    const renderer = window.__flowmapLive!.renderer;
    const view = renderer.viewSnapshot;
    // Production class fields are reachable through the existing e2e hook;
    // inspect exact coarse OHLC rather than guessing a readable price span.
    const surface = (renderer as unknown as InspectableRenderer).overviewSurface;
    const scale = (renderer as unknown as InspectableRenderer).camera.priceScale;
    const extrema = surface.bars.price.priceRange(Math.floor(view.colOffset / surface.stride), Math.ceil((view.colOffset + view.colScale) / surface.stride));
    const cvd = renderer.cvdSeries(view.colOffset, view.colOffset + view.colScale);
    const volume = document.querySelector<HTMLCanvasElement>('canvas.overlay-volume')!;
    const pixels = volume.getContext('2d')!.getImageData(0, 0, volume.width, volume.height).data;
    let coloredVolume = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i] > 80 && pixels[i] > pixels[i + 1] * 1.3) || (pixels[i + 1] > 80 && pixels[i + 1] > pixels[i] * 1.3)) coloredVolume++;
    }
    const physicalFrame = { low: rowToPrice(scale, view.rowOffset), high: rowToPrice(scale, view.rowOffset + view.rowScale) };
    return { view, overview: renderer.overviewStats(), raw: renderer.residentRange(), cvd, extrema, physicalFrame,
      coloredVolume, requests: (window as RequestWindow).__overviewHistoryRequests };
  });
  expect(whole.view.colOffset).toBeLessThanOrEqual(0.01);
  expect(whole.view.colScale).toBeGreaterThanOrEqual(before.newest + 1);
  expect(whole.view.colScale).toBeGreaterThan(RAW_BUDGET * 2);
  expect(whole.overview!.capacity).toBe(512);
  expect(whole.overview!.resident!.count).toBeLessThanOrEqual(512);
  expect(whole.overview!.buckets).toBeLessThanOrEqual(512);
  expect(whole.raw!.count).toBeLessThanOrEqual(RAW_BUDGET);
  expect(whole.requests.some((request: { start?: number; stride?: number }) => request.start === 0 && request.stride! > 1)).toBe(true);
  expect(whole.cvd.length).toBeGreaterThan(30);
  expect(whole.cvd.every(point => Number.isFinite(point.cvd))).toBe(true);
  expect(whole.cvd[0].col).toBeLessThan(before.range!.oldest);
  expect(whole.cvd.at(-1)!.col).toBeGreaterThan(before.newest * 0.8);
  expect(whole.coloredVolume).toBeGreaterThan(100);
  expect(whole.extrema).not.toBeNull();
  expect(whole.physicalFrame).not.toBeNull();
  expect(whole.physicalFrame!.low).toBeLessThanOrEqual(whole.extrema.low);
  expect(whole.physicalFrame!.high).toBeGreaterThanOrEqual(whole.extrema.high);

  for (const tolerance of [0, 50, 90]) {
    await page.evaluate(value => window.__flowmapLive!.renderer.setTolerance(value), tolerance);
    await expect.poll(async () => Math.min(...await heatmapThirds(page)), { timeout: 15_000,
      message: `tolerance ${tolerance} must retain genuine heatmap in every historical third` }).toBeGreaterThan(100);
  }

  const manualPrice = await page.evaluate(async () => {
    // @ts-expect-error Vite production module
    const { rowToPrice } = await import('/src/gl/priceScale.ts');
    const renderer = window.__flowmapLive!.renderer;
    const scale = (renderer as unknown as InspectableRenderer).camera.priceScale;
    const initial = renderer.viewSnapshot;
    const before = rowToPrice(scale, initial.rowOffset + initial.rowScale) - rowToPrice(scale, initial.rowOffset);
    renderer.zoomPriceForTest(5);
    const after = renderer.viewSnapshot;
    return { before, after: rowToPrice(scale, after.rowOffset + after.rowScale) - rowToPrice(scale, after.rowOffset) };
  });
  expect(manualPrice.after / manualPrice.before).toBeCloseTo(5, 5);
  await page.getByTestId('desk-fit').click();
  await waitForOverview(page);
  const fitted = await page.evaluate(async () => {
    // @ts-expect-error Vite production module
    const { rowToPrice } = await import('/src/gl/priceScale.ts');
    const renderer = window.__flowmapLive!.renderer, view = renderer.viewSnapshot;
    const scale = (renderer as unknown as InspectableRenderer).camera.priceScale;
    return rowToPrice(scale, view.rowOffset + view.rowScale) - rowToPrice(scale, view.rowOffset);
  });
  expect(fitted).toBeLessThan(manualPrice.after * 0.8);

  // Return to real full-resolution history, wholly before the original cache.
  const rawRequestStart = await page.evaluate(() => {
    const renderer = window.__flowmapLive!.renderer;
    const view = renderer.viewSnapshot;
    const requestStart = (window as RequestWindow).__overviewHistoryRequests.length;
    renderer.setViewForTest(64, 256, view.rowOffset, view.rowScale);
    renderer.setTolerance(0);
    return requestStart;
  });
  await page.waitForFunction(() => window.__flowmapLive!.renderer.isResidentFullRes(64) &&
    window.__flowmapLive!.renderer.isResidentFullRes(319), undefined, { timeout: 30_000 });
  expect(Math.min(...await heatmapThirds(page))).toBeGreaterThan(100);
  const oldView = await page.evaluate(() => window.__flowmapLive!.renderer.viewSnapshot);
  expect(oldView.colScale).toBe(256);
  const rawRequests = await page.evaluate(start =>
    (window as RequestWindow).__overviewHistoryRequests.slice(start).filter(request => request.stride === 1), rawRequestStart);
  expect(rawRequests.length).toBeGreaterThan(0);
  expect(rawRequests.length, 'A distant view must load only its own bounded pages').toBeLessThanOrEqual(20);
  expect(rawRequests[0].end, 'The first page must land directly at the chosen old view').toBe(319);
  expect(rawRequests.every(request => request.start! >= 32 && request.end! <= 319)).toBe(true);

  await page.getByTestId('desk-fit').click();
  await waitForOverview(page);
  const restoredBefore = await page.evaluate(() => {
    const renderer = window.__flowmapLive!.renderer;
    const count = renderer.contextRestoredCount, view = renderer.viewSnapshot;
    renderer.loseContextForTest();
    return { count, view };
  });
  await page.waitForFunction(() => window.__flowmapLive!.renderer.contextLostCount > 0);
  await page.evaluate(() => window.__flowmapLive!.renderer.restoreContextForTest());
  await page.waitForFunction(previous => window.__flowmapLive!.renderer.contextRestoredCount > previous, restoredBefore.count);
  const restoredView = await page.evaluate(() => window.__flowmapLive!.renderer.viewSnapshot);
  expect(restoredView.colScale, 'context restoration must preserve the full history span').toBeCloseTo(restoredBefore.view.colScale, 6);
  expect(restoredView.colOffset, 'context restoration must preserve the historical time frame').toBeCloseTo(restoredBefore.view.colOffset, 6);
  await waitForOverview(page);

  await page.evaluate(() => window.__flowmapLive!.store.getState().connectAndSubscribe('sim', 'OVERVIEW-RESET'));
  await page.waitForFunction(previous => {
    const live = window.__flowmapLive!;
    return live.store.getState().subscription?.symbol === 'OVERVIEW-RESET' &&
      live.store.getState().sessionId !== previous && live.renderer.marketFrameReady && live.renderer.newestColSeq > 8;
  }, before.session, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__flowmapLive!.renderer.overviewStats())).toBeNull();
  expect(errors, errors.join(' | ')).toEqual([]);
});
