import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { subscribeQuotes } from '../state/quoteFeed';
import { flushForTest, ingestForTest, resetForSession, resetForTest } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { MODE_L2, MsgType, SIDE_UNKNOWN } from '../proto/types';
import { DEMO_INTELLIGENCE, useIntelligenceStore } from '../state/intelligenceStore';
import {
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  resetWatchlistForTest,
  setWatchlistStorage,
  type StorageLike,
} from '../watchlist/store';
import { LIVE_QUOTE_STALE_MS, Watchlist, quoteChangeText, quoteDirection, quotePriceText, symbolOf } from './Watchlist';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The panel consumes lane C1's frozen P2 feed via this module; tests drive it
// directly so quote timing is deterministic and no network/poller is involved.
vi.mock('../state/quoteFeed', () => ({
  subscribeQuotes: vi.fn(() => () => {}),
}));

const subscribeMock = subscribeQuotes as unknown as Mock;

/** Callback as the panel passes it (structural quote shape). */
type QuoteCb = (
  key: string,
  quote: { price?: number | null; changePct?: number | null; spark?: readonly number[] | null; stale?: boolean; reachable?: boolean },
) => void;

let lastKeys: string[] = [];
let lastCb: QuoteCb | null = null;
let unsubCalls = 0;

function installFeedMock(): void {
  subscribeMock.mockReset();
  lastKeys = [];
  lastCb = null;
  unsubCalls = 0;
  subscribeMock.mockImplementation((keys: string[], cb: QuoteCb) => {
    lastKeys = [...keys];
    lastCb = cb;
    return () => {
      unsubCalls += 1;
    };
  });
}

function emit(key: string, quote: Parameters<QuoteCb>[1]): void {
  act(() => {
    lastCb?.(key, quote);
  });
}

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: JSX.Element): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  const handle = { container, root };
  mounted.push(handle);
  return handle;
}

function text(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
}

beforeEach(() => {
  resetForTest();
  useFlowMapStore.setState({ subscription: null, sessionId: null, sessionRevision: 0, status: 'idle', feedState: null });
  useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true);
  resetWatchlistForTest();
  setWatchlistStorage(memStorage());
  installFeedMock();
  window.localStorage.clear();
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    try {
      act(() => root.unmount());
    } catch {
      /* a test may have unmounted its root already */
    }
    container.remove();
  }
  resetForTest();
  vi.useRealTimers();
});

describe('pure helpers', () => {
  it('symbolOf splits the composite key', () => {
    expect(symbolOf('crypto:BTCUSDT')).toBe('BTCUSDT');
    expect(symbolOf('plain')).toBe('plain');
  });

  it('quoteDirection prefers the spark direction, falls back to changePct', () => {
    expect(quoteDirection(undefined)).toBe('flat');
    expect(quoteDirection({ spark: [1, 2, 3], changePct: -5 })).toBe('up');
    expect(quoteDirection({ spark: [3, 2, 1], changePct: 5 })).toBe('down');
    expect(quoteDirection({ spark: [1, 1], changePct: 5 })).toBe('up');
    expect(quoteDirection({ spark: [], changePct: -0.1 })).toBe('down');
    expect(quoteDirection({ spark: [1, 1], changePct: 0 })).toBe('flat');
  });

  it('quote text helpers render em-dashes for missing or unreachable quotes', () => {
    expect(quotePriceText(undefined)).toBe('—');
    expect(quoteChangeText(undefined)).toBe('—');
    expect(quotePriceText({ price: 12.5, reachable: true })).toBe('12.50');
    expect(quotePriceText({ price: 12.5, reachable: false })).toBe('—');
    expect(quoteChangeText({ changePct: 1.25, reachable: false })).toBe('—');
    for (const price of [0, -1, NaN, Infinity]) {
      expect(quotePriceText({ price, reachable: true })).toBe('—');
      expect(quoteChangeText({ price, changePct: 0, reachable: true })).toBe('—');
    }
  });
});

