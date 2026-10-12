import { beforeEach, describe, expect, it } from 'vitest';
import { MsgType, type GexLevelUpdate, type MacroStressUpdate, type MarketIntelligence } from '../proto/types';
import { DEMO_INTELLIGENCE, useIntelligenceStore } from './intelligenceStore';

const gex: GexLevelUpdate = {
  type: MsgType.GEX_UPDATE, symbol: 'NVDA', spot_price: 130, net_gex: -12_000,
  call_wall: 135, put_wall: 120, gamma_flip: 128,
};
const macro: MacroStressUpdate = {
  type: MsgType.MACRO_STRESS, ts_ns: 1_000n, sofr: 5.32, hy_spread: 3.42,
  yield_10y2y: -0.18, stress_score: 0.4, status: 'ELEVATED',
};
function intel(overrides: Partial<MarketIntelligence> = {}): MarketIntelligence {
  return {
    type: MsgType.MARKET_INTELLIGENCE, ts_ns: 2_000n, symbol: 'PLTR',
    kind: 'defense_contract', headline: 'Reported award', amount_usd: 178_000_000,
    detail: 'US Army', source: 'Connected source', ...overrides,
  };
}

beforeEach(() => useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true));

describe('institutional data availability', () => {
  it('starts empty with macro unavailable and keeps synthetic fixtures separate', () => {
    const state = useIntelligenceStore.getState();
    expect(state.gex).toEqual({});
    expect(state.darkPool).toEqual({});
    expect(state.secDiffs).toEqual([]);
    expect(state.vocalStress).toEqual([]);
    expect(state.contracts).toEqual([]);
    expect(state.capitolTrades).toEqual([]);
    expect(state.corporateJets).toEqual([]);
    expect(state.talent).toEqual({});
    expect(state.events).toEqual([]);
    expect(state.macro).toBeNull();
    expect(DEMO_INTELLIGENCE.gex['SIM-DEMO']).toBeDefined();
    expect(state.gex.UNKNOWN).toBeUndefined();
    expect(state.gex['SIM-DEMO']).toBeUndefined();
  });

  it('ingests actual GEX and current-wire macro without creating unrelated data', () => {
    const store = useIntelligenceStore.getState();
    store.handleStreamMsg(gex);
    store.handleStreamMsg(macro);
    const state = useIntelligenceStore.getState();
    expect(state.gex.NVDA).toMatchObject({ spotPrice: 130, netGex: -12_000, callWall: 135, putWall: 120, gammaFlip: 128 });
    expect(state.macro).toMatchObject({ sofrRate: 5.32, hySpreadBps: 342, yieldCurve10Y2Y: -0.18, stressRegime: 'ELEVATED', stressScore: 0.4 });
    expect(state.darkPool).toEqual({});
    expect(state.talent).toEqual({});
    expect(state.events).toEqual([]);
    expect(state.contracts).toEqual([]);
    expect(state.vocalStress).toEqual([]);
    expect(state.corporateJets).toEqual([]);
  });

  it.each([
    ['NORMAL_LIQUIDITY', 'NORMAL'], ['normal', 'NORMAL'], ['ELEVATED', 'ELEVATED'],
    ['SEVERE_STRESS', 'SEVERE'], ['severe', 'SEVERE'], ['unrecognized', 'UNKNOWN'],
  ])('maps received status %s to %s without guessing from the score', (status, stressRegime) => {
    useIntelligenceStore.getState().ingestMacro({ ...macro, status });
    expect(useIntelligenceStore.getState().macro).toMatchObject({ status, stressRegime });
  });

  it('accepts reported zero macro rates while rejecting malformed and nonfinite updates', () => {
    const store = useIntelligenceStore.getState();
    store.ingestMacro({ ...macro, sofr: 0, hy_spread: 0, yield_10y2y: 0, stress_score: 0 });
    const received = useIntelligenceStore.getState().macro;
    expect(received?.sofrRate).toBe(0);
    for (const invalid of [NaN, Infinity, -Infinity, '5', undefined]) {
      store.ingestMacro({ ...macro, sofr: invalid } as MacroStressUpdate);
      store.ingestGex({ ...gex, net_gex: invalid } as GexLevelUpdate);
    }
    store.ingestMacro({ ...macro, hy_spread: Number.MAX_VALUE });
    store.ingestMacro({ ...macro, stress_score: 1.1 });
    store.ingestMacro({ ...macro, status: '' });
    store.ingestMacro({ ...macro, ts_ns: -1n });
    store.ingestGex({ ...gex, spot_price: 0 });
    store.ingestGex({ ...gex, symbol: '' });
    store.ingestGex({ ...gex, call_wall: -1 });
    expect(useIntelligenceStore.getState().macro).toBe(received);
    expect(useIntelligenceStore.getState().gex).toEqual({});
  });
});

