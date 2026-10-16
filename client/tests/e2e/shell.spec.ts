import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import {
  controls, expectEmptyPickerAndCancel, expectLiveUnchanged,
  openRecordedReplayPicker, seedReplayLocale, sessionSnapshot,
} from './replayPicker';

/**
 * T12 verification — the UI shell (§9) over the real server (playwright.config's
 * webServer boots flowmap-server + vite). The page loads with `?spy=1`, which
 * installs a control tap: every outbound control frame is decoded into
 * `window.__flowmapControls`, so the specs assert the EXACT messages the transport
 * sends (Subscribe / Unsubscribe / SetSpeed / Pause / Resume / Seek) rather than
 * relying on an un-exercised replay data source.
 *
 * Covered: the shell renders as a trading terminal (screenshot artifact); symbol
 * search queries /api/symbols and switching a symbol re-subscribes; the live/replay
 * toggle + play/pause + speed + seek send the correct control messages; settings
 * persist across a reload; Space + `/` keyboard work.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// MsgType wire tags (proto/types MsgType) for the client→server control frames.
const SUBSCRIBE = 0x40;
const UNSUBSCRIBE = 0x41;
const SEEK = 0x42;
const SET_SPEED = 0x43;
const PAUSE = 0x44;
const RESUME = 0x45;

const storeState = (page: Page): Promise<any> =>
  page.evaluate(() => (window as unknown as { __flowmapLive: any }).__flowmapLive.store.getState());

interface ReplayStoreState {
  status: string;
  sessionId: string | null;
  subscription: { mode: string } | null;
  paused: boolean;
  speed: number;
  replayPlayback: {
    startNs: bigint; endNs: bigint; columns: number; paused: boolean;
    speed: number; ended: boolean; generation: number;
  } | null;
}

/** Narrow replay metadata only; bigint bounds cross the browser boundary as strings. */
const replayState = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as { __flowmapLive: { store: {
    getState(): ReplayStoreState;
  } } }).__flowmapLive.store.getState();
  const p = state.replayPlayback;
  return {
    status: state.status, sessionId: state.sessionId, paused: state.paused, speed: state.speed,
    playback: p && {
      startNs: p.startNs.toString(), endNs: p.endNs.toString(), columns: p.columns,
      paused: p.paused, speed: p.speed, ended: p.ended,
    },
  };
});

async function bootLive(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  // Campaign-4: the first-run onboarding card's full-viewport scrim intercepts
  // the first pointer click in every fresh Playwright context. Seed the
  // dismissal flag (ui/OnboardingCard ONBOARDING_KEY) before boot so these
  // shell specs exercise the shell, not the onboarding card.
  await page.addInitScript(() => localStorage.setItem('flowmap.onboarded', '1'));
  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!live && live.store.getState().status === 'live';
    },
    undefined,
    { timeout: 45_000 },
  );
  return consoleErrors;
}

