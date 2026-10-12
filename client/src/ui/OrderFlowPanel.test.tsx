import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MODE_L2, MsgType, SIDE_BUY, SIDE_SRC_EXCHANGE, type EpochParams } from '../proto/types';
import type { StreamMsg } from '../net/connection';
import { useFlowMapStore } from '../state/store';
import { type BookSnapshot } from '../state/bookStore';
import { nearbyDepth, OrderFlowPanel } from './OrderFlowPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());
const epoch: EpochParams = { epoch: 1, dt_ns: 250_000_000, tick: 1, tick_multiple: 1, p0: 90, rows: 32 };
const snapshot: BookSnapshot = { version: 1, trades: [], bbo: { tsNs: 1n, bidPx: 99, askPx: 101, bidSz: 1, askSz: 2 },
  book: { instant: true, epoch: 1, colSeq: 0, t0Ns: 1n, mode: MODE_L2, bid: new Float32Array(32).fill(1), ask: new Float32Array(32).fill(2) } };
it('reports precisely scoped instantaneous liquidity and rejects averaged/synthetic books', () => {
  expect(nearbyDepth(snapshot, epoch)).toEqual({ bid: 17, ask: 34, low: 91.5, high: 108.5 });
  expect(nearbyDepth({ ...snapshot, book: { ...snapshot.book!, instant: false } }, epoch)).toBeNull();
  expect(nearbyDepth({ ...snapshot, book: { ...snapshot.book!, mode: 2 } }, epoch)).toBeNull();
  expect(nearbyDepth({ ...snapshot, bbo: { ...snapshot.bbo!, bidPx: 200, askPx: 201 } }, epoch)).toBeNull();
});
it('changing the window retains accumulated prints and a new instrument clears them', () => {
  vi.useFakeTimers();
  const original = useFlowMapStore.getState();
  let listener: ((msg: StreamMsg) => void) | undefined;
  useFlowMapStore.setState({ subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'deep' }, status: 'live',
    sessionId: 'flow-test', epochs: new Map(), onStream: cb => { listener = cb; return () => { listener = undefined; }; } });
  const el = document.createElement('div'), root = createRoot(el);
  try {
    act(() => root.render(<OrderFlowPanel />));
    const now = BigInt(Math.round(performance.now())) * 1_000_000n;
    act(() => {
      for (let i = 0; i < 1000; i++) listener!({ type: MsgType.TRADE, ts_ns: now, price: 100, size: 2,
        side: SIDE_BUY, side_src: SIDE_SRC_EXCHANGE, venue: 'binance' });
      vi.advanceTimersByTime(250);
    });
    expect(el.querySelector('[data-testid="flow-count"]')?.textContent).toBe((1000).toLocaleString());
    act(() => (Array.from(el.querySelectorAll('button')).find(b => b.textContent === '60s') as HTMLButtonElement).click());
    expect(el.querySelector('[data-testid="flow-count"]')?.textContent).toBe((1000).toLocaleString());
    act(() => useFlowMapStore.setState({ subscription: { market: 'binance-spot', symbol: 'RUNEUSDT', mode: 'live', band: 'deep' } }));
    expect(el.querySelector('[data-testid="flow-count"]')?.textContent).toBe('—');
    act(() => vi.advanceTimersByTime(250));
    expect(el.querySelector('[data-testid="flow-count"]')?.textContent).toBe('0');
  } finally { act(() => root.unmount()); useFlowMapStore.setState(original, true); }
});