describe('current intelligence wire records', () => {
  it('retains plain detail and wire amount without fabricating contract metadata', () => {
    useIntelligenceStore.getState().handleStreamMsg(intel());
    const state = useIntelligenceStore.getState();
    expect(state.events[0]).toMatchObject({ kind: 'defense_contract', detail: 'US Army', source: 'Connected source', amountUsd: 178_000_000, tsNs: 2_000n });
    expect(state.contracts[0]).toMatchObject({ symbol: 'PLTR', amount: 178_000_000, description: 'Reported award' });
    expect(state.contracts[0].awardId).toBeUndefined();
    expect(state.contracts[0].agency).toBeUndefined();
    expect(state.contracts[0].recipient).toBeUndefined();
    expect(state.contracts[0].date).toBeUndefined();
    expect(state.capitolTrades).toEqual([]);
    expect(state.secDiffs).toEqual([]);
    expect(state.corporateJets).toEqual([]);
    expect(state.macro).toBeNull();
  });

  it('uses capitol kind and only validated supplied politician and transaction fields', () => {
    const store = useIntelligenceStore.getState();
    store.ingestIntel(intel({ kind: 'capitol', detail: 'Reported transaction', amount_usd: null }));
    expect(useIntelligenceStore.getState().capitolTrades[0]).toMatchObject({ symbol: 'PLTR' });
    expect(useIntelligenceStore.getState().capitolTrades[0].politician).toBeUndefined();
    expect(useIntelligenceStore.getState().capitolTrades[0].transactionType).toBeUndefined();
    store.ingestIntel(intel({ kind: 'capitol', detail: JSON.stringify({ politician: 'Supplied name', chamber: 'Senate', type: 'Sale', amount_range: '$1 - $2', committee: 'Supplied committee', date: '2026-10-01' }) }));
    expect(useIntelligenceStore.getState().capitolTrades[0]).toMatchObject({ politician: 'Supplied name', chamber: 'Senate', transactionType: 'Sale', amountRange: '$1 - $2', date: '2026-10-01' });
    expect(useIntelligenceStore.getState().contracts).toEqual([]);
  });

  it('validates optional JSON fields and does not infer a flight destination or alert', () => {
    const store = useIntelligenceStore.getState();
    store.ingestIntel(intel({ kind: 'sec_diff', detail: JSON.stringify({ filing_type: 12, filed_date: {}, added_lines: ['Actual line', 9], removed_lines: 'invalid', critical_triggers: [false, 'Actual trigger'] }) }));
    expect(useIntelligenceStore.getState().secDiffs[0]).toMatchObject({ title: 'Reported award', addedLines: ['Actual line'], removedLines: [], criticalTriggers: ['Actual trigger'] });
    expect(useIntelligenceStore.getState().secDiffs[0].filingType).toBeUndefined();
    store.ingestIntel(intel({ kind: 'jet_flight', detail: JSON.stringify({ origin: 'Supplied origin', is_ma_hub: 'true', tail_number: 7 }) }));
    const flight = useIntelligenceStore.getState().corporateJets[0];
    expect(flight.origin).toBe('Supplied origin');
    expect(flight.tailNumber).toBeUndefined();
    expect(flight.destination).toBeUndefined();
    expect(flight.isMaHub).toBeUndefined();
  });

  it('retains unknown kinds, plain text and malformed JSON as received content', () => {
    const store = useIntelligenceStore.getState();
    for (const detail of ['Text detail', '{broken JSON', 'null', '[]']) store.ingestIntel(intel({ kind: 'new-kind', detail }));
    const state = useIntelligenceStore.getState();
    expect(state.events.map((event) => event.detail)).toEqual(['[]', 'null', '{broken JSON', 'Text detail']);
    expect(new Set(state.events.map((event) => event.id)).size).toBe(4);
    expect(state.contracts).toEqual([]);
    expect(state.secDiffs).toEqual([]);
    expect(state.capitolTrades).toEqual([]);
    expect(state.corporateJets).toEqual([]);
  });

  it('ignores malformed envelopes and nonfinite amounts without altering valid data', () => {
    const store = useIntelligenceStore.getState();
    store.ingestIntel(intel());
    const received = useIntelligenceStore.getState().events;
    for (const amount_usd of [NaN, Infinity, -1]) store.ingestIntel(intel({ amount_usd }));
    store.ingestIntel(intel({ symbol: '' }));
    store.ingestIntel(intel({ kind: '' }));
    store.ingestIntel(intel({ detail: {} } as unknown as Partial<MarketIntelligence>));
    store.ingestIntel(intel({ ts_ns: 12 } as unknown as Partial<MarketIntelligence>));
    store.ingestIntel(null as unknown as MarketIntelligence);
    store.handleStreamMsg(null as unknown as MarketIntelligence);
    store.handleStreamMsg({ type: 255 } as unknown as MarketIntelligence);
    expect(useIntelligenceStore.getState().events).toBe(received);
    expect(useIntelligenceStore.getState().contracts).toHaveLength(1);
  });
});
