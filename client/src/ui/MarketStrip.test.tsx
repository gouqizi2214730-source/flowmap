import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ingestForTest, resetForTest } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { MarketStrip, quoteAgeText } from './MarketStrip';

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
