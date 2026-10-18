import bundled from '../../../server/src/flowmap_server/data/universe.json';
import type { SymbolEntry } from './symbols';

/** The same curated symbols the server ships, ready before the first HTTP reply.
 * Capability is deliberately empty until the server reports the active feed's
 * tier: a local symbol list cannot know which equity keys are configured.
 */
export const BUNDLED_DIRECTORY: SymbolEntry[] = [
  ...bundled.crypto_symbols.map((symbol) => ({ market: bundled.crypto_market, symbol, capability: {} })),
  ...bundled.equity_tickers.map((symbol) => ({ market: 'equity', symbol, capability: {} })),
];
