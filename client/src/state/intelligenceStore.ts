/**
 * Institutional Intelligence Store (Terminal <GO> Intelligence Engine).
 *
 * Coordinates deep market data streams across:
 * - FLOW <GO>: Option GEX (Gamma Exposure) & FINRA TRF Dark Pool Short Volumes.
 * - GOV <GO>: USASpending DoD/Gov contracts, Capitol Hill trades, ClinicalTrials.
 * - DOCS <GO>: SEC EDGAR Item 1A Risk Factors diffs & Earnings Call vocal stress acoustics.
 * - GEO & EXHAUST <GO>: Corporate jet ADS-B telematics & Talent Velocity headcount momentum.
 * - MACRO <GO>: FRED SOFR, High-Yield Option-Adjusted Spread (HY OAS), 10Y-2Y Yield Curve Inversion.
 */

import { create } from 'zustand';
import { MsgType, type GexLevelUpdate, type MarketIntelligence, type MacroStressUpdate } from '../proto/types';
import type { StreamMsg } from '../net/connection';

export interface GexData {
  symbol: string;
  spotPrice: number;
  netGex: number;
  callWall: number;
  putWall: number;
  gammaFlip: number;
  updatedAt: number;
}

export interface DarkPoolData {
  symbol: string;
  shortRatio: number;
  totalVolume: number;
  shortVolume: number;
  otcVolume: number;
  institutionalFlag: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
}

export interface SecDiffData {
  id: string;
  symbol: string;
  filingType: string;
  filedDate: string;
  title: string;
  addedLines: string[];
  removedLines: string[];
  criticalTriggers: string[];
}

export interface VocalStressData {
  id: string;
  symbol: string;
  quarter: string;
  executive: string;
  f0Jitter: number;
  shimmer: number;
  pauseRatio: number;
  stressScore: number; // 0.0 - 1.0
  evasiveAnswersDetected: number;
}

export interface ContractData {
  id: string;
  symbol: string;
  awardId: string;
  recipient: string;
  agency: string;
  amount: number;
  date: string;
  description: string;
}

export interface CapitolTradeData {
  id: string;
  symbol: string;
  politician: string;
  chamber: 'Senate' | 'House';
  transactionType: 'Purchase' | 'Sale';
  amountRange: string;
  committee: string;
  date: string;
}

export interface CorporateJetData {
  id: string;
  symbol: string;
  tailNumber: string;
  icao24: string;
  origin: string;
  destination: string;
  hubName: string;
  isMaHub: boolean;
  date: string;
}

export interface TalentData {
  symbol: string;
  talentDeltaPct: number;
  rdOpenings: number;
  totalOpenings: number;
  hiringFreeze: boolean;
}

export interface MacroStressData {
  sofrRate: number;
  hySpreadBps: number;
  yieldCurve10Y2Y: number;
  stressRegime: 'NORMAL' | 'ELEVATED' | 'SEVERE';
  updatedAt: number;
}

export type IntelTab = 'DOCS' | 'GOV' | 'FLOW' | 'GEO';

export interface IntelligenceState {
  drawerOpen: boolean;
  activeTab: IntelTab;
  gex: Record<string, GexData>;
  darkPool: Record<string, DarkPoolData>;
  secDiffs: SecDiffData[];
  vocalStress: VocalStressData[];
  contracts: ContractData[];
  capitolTrades: CapitolTradeData[];
  corporateJets: CorporateJetData[];
  talent: Record<string, TalentData>;
  macro: MacroStressData;

  // Actions
  setDrawerOpen: (open: boolean, tab?: IntelTab) => void;
  toggleDrawer: (tab?: IntelTab) => void;
  setActiveTab: (tab: IntelTab) => void;
  handleStreamMsg: (msg: StreamMsg) => void;
  ingestGex: (gex: GexLevelUpdate) => void;
  ingestMacro: (macro: MacroStressUpdate) => void;
  ingestIntel: (intel: MarketIntelligence) => void;
}