describe('Watchlist active stream bridge', () => {
  const activate = (symbol = 'BTCUSDT', mode: 'live' | 'replay' = 'live', market = 'crypto'): void => {
    useFlowMapStore.setState({ subscription: { market, symbol, mode, band: 'native' },
      sessionId: `session-${symbol}-${mode}`, status: 'live', feedState: null });
  };
  const inside = (ts: bigint, bid = 100.39, ask = 100.4): void => {
    ingestForTest({ type: MsgType.BBO, ts_ns: ts, bid_px: bid, bid_sz: 3, ask_px: ask, ask_sz: 4 });
    flushForTest();
  };

  it('uses the raw midpoint with a grouped epoch and preserves the genuine daily change', () => {
    activate();
    addToWatchlist('crypto:BTCUSDT');
    useFlowMapStore.setState({ epochs: new Map([[1, { epoch: 1, tick: 0.01, tick_multiple: 50,
      dt_ns: 1_000_000, p0: 50, rows: 200 }]]), gridEpoch: 1 });
    ingestForTest({ type: MsgType.DEPTH_COL, epoch: 1, col_seq: 1, t0_ns: 1n,
      mode: MODE_L2, final: true, bid: new Float32Array(200), ask: new Float32Array(200) });
    inside(1n);
    const { container } = render(<Watchlist activeKey="crypto:BTCUSDT" onSelect={vi.fn()} />);
    const network = Object.freeze({ price: 90, changePct: 2.5, spark: [80, 90], reachable: true });
    emit('crypto:BTCUSDT', network);
    expect(text(container, 'watchlist-price-crypto:BTCUSDT')).toBe('100.40');
    expect(Number(container.querySelector('[data-testid="watchlist-price-crypto:BTCUSDT"]')?.getAttribute('data-raw-price'))).toBeCloseTo(100.395, 10);
    expect(network.price).toBe(90); // HTTP/alert payload remains untouched
    expect(text(container, 'watchlist-change-crypto:BTCUSDT')).toBe('+2.50%');
    expect(text(container, 'watchlist-source-crypto:BTCUSDT')).toBe('LIVE MID');
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(lastKeys).toEqual(['crypto:BTCUSDT']);
  });

  it('coalesces book notifications to ten price updates per second and marks aged quotes stale', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    activate();
    addToWatchlist('crypto:BTCUSDT');
    inside(1n, 100, 101);
    const { container } = render(<Watchlist activeKey="crypto:BTCUSDT" onSelect={vi.fn()} />);
    act(() => { inside(2n, 101, 102); inside(3n, 102, 103); vi.advanceTimersByTime(99); });
    expect(text(container, 'watchlist-price-crypto:BTCUSDT')).toBe('100.50');
    act(() => vi.advanceTimersByTime(1));
    expect(text(container, 'watchlist-price-crypto:BTCUSDT')).toBe('102.50');
    act(() => vi.advanceTimersByTime(LIVE_QUOTE_STALE_MS));
    expect(text(container, 'watchlist-stale-crypto:BTCUSDT')).toBe('stale');
    vi.restoreAllMocks();
  });

  it('clears the active quote on a switch and never transfers the old instrument price', () => {
    activate();
    addToWatchlist('crypto:BTCUSDT');
    addToWatchlist('crypto:ETHUSDT');
    inside(1n);
    const { container, root } = render(<Watchlist activeKey="crypto:BTCUSDT" onSelect={vi.fn()} />);
    expect(text(container, 'watchlist-source-crypto:BTCUSDT')).toBe('LIVE MID');
    act(() => {
      activate('ETHUSDT');
      root.render(<Watchlist activeKey="crypto:ETHUSDT" onSelect={vi.fn()} />);
    });
    expect(text(container, 'watchlist-price-crypto:ETHUSDT')).toBe('—');
    expect(text(container, 'watchlist-price-crypto:BTCUSDT')).toBe('—');
    act(() => { resetForSession(); inside(2n, 25, 26); });
    // Initial reset may await the remainder of the 100ms cadence.
    expect(text(container, 'watchlist-price-crypto:ETHUSDT')).not.toBe('100.40');
  });

  it('uses a real last trade only when no quote exists, and excludes replay/demo', () => {
    activate();
    addToWatchlist('crypto:BTCUSDT');
    ingestForTest({ type: MsgType.TRADE, ts_ns: 1n, price: 99, size: 2,
      side: SIDE_UNKNOWN, side_src: 2, venue: 'binance' });
    const { container } = render(<Watchlist activeKey="crypto:BTCUSDT" onSelect={vi.fn()} />);
    expect(text(container, 'watchlist-price-crypto:BTCUSDT')).toBe('99.00');
    expect(text(container, 'watchlist-source-crypto:BTCUSDT')).toBe('LIVE LAST');
    expect(text(container, 'watchlist-change-crypto:BTCUSDT')).toBe('—');
    act(() => activate('BTCUSDT', 'replay'));
    expect(text(container, 'watchlist-price-crypto:BTCUSDT')).toBe('—');
    act(() => { activate('BTCUSDT', 'live', 'sim'); resetForSession(); inside(2n); });
    expect(text(container, 'watchlist-source-crypto:BTCUSDT')).toBe('SNAPSHOT');
  });
});

