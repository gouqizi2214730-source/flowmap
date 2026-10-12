import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MsgType } from '../proto/types';
import { DEMO_INTELLIGENCE, useIntelligenceStore } from '../state/intelligenceStore';
import { IntelligenceDrawer } from './IntelligenceDrawer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => useIntelligenceStore.setState(useIntelligenceStore.getInitialState(), true));

afterEach(() => {
  for (const { container, root } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
});

describe('IntelligenceDrawer', () => {
  it('renders drawer header, tabs, and default DOCS tab', () => {
    const onClose = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={onClose} />);

    expect(container.textContent).toContain('DEEP INTELLIGENCE <GO>');
    expect(container.querySelector('[data-testid="pane-docs"]')).not.toBeNull();
    expect(container.textContent).toContain('Risk Factors Semantic Diff Engine');
    expect(container.textContent).toContain('Call Transcript & Acoustic Metrics');
    expect(container.textContent).toContain('text phrase matches do not establish stress or deception');
  });

  it('switches between tabs (GOV, FLOW, GEO)', () => {
    const onClose = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={onClose} />);

    // Switch to GOV
    const tabGov = container.querySelector('[data-testid="tab-gov"]');
    expect(tabGov).not.toBeNull();
    click(tabGov!);
    expect(container.querySelector('[data-testid="pane-gov"]')).not.toBeNull();
    expect(container.textContent).toContain('Government & Defense Contracts');
    expect(container.textContent).toContain('Congressional & Senate Trades');

    // Switch to FLOW
    const tabFlow = container.querySelector('[data-testid="tab-flow"]');
    expect(tabFlow).not.toBeNull();
    click(tabFlow!);
    expect(container.querySelector('[data-testid="pane-flow"]')).not.toBeNull();
    expect(container.textContent).toContain('Gamma Exposure (GEX) Microstructure');
    expect(container.textContent).toContain('Dark Pool (Off-Exchange) TRF Volumes');
    expect(container.textContent).toContain('Unavailable — no connected source supplied data.');
    expect(container.querySelector('.gex-summary-card')).toBeNull();

    // Switch to GEO
    const tabGeo = container.querySelector('[data-testid="tab-geo"]');
    expect(tabGeo).not.toBeNull();
    click(tabGeo!);
    expect(container.querySelector('[data-testid="pane-geo"]')).not.toBeNull();
    expect(container.textContent).toContain('Corporate Jet M&A Radar');
    expect(container.textContent).toContain('Talent Velocity & Headcount Velocity');
  });

  it('renders the Institutional Macro Stress Ticker bar', () => {
    const onClose = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={onClose} />);

    const macroBar = container.querySelector('[data-testid="intel-macro-bar"]');
    expect(macroBar).not.toBeNull();
    expect(container.textContent).toContain('SOFR');
    expect(container.textContent).toContain('HY SPREAD');
    expect(container.textContent).toContain('10Y-2Y YIELD CURVE');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={onClose} />);

    const closeBtn = container.querySelector('[data-testid="intel-drawer-close"]');
    expect(closeBtn).not.toBeNull();
    click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not substitute SIM-DEMO data for an unknown live symbol', () => {
    useIntelligenceStore.setState({ activeTab: 'FLOW', gex: { 'SIM-DEMO': DEMO_INTELLIGENCE.gex['SIM-DEMO'] }, darkPool: { 'SIM-DEMO': DEMO_INTELLIGENCE.darkPool['SIM-DEMO'] } });
    const { container } = render(<IntelligenceDrawer activeSymbol="UNKNOWN" onClose={vi.fn()} />);
    expect(container.querySelector('.gex-summary-card')).toBeNull();
    expect(container.querySelector('.darkpool-card')).toBeNull();
    expect(container.querySelector('[data-testid="intel-demo-label"]')).toBeNull();
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('MACRO UNAVAILABLE');
    expect(container.textContent).not.toContain('0.00%');
  });

  it('labels SIM-DEMO fixture values and keeps them outside live state', () => {
    useIntelligenceStore.setState({ activeTab: 'FLOW' });
    const { container } = render(<IntelligenceDrawer activeSymbol="SIM-DEMO" onClose={vi.fn()} />);
    expect(container.querySelector('[data-testid="intel-demo-label"]')?.textContent).toContain('all values, names and events below are synthetic');
    expect(container.textContent).toContain('CALL WALL (CEILING)');
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('DEMO');
    expect(useIntelligenceStore.getState().gex).toEqual({});
    expect(useIntelligenceStore.getState().macro).toBeNull();
  });

  it('renders actual received GEX and macro instead of the unavailable state', () => {
    const store = useIntelligenceStore.getState();
    store.setActiveTab('FLOW');
    store.ingestGex({ type: MsgType.GEX_UPDATE, symbol: 'NVDA', spot_price: 130, net_gex: 12_000, call_wall: 137, put_wall: 119, gamma_flip: 127 });
    store.ingestMacro({ type: MsgType.MACRO_STRESS, ts_ns: 1n, sofr: 5.32, hy_spread: 3.42, yield_10y2y: -0.18, stress_score: 0.4, status: 'ELEVATED' });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    expect(container.querySelector('.gex-summary-card')?.textContent).toContain('$137.00');
    expect(container.querySelector('.gex-summary-card')?.textContent).toContain('NET GEX (MODEL)');
    expect(container.querySelector('.gex-summary-card')?.textContent).toContain('M / 100% spot move');
    expect(container.querySelector('.gex-summary-card')?.textContent).not.toContain('M/pt');
    expect(container.textContent).toContain('dealer inventory is unknown');
    expect(container.querySelector('[data-testid="intel-macro-bar"]')?.textContent).toContain('342 bps');
    expect(container.querySelector('[data-testid="intel-demo-label"]')).toBeNull();
  });

  it('shows plain unknown intelligence content without inventing people or filings', () => {
    useIntelligenceStore.getState().ingestIntel({ type: MsgType.MARKET_INTELLIGENCE, ts_ns: 1n, symbol: 'NVDA', kind: 'unknown_kind', headline: 'Received headline', detail: 'Plain source detail', source: 'Received source' });
    const { container } = render(<IntelligenceDrawer activeSymbol="NVDA" onClose={vi.fn()} />);
    const received = container.querySelector('[data-testid="intel-received-events"]');
    expect(received?.textContent).toContain('unknown_kind');
    expect(received?.textContent).toContain('Plain source detail');
    expect(received?.textContent).toContain('Received source');
    expect(container.textContent).not.toContain('Chief Financial Officer');
    expect(container.querySelector('.intel-card--diff')).toBeNull();
  });
});
