import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the actual App/store/picker transition with canvas-owned policy
// changes; this double models policies separately from a detached camera.
const harness = vi.hoisted(() => {
  const renderer = {
    following: true, wantedFollowTime: true, priceFollow: 'fit', marketFrameReady: false,
    setFollowTime(on: boolean) { this.following = this.wantedFollowTime = on; },
    setPriceFollow(mode: string) { this.priceFollow = mode; },
    resetForSession() {}, timeline: () => null, historyStats: () => null, overviewStats: () => null,
    stats: () => ({ fps: 0, frameMs: 0, uploads: 0 }),
  };
  return { renderer: new Proxy(renderer, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => null,
  }) };
});
vi.mock('./gl/renderer', () => ({ Renderer: class { constructor() { return harness.renderer; } } }));

import { App } from './App';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import { markOnboarded } from './ui/OnboardingCard';
import { setLocale } from './i18n';
import { loadSettings } from './ui/settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const T = 1759276800000000000n;
let root: Root;
let container: HTMLDivElement;
const click = (el: Element): void => { act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };
const button = (text: string): HTMLButtonElement => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.includes('availability')
      ? { hours: [T.toString()], latest_column_ns: (T + 60_000_000_000n).toString(), max_columns: 32768 }
      : { start_ns: T.toString(), end_ns: (T + 60_000_000_000n).toString(), columns: 240 },
  })));
  window.localStorage.clear(); markOnboarded(); setLocale('en');
  setFlowMapTransport({ url: 'wss://test.invalid/ws', wsFactory: () => ({ binaryType: 'arraybuffer', onopen: null,
    onclose: null, onerror: null, onmessage: null, send() {}, close() {} }) });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  act(() => useFlowMapStore.setState({ capability: { replay: true } }));
});

afterEach(() => {
  act(() => root.unmount()); container.remove();
  useFlowMapStore.getState().disconnect(); setFlowMapTransport({});
  vi.unstubAllGlobals(); vi.useRealTimers();
});

async function enterReplay(): Promise<void> {
  // Availability/preview resolve without any 250 ms reconciliation tick.
  click(container.querySelector('[data-testid="mode-replay"]')!);
  await act(async () => {});
  await act(async () => button('Check interval').click());
  click(button('Open paused'));
  expect(useFlowMapStore.getState().subscription?.mode).toBe('replay');
}

it.each([0, 300])('preserves immediate canvas time-off with %i ms reconciliation', async settleMs => {
  harness.renderer.setFollowTime(false);
  if (settleMs) act(() => vi.advanceTimersByTime(settleMs));
  await enterReplay();
  expect(harness.renderer.wantedFollowTime).toBe(true);
  click(container.querySelector('[data-testid="mode-live"]')!);
  expect(harness.renderer.wantedFollowTime).toBe(false);
  expect(loadSettings(window.localStorage).follow).toBe(false);
});

it.each(['off', 'track', 'fit'])('restores exact immediate canvas price policy %s', async policy => {
  harness.renderer.setPriceFollow(policy);
  await enterReplay();
  expect(harness.renderer.priceFollow).toBe('fit');
  harness.renderer.setPriceFollow('off'); // replay pan/settings do not replace LIVE intent
  act(() => vi.advanceTimersByTime(300));
  click(container.querySelector('[data-testid="mode-live"]')!);
  expect(harness.renderer.priceFollow).toBe(policy);
  expect(loadSettings(window.localStorage).followPrice).toBe(policy !== 'off');
});

it('retains explicit LIVE intent through five replay generations, settings, instrument changes and reconnect', async () => {
  harness.renderer.setFollowTime(true);
  harness.renderer.following = false; // scrolled-back camera, policy still ON
  harness.renderer.setPriceFollow('track');
  for (let cycle = 0; cycle < 5; cycle++) {
    await enterReplay();
    harness.renderer.setFollowTime(false);
    harness.renderer.setPriceFollow('off');
    // Replay settings go directly to its camera and do not persist LIVE flags.
    click(container.querySelector('[data-testid="settings-open"]')!);
    click(container.querySelector('[data-testid="toggle-follow"]')!);
    click(container.querySelector('[data-testid="toggle-follow-price"]')!);
    click(container.querySelector('[data-testid="settings-close"]')!);
    act(() => vi.advanceTimersByTime(300));
    // A seek Hello resets replay policy without recapturing LIVE intent.
    act(() => useFlowMapStore.setState({ sessionId: `replay-${cycle}` }));
    click(container.querySelector('[data-testid="mode-live"]')!);
    expect(harness.renderer.wantedFollowTime).toBe(true);
    expect(harness.renderer.priceFollow).toBe('track');
    act(() => useFlowMapStore.setState({ capability: { replay: true } }));
  }
  harness.renderer.setFollowTime(false);
  harness.renderer.setPriceFollow('off');
  act(() => useFlowMapStore.getState().connectAndSubscribe('binance-spot', 'ETHUSDT', 'live', 'wide'));
  expect(harness.renderer.wantedFollowTime).toBe(false);
  expect(harness.renderer.priceFollow).toBe('off');
  // Same-subscription Hello on reconnect keeps the exact policies too.
  act(() => useFlowMapStore.setState({ sessionId: 'live-reconnect' }));
  expect(harness.renderer.wantedFollowTime).toBe(false);
  expect(harness.renderer.priceFollow).toBe('off');
});
