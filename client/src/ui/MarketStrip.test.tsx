import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { flushForTest, ingestForTest, resetForTest } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { MarketStrip, quoteAgeText } from './MarketStrip';
import { MsgType, MODE_L2 } from '../proto/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('retains exchange decimals when depth is grouped and never derives fake quotes', () => {
  resetForTest();
  useFlowMapStore.setState({ gridEpoch: 1, epochs: new Map([[1, {
    epoch: 1, tick: .01, tick_multiple: 50, p0: 85000, rows: 4096, dt_ns: 250000000,
  }]]), subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'native' }, status: 'live' });
  ingestForTest({ type: 6, ts_ns: 1n, bid_px: 85636.92, bid_sz: 1.25, ask_px: 85636.93, ask_sz: 2 } as never);
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => root.render(<MarketStrip rendererRef={{ current: null }} />));
  expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('85636.92');
  expect(el.querySelector('[data-testid="market-ask"]')?.textContent).toBe('85636.93');
  expect(el.querySelector('[data-testid="market-spread"]')?.textContent).toBe('0.01');
  act(() => root.unmount());
  resetForTest();
});
it('labels local quote age without claiming network latency', () => {
  expect(quoteAgeText(undefined, 10000)).toBe('—');
  expect(quoteAgeText(10000, 10120)).toBe('120 ms');
  expect(quoteAgeText(10000, 14500)).toBe('4.5 s');
  expect(quoteAgeText(10000, 9900)).toBe('0 ms');
});

it('clears the top price strip quote and age at crossed recorded positions, then accepts the next column quote', () => {
  resetForTest();
  useFlowMapStore.setState({ subscription: { market: 'binance', symbol: 'BTCUSDT', mode: 'replay', band: 'native' },
    capability: { depth: 'L2', depth_provenance: 'recorded-density' }, status: 'live' });
  const column = (t: bigint, crossed: boolean): void => {
    ingestForTest({ type: MsgType.BOOK_UPDATE, epoch: 0, col_seq: Number(t), t0_ns: t, mode: MODE_L2,
      final: false, bid: Float32Array.of(0, 0, 2, 0), ask: Float32Array.from(crossed ? [0, 3, 0, 0] : [0, 0, 0, 3]) });
  };
  column(1n, true);
  const el = document.createElement('div'), root = createRoot(el);
  try {
    act(() => root.render(<MarketStrip rendererRef={{ current: null }} />));
    const assertUnavailable = (): void => {
      for (const id of ['market-bid', 'market-ask', 'market-spread']) {
        expect(el.querySelector(`[data-testid="${id}"]`)?.textContent).toBe('—');
      }
      expect(el.querySelector('[data-testid="market-quote-age"]')?.textContent).toBe('Quote age —');
    };
    assertUnavailable();
    act(() => {
      column(2n, false);
      ingestForTest({ type: MsgType.BBO, ts_ns: 2n, bid_px: 60001, bid_sz: 2, ask_px: 60001.5, ask_sz: 3 });
      flushForTest();
    });
    expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('60001.00');
    act(() => { column(3n, true); flushForTest(); });
    assertUnavailable();
    act(() => {
      column(4n, false);
      ingestForTest({ type: MsgType.BBO, ts_ns: 4n, bid_px: 60002, bid_sz: 2, ask_px: 60002.5, ask_sz: 3 });
      flushForTest();
    });
    expect(el.querySelector('[data-testid="market-bid"]')?.textContent).toBe('60002.00');
  } finally { act(() => root.unmount()); resetForTest(); }
});