const SEED_GEX: Record<string, GexData> = {
  NVDA: {
    symbol: 'NVDA',
    spotPrice: 128.5,
    netGex: 4_850_000_000,
    callWall: 135.0,
    putWall: 118.0,
    gammaFlip: 124.5,
    updatedAt: Date.now(),
  },
  TSLA: {
    symbol: 'TSLA',
    spotPrice: 245.0,
    netGex: -1_200_000_000,
    callWall: 260.0,
    putWall: 220.0,
    gammaFlip: 250.0,
    updatedAt: Date.now(),
  },
  PLTR: {
    symbol: 'PLTR',
    spotPrice: 38.2,
    netGex: 850_000_000,
    callWall: 42.0,
    putWall: 34.0,
    gammaFlip: 36.5,
    updatedAt: Date.now(),
  },
  LMT: {
    symbol: 'LMT',
    spotPrice: 580.0,
    netGex: 620_000_000,
    callWall: 600.0,
    putWall: 550.0,
    gammaFlip: 570.0,
    updatedAt: Date.now(),
  },
  'SIM-DEMO': {
    symbol: 'SIM-DEMO',
    spotPrice: 100.0,
    netGex: 1_500_000_000,
    callWall: 105.0,
    putWall: 95.0,
    gammaFlip: 98.5,
    updatedAt: Date.now(),
  },
};

const SEED_DARK_POOL: Record<string, DarkPoolData> = {
  NVDA: {
    symbol: 'NVDA',
    shortRatio: 0.548,
    totalVolume: 48_500_000,
    shortVolume: 26_578_000,
    otcVolume: 22_100_000,
    institutionalFlag: 'ACCUMULATION',
  },
  TSLA: {
    symbol: 'TSLA',
    shortRatio: 0.582,
    totalVolume: 62_100_000,
    shortVolume: 36_142_200,
    otcVolume: 31_050_000,
    institutionalFlag: 'DISTRIBUTION',
  },
  PLTR: {
    symbol: 'PLTR',
    shortRatio: 0.521,
    totalVolume: 31_200_000,
    shortVolume: 16_255_200,
    otcVolume: 14_900_000,
    institutionalFlag: 'ACCUMULATION',
  },
  LMT: {
    symbol: 'LMT',
    shortRatio: 0.442,
    totalVolume: 1_850_000,
    shortVolume: 817_700,
    otcVolume: 790_000,
    institutionalFlag: 'NEUTRAL',
  },
  'SIM-DEMO': {
    symbol: 'SIM-DEMO',
    shortRatio: 0.535,
    totalVolume: 10_000_000,
    shortVolume: 5_350_000,
    otcVolume: 4_800_000,
    institutionalFlag: 'ACCUMULATION',
  },
};

const SEED_SEC_DIFFS: SecDiffData[] = [
  {
    id: 'diff-1',
    symbol: 'NVDA',
    filingType: '10-Q Item 1A',
    filedDate: 'Recent',
    title: 'Export Control & Advanced Semiconductor Restrictions',
    addedLines: [
      '+ The Bureau of Industry and Security (BIS) issued an interim final rule expanding licensing requirements for semiconductor shipments to specific regions.',
      '+ In August 2026, the Department of Justice issued a subpoena requesting documents regarding distribution channels and high-bandwidth interconnect bundling practices.',
      '+ These restrictions could materially and adversely affect our business, operating results, and market share in key enterprise computing corridors.',
    ],
    removedLines: [
      '- Management previously believed non-license alternative configurations would fulfill localized compute demand without material disruptions.',
    ],
    criticalTriggers: ['DOJ subpoena', 'Antitrust bundling', 'BIS export controls'],
  },
  {
    id: 'diff-2',
    symbol: 'PLTR',
    filingType: '10-K Item 1A',
    filedDate: 'Q3 Update',
    title: 'Government Contract Concentration & Cyber Immunity',
    addedLines: [
      '+ Expanded enterprise delivery requirements under US Special Operations Command (USSOCOM) impose strict continuous monitoring and accreditation requirements.',
      '+ Failure to maintain FedRAMP High and DoD IL6 authorization could terminate existing multi-year Task Orders prematurely.',
    ],
    removedLines: [],
    criticalTriggers: ['DoD IL6 Authorization', 'Task Order termination clause'],
  },
];

const SEED_VOCAL_STRESS: VocalStressData[] = [
  {
    id: 'voc-1',
    symbol: 'TSLA',
    quarter: 'Q2 2026 Earnings Call',
    executive: 'Chief Financial Officer',
    f0Jitter: 0.042,
    shimmer: 0.078,
    pauseRatio: 0.38,
    stressScore: 0.74,
    evasiveAnswersDetected: 3,
  },
  {
    id: 'voc-2',
    symbol: 'NVDA',
    quarter: 'Q2 2026 Earnings Call',
    executive: 'Executive VP & CFO',
    f0Jitter: 0.015,
    shimmer: 0.022,
    pauseRatio: 0.12,
    stressScore: 0.18,
    evasiveAnswersDetected: 0,
  },
];

