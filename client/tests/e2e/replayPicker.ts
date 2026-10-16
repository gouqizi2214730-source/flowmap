import { expect, type Locator, type Page } from '@playwright/test';

export interface ReplayControl {
  type: number;
  market?: string;
  symbol?: string;
  mode?: string;
  band?: string | null;
  start_t?: string | null;
  end_t?: string | null;
  x?: number;
  t?: string;
}

interface LiveSubscription {
  market: string;
  symbol: string;
  mode: string;
  band: string;
  startNs?: bigint | null;
  endNs?: bigint | null;
}

export const controls = (page: Page): Promise<ReplayControl[]> =>
  page.evaluate(() =>
    (window as unknown as { __flowmapControls?: ReplayControl[] }).__flowmapControls ?? [],
  );

/** Read only session identity, converting window bounds to serializable ns. */
export const sessionSnapshot = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as {
      __flowmapLive: { store: { getState(): {
        status: string; sessionId: string | null; subscription: LiveSubscription | null;
      } } };
    }).__flowmapLive.store.getState();
    const sub = state.subscription;
    return {
      status: state.status,
      sessionId: state.sessionId,
      subscription: sub && {
        market: sub.market, symbol: sub.symbol, mode: sub.mode, band: sub.band,
        startNs: sub.startNs?.toString() ?? null, endNs: sub.endNs?.toString() ?? null,
      },
    };
  });

const newestSequence = (page: Page): Promise<number> =>
  page.evaluate(() =>
    (window as unknown as { __flowmapLive: { renderer: { newestColSeq: number } } })
      .__flowmapLive.renderer.newestColSeq,
  );

export interface RecordingAvailability {
  hours: string[];
  latest_column_ns: string | null;
  max_columns: number;
}

interface OpenPicker {
  picker: Locator;
  availability: RecordingAvailability;
  before: Awaited<ReturnType<typeof sessionSnapshot>>;
  controlIndex: number;
}

/** Replay labels are asserted in EN; do not affect unrelated locale scenarios. */
export async function seedReplayLocale(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('flowmap.locale', 'en'));
}

export async function expectLiveUnchanged(page: Page, opened: OpenPicker): Promise<void> {
  expect(await sessionSnapshot(page)).toEqual(opened.before);
  await expect(page.getByTestId('mode-live')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mode-replay')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('replay-unavailable')).toHaveCount(0);
  // Opening/cancelling the picker must not replace or re-subscribe the LIVE feed.
  expect((await controls(page)).slice(opened.controlIndex)
    .filter((c) => c.type === 0x40 || c.type === 0x41)).toEqual([]);
}

/** Open the real picker, await its successful availability response, retain LIVE. */
export async function openRecordedReplayPicker(page: Page): Promise<OpenPicker> {
  const before = await sessionSnapshot(page);
  expect(before.status).toBe('live');
  expect(before.sessionId).not.toBeNull();
  expect(before.subscription?.mode).toBe('live');
  const sub = before.subscription!;
  const log = await controls(page);
  expect(log.some((c) => c.type === 0x40 && c.mode === 'live'
    && c.market === sub.market && c.symbol === sub.symbol && c.band === sub.band)).toBe(true);
  await expect.poll(() => newestSequence(page)).toBeGreaterThanOrEqual(0);
  const controlIndex = log.length;
  const availabilityResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/recordings/availability'
      && url.searchParams.get('market') === sub.market
      && url.searchParams.get('symbol') === sub.symbol;
  });
  await page.getByTestId('mode-replay').click();
  const response = await availabilityResponse;
  expect(response.ok(), `recording availability HTTP ${response.status()}`).toBe(true);
  const availability = await response.json() as RecordingAvailability;
  expect(Array.isArray(availability.hours)).toBe(true);
  const picker = page.locator('[role="dialog"][aria-labelledby="replay-picker-title"]');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('heading', {
    name: `Recorded replay · ${sub.market} / ${sub.symbol}`, exact: true,
  })).toBeVisible();
  await expect(picker.getByText('Loading recording information…', { exact: true })).toHaveCount(0);
  const opened = { picker, availability, before, controlIndex };
  await expectLiveUnchanged(page, opened);
  // Baseline only after the loaded picker is visible: pre-mount columns cannot
  // satisfy the proof that LIVE continues while the picker remains open.
  const newestWhileOpen = await newestSequence(page);
  await expect.poll(async () => {
    await expect(picker).toBeVisible();
    return newestSequence(page);
  }).toBeGreaterThan(newestWhileOpen);
  await expect(picker).toBeVisible();
  return opened;
}

/** The recording-disabled stack must leave an unavailable selection unconfirmable. */
export async function expectEmptyPickerAndCancel(page: Page, opened: OpenPicker): Promise<void> {
  const { picker, availability } = opened;
  expect(availability.hours).toEqual([]);
  await expect(picker.getByText('No recordings for this instrument.', { exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Check interval', exact: true })).toBeDisabled();
  await expect(picker.getByRole('button', { name: 'Open paused', exact: true })).toHaveCount(0);
  await expect(picker.getByRole('combobox', { name: 'Recorded dates / hours', exact: true })).toHaveCount(0);
  await expect(picker.getByLabel('Start date and time (UTC)', { exact: true })).toHaveCount(0);
  await expect(picker.getByLabel('End date and time (exclusive) (UTC)', { exact: true })).toHaveCount(0);
  await expectLiveUnchanged(page, opened);
  // Header close and footer Cancel share their accessible name: scope deliberately.
  await picker.locator('footer').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expectLiveUnchanged(page, opened);
  for (const id of ['transport-play', 'speed-cycle', 'seek-scrubber']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
}