describe('Watchlist panel', () => {
  it('empty list subscribes to nothing and shows recents as non-favoriting chips', () => {
    window.localStorage.setItem('flowmap.recents', JSON.stringify(['sim:SIM-DEMO', 'crypto:BTCUSDT']));
    const onSelect = vi.fn();
    const { container } = render(<Watchlist activeKey="sim:SIM-DEMO" onSelect={onSelect} />);

    expect(subscribeMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="watchlist-empty"]')).not.toBeNull();
    expect(text(container, 'watchlist-recent-sim:SIM-DEMO')).toBe('SIM-DEMO');
    expect(text(container, 'watchlist-recent-crypto:BTCUSDT')).toBe('BTCUSDT');

    act(() => {
      (container.querySelector('[data-testid="watchlist-recent-crypto:BTCUSDT"]') as HTMLButtonElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('crypto:BTCUSDT');
    expect(getWatchlist()).toEqual([]); // suggestion click must NOT favorite
  });

  it('renders rows for favorites and subscribes with the full key set', () => {
    addToWatchlist('sim:A');
    addToWatchlist('crypto:BTCUSDT');
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);

    expect(lastKeys).toEqual(['sim:A', 'crypto:BTCUSDT']);
    expect(text(container, 'watchlist-count')).toBe('2');
    expect(text(container, 'watchlist-row-sim:A')).toContain('A');
    expect(text(container, 'watchlist-row-crypto:BTCUSDT')).toContain('BTCUSDT');
  });

  it('shows price + signed change with the direction class from the quote', () => {
    addToWatchlist('sim:A');
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    emit('sim:A', { price: 61234.5, changePct: 2.5, spark: [1, 2, 3], stale: false, reachable: true });

    expect(text(container, 'watchlist-price-sim:A')).toBe('61,234.5');
    expect(text(container, 'watchlist-change-sim:A')).toBe('+2.50%');
    const chg = container.querySelector('[data-testid="watchlist-change-sim:A"]') as HTMLElement;
    expect(chg.classList.contains('is-up')).toBe(true);
    const path = container.querySelector('.watchlist__spark-path') as SVGPathElement | null;
    expect(path).not.toBeNull();
    expect(path?.getAttribute('d')?.startsWith('M')).toBe(true);
  });

  it('marks stale quotes dim with a stale chip, keeping the last known price', () => {
    addToWatchlist('sim:A');
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    emit('sim:A', { price: 100.5, changePct: -1.25, spark: [3, 2, 1], stale: true, reachable: true });

    const row = container.querySelector('[data-testid="watchlist-row-sim:A"]') as HTMLElement;
    expect(row.classList.contains('is-stale')).toBe(true);
    expect(text(container, 'watchlist-stale-sim:A')).toBe('stale');
    expect(text(container, 'watchlist-price-sim:A')).toBe('100.50');
    expect(text(container, 'watchlist-change-sim:A')).toBe('−1.25%');
  });

  it('unreachable quotes render em-dashes + no-data chip and NEVER a fabricated price', () => {
    addToWatchlist('sim:A');
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    emit('sim:A', { price: 999, changePct: 5, spark: [1, 2], stale: false, reachable: false });

    expect(text(container, 'watchlist-price-sim:A')).toBe('—');
    expect(text(container, 'watchlist-change-sim:A')).toBe('—');
    expect(text(container, 'watchlist-nodata-sim:A')).toBe('no data');
    expect(container.textContent).not.toContain('999');
  });

  it('an absent quote shows em-dashes until data arrives', () => {
    addToWatchlist('sim:A');
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    expect(text(container, 'watchlist-price-sim:A')).toBe('—');
    expect(text(container, 'watchlist-change-sim:A')).toBe('—');
  });

  it('highlights the active row and selects on click + Enter', () => {
    addToWatchlist('sim:A');
    addToWatchlist('sim:B');
    const onSelect = vi.fn();
    const { container } = render(<Watchlist activeKey="sim:B" onSelect={onSelect} />);

    const rowA = container.querySelector('[data-testid="watchlist-row-sim:A"]') as HTMLElement;
    const rowB = container.querySelector('[data-testid="watchlist-row-sim:B"]') as HTMLElement;
    expect(rowB.classList.contains('is-active')).toBe(true);
    expect(rowA.classList.contains('is-active')).toBe(false);

    act(() => rowA.click());
    expect(onSelect).toHaveBeenCalledWith('sim:A');

    act(() => {
      rowA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('star toggle removes the favorite (row disappears from the store)', () => {
    addToWatchlist('sim:A');
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    const star = container.querySelector('[data-testid="watchlist-star-sim:A"]') as HTMLButtonElement;
    act(() => star.click());
    expect(getWatchlist()).toEqual([]);
    expect(container.querySelector('[data-testid="watchlist-row-sim:A"]')).toBeNull();
  });

  it('nested controls keep their own Enter/Space activation (R2-M2)', () => {
    addToWatchlist('sim:A');
    addToWatchlist('sim:B');
    const onSelect = vi.fn();
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={onSelect} />);
    const starB = container.querySelector('[data-testid="watchlist-star-sim:B"]') as HTMLButtonElement;

    // Enter on the nested star must toggle the favorite, NOT select the row.
    act(() => {
      starB.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    act(() => starB.click()); // native activation path (what the guard preserves)
    expect(getWatchlist()).toEqual(['sim:A']);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('remove control removes the row without selecting it', () => {
    addToWatchlist('sim:A');
    addToWatchlist('sim:B');
    const onSelect = vi.fn();
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={onSelect} />);
    const remove = container.querySelector('[data-testid="watchlist-remove-sim:B"]') as HTMLButtonElement;
    act(() => remove.click());
    expect(getWatchlist()).toEqual(['sim:A']);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('add-current adds the active key and disables when already present', () => {
    const { container } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    const add = container.querySelector('[data-testid="watchlist-add"]') as HTMLButtonElement;
    expect(add.disabled).toBe(false);

    act(() => add.click());
    expect(getWatchlist()).toEqual(['sim:A']);
    expect(text(container, 'watchlist-count')).toBe('1');
    expect(lastKeys).toEqual(['sim:A']);

    const addAgain = container.querySelector('[data-testid="watchlist-add"]') as HTMLButtonElement;
    expect(addAgain.disabled).toBe(true);
  });

  it('re-subscribes with the diffed key set on add and remove', () => {
    addToWatchlist('sim:A');
    addToWatchlist('sim:B');
    render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    expect(lastKeys).toEqual(['sim:A', 'sim:B']);

    act(() => addToWatchlist('sim:C'));
    expect(unsubCalls).toBe(1);
    expect(lastKeys).toEqual(['sim:A', 'sim:B', 'sim:C']);

    act(() => removeFromWatchlist('sim:B'));
    expect(unsubCalls).toBe(2);
    expect(lastKeys).toEqual(['sim:A', 'sim:C']);
  });

  it('unmount cleans the subscription up', () => {
    addToWatchlist('sim:A');
    const { container, root } = render(<Watchlist activeKey="sim:A" onSelect={vi.fn()} />);
    act(() => root.unmount());
    container.remove();
    expect(unsubCalls).toBe(1);
  });

  it('does not show seeded quotes or institutional alerts before real data arrives', () => {
    addToWatchlist('nasdaq:NVDA');
    const { container } = render(<Watchlist activeKey="nasdaq:NVDA" onSelect={vi.fn()} />);
    expect(text(container, 'watchlist-price-nasdaq:NVDA')).toBe('—');
    expect(text(container, 'watchlist-change-nasdaq:NVDA')).toBe('—');
    expect(container.querySelector('[data-testid="watchlist-talent-nasdaq:NVDA"]')).toBeNull();
    expect(container.querySelector('[data-testid="watchlist-jet-nasdaq:NVDA"]')).toBeNull();
  });

  it('renders supplied Talent Index and Executive Jet Alert data', () => {
    useIntelligenceStore.setState({ talent: { NVDA: { ...DEMO_INTELLIGENCE.talent.NVDA } }, corporateJets: [{ ...DEMO_INTELLIGENCE.corporateJets[0] }] });
    addToWatchlist('nasdaq:NVDA');
    const { container } = render(<Watchlist activeKey="nasdaq:NVDA" onSelect={vi.fn()} />);

    const talentChip = container.querySelector('[data-testid="watchlist-talent-nasdaq:NVDA"]');
    expect(talentChip).not.toBeNull();
    expect(talentChip!.textContent).toContain('%');

    const jetChip = container.querySelector('[data-testid="watchlist-jet-nasdaq:NVDA"]');
    expect(jetChip).not.toBeNull();
    expect(jetChip!.textContent).toContain('✈️');
  });
});