const SEED_CONTRACTS: ContractData[] = [
  {
    id: 'ct-1',
    symbol: 'LMT',
    awardId: 'W58RGZ-26-C-0012',
    recipient: 'Lockheed Martin Corp',
    agency: 'DoD - Department of the Army',
    amount: 1_240_000_000,
    date: '2026-09-28',
    description: 'PAC-3 Missile Segment Enhancement (MSE) interceptor production and associated telemetry kits.',
  },
  {
    id: 'ct-2',
    symbol: 'PLTR',
    awardId: 'FA8730-26-C-0044',
    recipient: 'Palantir Technologies Inc',
    agency: 'DoD - US Air Force',
    amount: 480_000_000,
    date: '2026-09-15',
    description: 'Project Maven AI-enabled multi-domain sensor fusion and command post automation nodes.',
  },
  {
    id: 'ct-3',
    symbol: 'RTX',
    awardId: 'N00019-26-C-0089',
    recipient: 'Raytheon Technologies',
    agency: 'DoD - Department of the Navy',
    amount: 675_000_000,
    date: '2026-09-02',
    description: 'Standard Missile-6 (SM-6) Block IB dual-capability air defense and strike systems.',
  },
];

const SEED_CAPITOL_TRADES: CapitolTradeData[] = [
  {
    id: 'cap-1',
    symbol: 'LMT',
    politician: 'Sen. Mark Kelly',
    chamber: 'Senate',
    transactionType: 'Purchase',
    amountRange: '$100,001 - $250,000',
    committee: 'Senate Armed Services Committee',
    date: '2026-09-24',
  },
  {
    id: 'cap-2',
    symbol: 'NVDA',
    politician: 'Rep. Nancy Pelosi',
    chamber: 'House',
    transactionType: 'Purchase',
    amountRange: '$500,001 - $1,000,000',
    committee: 'House Leadership / Strategic Tech',
    date: '2026-09-18',
  },
  {
    id: 'cap-3',
    symbol: 'PLTR',
    politician: 'Sen. Dan Sullivan',
    chamber: 'Senate',
    transactionType: 'Purchase',
    amountRange: '$50,001 - $100,000',
    committee: 'Senate Armed Services / Cybersecurity',
    date: '2026-09-10',
  },
];

const SEED_JETS: CorporateJetData[] = [
  {
    id: 'jet-1',
    symbol: 'NVDA',
    tailNumber: 'N104NV',
    icao24: 'A045B2',
    origin: 'KSJC (San Jose)',
    destination: 'LSZH (Zurich)',
    hubName: 'Zurich Financial / M&A Hub',
    isMaHub: true,
    date: '2026-10-02',
  },
  {
    id: 'jet-2',
    symbol: 'TSLA',
    tailNumber: 'N272BG',
    icao24: 'A2B5E1',
    origin: 'KAUS (Austin)',
    destination: 'KOMA (Omaha)',
    hubName: 'Omaha Private Executive Hub',
    isMaHub: true,
    date: '2026-09-29',
  },
];

const SEED_TALENT: Record<string, TalentData> = {
  NVDA: {
    symbol: 'NVDA',
    talentDeltaPct: 22.4,
    rdOpenings: 480,
    totalOpenings: 820,
    hiringFreeze: false,
  },
  TSLA: {
    symbol: 'TSLA',
    talentDeltaPct: -14.6,
    rdOpenings: 85,
    totalOpenings: 190,
    hiringFreeze: true,
  },
  PLTR: {
    symbol: 'PLTR',
    talentDeltaPct: 18.2,
    rdOpenings: 120,
    totalOpenings: 240,
    hiringFreeze: false,
  },
  LMT: {
    symbol: 'LMT',
    talentDeltaPct: 5.1,
    rdOpenings: 310,
    totalOpenings: 950,
    hiringFreeze: false,
  },
  'SIM-DEMO': {
    symbol: 'SIM-DEMO',
    talentDeltaPct: 11.5,
    rdOpenings: 45,
    totalOpenings: 95,
    hiringFreeze: false,
  },
};

const SEED_MACRO: MacroStressData = {
  sofrRate: 4.82,
  hySpreadBps: 342.0,
  yieldCurve10Y2Y: -0.14,
  stressRegime: 'NORMAL',
  updatedAt: Date.now(),
};