test('shell renders as a trading terminal + screenshot', async ({ page }) => {
  const errors = await bootLive(page);

  // The core chrome is present and framed around the heatmap.
  await expect(page.locator('.topbar')).toBeVisible();
  // Search is a centred palette now: the top bar shows a trigger; the input
  // exists once the palette is opened.
  await expect(page.locator('[data-testid="symbol-search-trigger"]')).toBeVisible();
  await expect(page.locator('[data-testid="venue"]')).toContainText('Sim');
  await expect(page.locator('[data-testid="capability-badges"]')).toBeVisible();
  await expect(page.locator('[data-testid="mode-toggle"]')).toBeVisible();
  await expect(page.locator('[data-testid="clock"]')).toBeVisible();
  await expect(page.locator('[data-testid="timeline"]')).toBeVisible();
  await expect(page.locator('canvas#gl')).toBeVisible();
  await expect(page.locator('[data-testid="right-rail"]')).toBeVisible();

  // Let a couple of seconds of live sim paint the heatmap for the screenshot.
  await page.waitForTimeout(1500);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'shell.png'), shot);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('symbol search queries /api/symbols and switching re-subscribes', async ({ page }) => {
  await bootLive(page);

  // Open the palette, then type a crypto query; results fuzzy-match the universe.
  await page.locator('[data-testid="symbol-search-trigger"]').click();
  await page.locator('[data-testid="symbol-search-input"]').fill('btc');
  const row = page.locator('[data-testid="symbol-row"][data-symbol="BTCUSDT"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveAttribute('data-market', 'binance-spot');

  await row.click();

  // The store swapped to the new symbol...
  await expect
    .poll(async () => (await storeState(page)).subscription?.symbol)
    .toBe('BTCUSDT');

  // ...and the transport re-subscribed: an Unsubscribe then a Subscribe(BTCUSDT).
  await expect
    .poll(async () => {
      const log = await controls(page);
      return log.some(
        (c) => c.type === SUBSCRIBE && c.symbol === 'BTCUSDT' && c.market === 'binance-spot',
      );
    })
    .toBe(true);
  const log = await controls(page);
  expect(log.some((c) => c.type === UNSUBSCRIBE)).toBe(true);
});

test('replay picker with no recordings keeps LIVE running and cancels without subscribing', async ({
  page,
}) => {
  await seedReplayLocale(page);
  await bootLive(page);
  await expectEmptyPickerAndCancel(page, await openRecordedReplayPicker(page));
});

test('replay transport controls (pause/resume/speed/seek) send the correct control messages', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedReplayLocale(page);
  await bootLive(page);
  const opened = await openRecordedReplayPicker(page);
  const { picker, availability, before } = opened;
  if (availability.hours.length === 0) {
    await expectEmptyPickerAndCancel(page, opened);
    // The existing transport limitation is explicit only AFTER the real empty
    // picker/LIVE/cancel contract passes. Failed requests or attachment never skip.
    test.skip(true, 'positive replay transport requires a recording; default Playwright webServer sets FLOWMAP_RECORDING_ENABLED=0 (empty picker/LIVE contract passed)');
    return;
  }

  const hours = picker.getByRole('combobox', { name: 'Recorded dates / hours', exact: true });
  await expect(hours).toBeVisible();
  expect(await hours.locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
  )).toEqual(availability.hours);
  expect(availability.latest_column_ns).toMatch(/^\d+$/);
  // Keep the picker's latest-anchored defaults; hour boundaries can contain gaps.
  const start = await picker.getByLabel('Start date and time (UTC)', { exact: true }).inputValue();
  const end = await picker.getByLabel('End date and time (exclusive) (UTC)', { exact: true }).inputValue();
  expect(Number.isFinite(new Date(start + 'Z').getTime())).toBe(true);
  expect(new Date(end + 'Z').getTime()).toBeGreaterThan(new Date(start + 'Z').getTime());
  const check = picker.getByRole('button', { name: 'Check interval', exact: true });
  await expect(check).toBeEnabled();
  const previewResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/recordings/window'
      && url.searchParams.get('market') === before.subscription!.market
      && url.searchParams.get('symbol') === before.subscription!.symbol;
  });
  await check.click();
  const response = await previewResponse;
  expect(response.ok(), `recording window HTTP ${response.status()}`).toBe(true);
  const requested = new URL(response.request().url()).searchParams;
  const requestedStart = requested.get('start_ns');
  const requestedEnd = requested.get('end_ns');
  expect(requestedStart).toMatch(/^\d+$/);
  expect(requestedEnd).toMatch(/^\d+$/);
  expect(BigInt(requestedEnd!)).toBeGreaterThan(BigInt(requestedStart!));
  const preview = await response.json() as { start_ns: string; end_ns: string; columns: number };
  expect(preview.columns).toBeGreaterThan(0);
  expect(BigInt(preview.end_ns)).toBeGreaterThan(BigInt(preview.start_ns));
  const actualRange = picker.getByRole('status').filter({ hasText: 'Actual recorded range (UTC):' });
  await expect(actualRange).toBeVisible();
  await expect(actualRange).toContainText('Recorded density and bars; quotes use recorded row centres. Missing intervals are not reconstructed.');
  const confirm = picker.getByRole('button', { name: 'Open paused', exact: true });
  await expect(confirm).toBeEnabled();
  await expectLiveUnchanged(page, opened);
  // Subscribe BEFORE confirmation so even a fast opening Hello/Seek pair is
  // observed. Outbound startup Seek alone does not prove its new Hello arrived.
  const startupSessions = await page.evaluateHandle(() => {
    const store = (window as unknown as { __flowmapLive: { store: {
      subscribe(listener: (state: ReplayStoreState) => void): () => void;
    } } }).__flowmapLive.store;
    const observation: {
      firstSessionId: string | null; firstGeneration: number | null;
      completedSessionId: string | null; unsubscribe: () => void;
    } = {
      firstSessionId: null, firstGeneration: null, completedSessionId: null,
      unsubscribe: () => {},
    };
    observation.unsubscribe = store.subscribe((state) => {
      const playback = state.replayPlayback;
      if (state.subscription?.mode !== 'replay' || !state.sessionId || !playback) return;
      if (observation.firstSessionId === null) {
        observation.firstSessionId = state.sessionId;
        observation.firstGeneration = playback.generation;
      } else if (state.sessionId !== observation.firstSessionId
        && playback.generation > observation.firstGeneration!) {
        observation.completedSessionId = state.sessionId;
      }
    });
    return observation;
  });
  await confirm.click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => sessionSnapshot(page)).toMatchObject({
    status: 'live', subscription: {
      ...before.subscription, mode: 'replay', startNs: requestedStart, endNs: requestedEnd,
    },
  });
  await expect.poll(async () => (await controls(page)).slice(opened.controlIndex)
    .filter((c) => c.type === SUBSCRIBE)).toEqual([expect.objectContaining({
    type: SUBSCRIBE, market: before.subscription!.market, symbol: before.subscription!.symbol,
    mode: 'replay', band: before.subscription!.band, start_t: requestedStart, end_t: requestedEnd,
  })]);
  await expect.poll(() => replayState(page)).toMatchObject({
    status: 'live', paused: true, speed: 1,
    playback: {
      startNs: preview.start_ns, endNs: preview.end_ns, columns: preview.columns,
      paused: true, speed: 1, ended: false,
    },
  });
  const attached = await replayState(page);
  expect(attached.sessionId).not.toBeNull();
  expect(attached.sessionId).not.toBe(before.sessionId);
  const playBtn = page.getByTestId('transport-play');
  await expect(playBtn).toBeEnabled();
  await expect(playBtn).toHaveAttribute('aria-label', 'play');
  await expect(playBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('transport-state')).toHaveText('REPLAY 1× PAUSED');
  await expect(page.getByTestId('transport-state')).toHaveAttribute('data-transport', 'attached');

  // First Hello automatically pauses, sets 1× and seeks to the effective start.
  // Await it before isolating the USER controls, so startup cannot satisfy them.
  await expect.poll(async () => (await controls(page)).slice(opened.controlIndex)
    .filter((c) => [PAUSE, SET_SPEED, SEEK].includes(c.type))).toEqual([
    { type: PAUSE }, { type: SET_SPEED, x: 1 }, { type: SEEK, t: preview.start_ns },
  ]);
  await expect.poll(() => startupSessions.evaluate((observation) =>
    observation.completedSessionId)).not.toBeNull();
  const startupSessionId = await startupSessions.evaluate((observation) => {
    observation.unsubscribe();
    return observation.completedSessionId;
  });
  await startupSessions.dispose();
  await expect.poll(() => replayState(page)).toMatchObject({
    sessionId: startupSessionId, status: 'live', paused: true, speed: 1,
    playback: { paused: true, speed: 1, ended: false },
  });
  const userControlIndex = (await controls(page)).length;
  await playBtn.click(); // A recorded window opens paused: the first click resumes.
  await expect.poll(async () => (await replayState(page)).paused).toBe(false);
  await expect(playBtn).toHaveAttribute('aria-label', 'pause');
  await expect(playBtn).toHaveAttribute('aria-pressed', 'true');
  await playBtn.click();
  await expect.poll(async () => (await replayState(page)).paused).toBe(true);
  await expect(playBtn).toHaveAttribute('aria-label', 'play');
  await expect(playBtn).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await controls(page)).slice(userControlIndex)
    .filter((c) => c.type === RESUME || c.type === PAUSE).map((c) => c.type))
    .toEqual([RESUME, PAUSE]);

  // Speed: ONE cycling button now exposes the whole 1–100× ladder. Step twice
  // (1→2→5) and assert the intermediate rung, so a handler that ignored the
  // live store value and emitted the same speed twice would fail here.
  const speedBtn = page.locator('[data-testid="speed-cycle"]');
  await speedBtn.click();
  await expect(speedBtn).toHaveAttribute('data-speed', '2');
  await expect.poll(async () => (await replayState(page)).speed).toBe(2);
  await speedBtn.click();
  await expect(speedBtn).toHaveAttribute('data-speed', '5');
  await expect.poll(async () => (await replayState(page)).speed).toBe(5);
  // ...and the control frames send exactly that sequence.
  await expect
    .poll(async () => (await controls(page)).slice(userControlIndex)
      .filter((c) => c.type === SET_SPEED).map((c) => c.x))
    .toEqual([2, 5]);
  await expect.poll(async () => (await replayState(page)).paused).toBe(true);

  // Seek: set the scrubber and dispatch a native input so React's onChange fires.
  const seekControlIndex = (await controls(page)).length;
  await expect(page.getByTestId('seek-scrubber')).toBeEnabled();
  const beforeSeekSessionId = (await replayState(page)).sessionId;
  expect(beforeSeekSessionId).not.toBeNull();
  await page.locator('[data-testid="seek-scrubber"]').evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '500');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // The scrub → Seek path is trailing-throttled (250 ms). Only a new Seek can
  // satisfy this assertion; the automatic opening Seek is outside the slice.
  await expect
    .poll(async () => (await controls(page)).slice(seekControlIndex).map((c) => c.type))
    .toContain(SEEK);
  const seek = (await controls(page)).slice(seekControlIndex).find((c) => c.type === SEEK);
  expect(typeof seek?.t).toBe('string');
  const midpoint = BigInt(preview.start_ns)
    + (BigInt(preview.end_ns) - BigInt(preview.start_ns)) / 2n;
  expect(seek?.t).toBe(midpoint.toString());
  await expect.poll(async () => {
    const state = await replayState(page);
    return {
      ...state,
      seekGenerationAttached: state.sessionId !== null && state.sessionId !== beforeSeekSessionId,
    };
  }).toMatchObject({
    seekGenerationAttached: true, status: 'live', paused: true, speed: 5,
    playback: { paused: true, speed: 5, ended: false },
  });
});

test('Space toggles follow and `/` focuses the symbol search', async ({ page }) => {
  await bootLive(page);

  // `/` focuses the symbol search from anywhere.
  await page.locator('canvas#gl').click();
  await page.keyboard.press('/');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('symbol-search-input');

  // Blur the input, focus the canvas, then Space toggles follow (live mode).
  await page.keyboard.press('Escape');
  await page.locator('canvas#gl').click();
  const before = await page.evaluate(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.following,
  );
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.following,
      ),
    )
    .toBe(!before);
});
