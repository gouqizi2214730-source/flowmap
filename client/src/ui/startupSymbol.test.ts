import { beforeEach, expect, it } from 'vitest';
import { ACTIVE_SYMBOL_KEY, loadStartupSymbol, saveStartupSymbol } from './startupSymbol';
beforeEach(() => localStorage.clear());
it('restores the explicit active instrument ahead of recents', () => {
  localStorage.setItem('flowmap.recents', JSON.stringify(['binance-spot:RUNEUSDT']));
  saveStartupSymbol(localStorage, 'binance-spot', 'BTCUSDT');
  expect(loadStartupSymbol(localStorage)).toEqual({ market: 'binance-spot', symbol: 'BTCUSDT' });
});
it('uses valid recents on migration and the explicit demo only without a saved instrument', () => {
  localStorage.setItem(ACTIVE_SYMBOL_KEY, '{broken');
  localStorage.setItem('flowmap.recents', JSON.stringify(['binance-spot:RUNEUSDT']));
  expect(loadStartupSymbol(localStorage).symbol).toBe('RUNEUSDT');
  expect(loadStartupSymbol(null)).toEqual({ market: 'sim', symbol: 'SIM-DEMO' });
});