export const useIntelligenceStore = create<IntelligenceState>((set, get) => ({
  drawerOpen: false,
  activeTab: 'DOCS',
  gex: SEED_GEX,
  darkPool: SEED_DARK_POOL,
  secDiffs: SEED_SEC_DIFFS,
  vocalStress: SEED_VOCAL_STRESS,
  contracts: SEED_CONTRACTS,
  capitolTrades: SEED_CAPITOL_TRADES,
  corporateJets: SEED_JETS,
  talent: SEED_TALENT,
  macro: SEED_MACRO,

  setDrawerOpen: (open, tab) =>
    set({ drawerOpen: open, ...(tab ? { activeTab: tab } : {}) }),

  toggleDrawer: (tab) =>
    set((s) => ({
      drawerOpen: tab ? (s.drawerOpen && s.activeTab === tab ? false : true) : !s.drawerOpen,
      ...(tab ? { activeTab: tab } : {}),
    })),

  setActiveTab: (tab) => set({ activeTab: tab }),

  ingestGex: (update) => {
    set((state) => {
      const g = {
        symbol: update.symbol,
        spotPrice: update.spot_price,
        netGex: update.net_gex,
        callWall: update.call_wall,
        putWall: update.put_wall,
        gammaFlip: update.gamma_flip,
        updatedAt: Date.now(),
      };
      return {
        gex: { ...state.gex, [update.symbol]: g },
      };
    });
  },

  ingestMacro: (update) => {
    set({
      macro: {
        sofrRate: update.sofr_rate,
        hySpreadBps: update.hy_spread_bps,
        yieldCurve10Y2Y: update.yield_curve_10y2y,
        stressRegime:
          update.stress_regime === 'severe'
            ? 'SEVERE'
            : update.stress_regime === 'elevated'
              ? 'ELEVATED'
              : 'NORMAL',
        updatedAt: Date.now(),
      },
    });
  },

  ingestIntel: (intel) => {
    try {
      const payload = typeof intel.payload === 'string' ? JSON.parse(intel.payload) : intel.payload;
      if (intel.category === 'sec_diff' && payload) {
        set((s) => ({
          secDiffs: [
            {
              id: `live-${Date.now()}`,
              symbol: intel.symbol,
              filingType: payload.filing_type ?? '10-Q Item 1A',
              filedDate: 'Just now',
              title: payload.title ?? 'Updated Risk Disclosures',
              addedLines: payload.added_lines ?? [],
              removedLines: payload.removed_lines ?? [],
              criticalTriggers: payload.critical_triggers ?? [],
            },
            ...s.secDiffs,
          ].slice(0, 30),
        }));
      } else if (intel.category === 'defense_contract' && payload) {
        set((s) => ({
          contracts: [
            {
              id: `live-${Date.now()}`,
              symbol: intel.symbol,
              awardId: payload.award_id ?? 'USA-AWARD',
              recipient: payload.recipient ?? intel.symbol,
              agency: payload.agency ?? 'US Department of Defense',
              amount: payload.amount ?? 0,
              date: new Date().toISOString().slice(0, 10),
              description: payload.description ?? intel.headline,
            },
            ...s.contracts,
          ].slice(0, 30),
        }));
      } else if (intel.category === 'capitol_trade' && payload) {
        set((s) => ({
          capitolTrades: [
            {
              id: `live-${Date.now()}`,
              symbol: intel.symbol,
              politician: payload.politician ?? 'Congress Member',
              chamber: payload.chamber === 'Senate' ? 'Senate' : 'House',
              transactionType: payload.type === 'Sale' ? 'Sale' : 'Purchase',
              amountRange: payload.amount_range ?? '$50,000 - $100,000',
              committee: payload.committee ?? 'Standing Committee',
              date: new Date().toISOString().slice(0, 10),
            },
            ...s.capitolTrades,
          ].slice(0, 30),
        }));
      } else if (intel.category === 'jet_flight' && payload) {
        set((s) => ({
          corporateJets: [
            {
              id: `live-${Date.now()}`,
              symbol: intel.symbol,
              tailNumber: payload.tail_number ?? 'N-CORP',
              icao24: payload.icao24 ?? 'ICAO',
              origin: payload.origin ?? 'Origin',
              destination: payload.destination ?? 'Dest',
              hubName: payload.hub_name ?? 'Financial Hub',
              isMaHub: payload.is_ma_hub ?? true,
              date: new Date().toISOString().slice(0, 10),
            },
            ...s.corporateJets,
          ].slice(0, 30),
        }));
      }
    } catch (e) {
      console.warn('[flowmap] intel ingest parse error', e);
    }
  },

  handleStreamMsg: (msg: StreamMsg) => {
    if (msg.type === MsgType.GEX_UPDATE) {
      get().ingestGex(msg as GexLevelUpdate);
    } else if (msg.type === MsgType.MACRO_STRESS) {
      get().ingestMacro(msg as MacroStressUpdate);
    } else if (msg.type === MsgType.MARKET_INTELLIGENCE) {
      get().ingestIntel(msg as MarketIntelligence);
    }
  },
}));
