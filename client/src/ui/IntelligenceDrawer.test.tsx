import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(container.textContent).toContain('Vocal Stress & Deception Telemetry');
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
    expect(container.textContent).toContain('CALL WALL (CEILING)');
    expect(container.textContent).toContain('PUT WALL (FLOOR)');

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
});
