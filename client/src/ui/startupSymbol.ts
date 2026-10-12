import { loadRecents, type RecentPick } from './recents';

export const ACTIVE_SYMBOL_KEY = 'flowmap.active-symbol.v1';
const DEMO: RecentPick = { market: 'sim', symbol: 'SIM-DEMO' };

function valid(pick: unknown): pick is RecentPick {
  if (!pick || typeof pick !== 'object') return false;
  const p = pick as RecentPick;
  return typeof p.market === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(p.market)
    && typeof p.symbol === 'string' && p.symbol.length > 0 && p.symbol.length <= 128
    && !/[\x00-\x1f\x7f]/.test(p.symbol);
}

export function loadStartupSymbol(storage: Storage | null): RecentPick {
  try {
    const raw = storage?.getItem(ACTIVE_SYMBOL_KEY);
    if (raw) {
      const pick: unknown = JSON.parse(raw);
      if (valid(pick)) return pick;
    }
  } catch { /* unavailable storage uses recents or the explicit demo */ }
  const recent = loadRecents(storage).find(valid);
  return recent ?? DEMO;
}

export function saveStartupSymbol(storage: Storage | null, market: string, symbol: string): void {
  const pick = { market, symbol };
  if (!valid(pick)) return;
  try { storage?.setItem(ACTIVE_SYMBOL_KEY, JSON.stringify(pick)); } catch { /* best effort */ }
}
