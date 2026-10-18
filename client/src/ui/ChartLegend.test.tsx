/** Theme-store regressions for DOM swatches and the App-style passive canvas bridge. */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OVERLAY, applyChartInk, applyOverlayPalette, resolveOverlayColors } from '../gl/overlays/palette';
import { getCanvasPalette, resetThemeStoreForTest, setTheme, THEMES, THEME_IDS, useTheme } from '../theme';
import { ChartLegend } from './ChartLegend';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLElement | null = null;
let root: Root | null = null;

/** Same ordering as App: child renders, then the parent applies canvas colors. */
function AppStyleThemeBridge() {
  const {theme} = useTheme();
  useEffect(() => {
    applyOverlayPalette(getCanvasPalette(theme));
    applyChartInk(THEMES[theme].chart);
  }, [theme]);
  return <ChartLegend />;
}

function render(): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<AppStyleThemeBridge />); });
  return container;
}
function normalizedColor(value: string): string {
  const probe = document.createElement('span'); probe.style.color = value; return probe.style.color;
}
function colors(el: HTMLElement, selector: string): string[] {
  return [...el.querySelectorAll<HTMLElement>(selector)].map(e => e.style.backgroundColor);
}

beforeEach(() => {
  localStorage.clear(); resetThemeStoreForTest(); applyOverlayPalette(null);
  act(() => setTheme('midnight'));
});
afterEach(() => {
  if(root) act(() => root!.unmount());
  container?.remove(); container = null; root = null;
  applyOverlayPalette(null);
});

describe('ChartLegend', () => {
  it('renders the four price-family keys in English', () => {
    const el = render().querySelector('[data-testid="chart-legend"]')!;
    expect([...el.querySelectorAll('.chart-legend__label')].map(n => n.textContent)).toEqual(['Last price','VWAP','BBO','Trades']);
    expect(el.getAttribute('aria-label')).toContain('last price');
  });

  it('resolves the same price, category and market colors as the chart bridge', () => {
    const el = render();
    for(const id of THEME_IDS) {
      act(() => setTheme(id));
      const expected = resolveOverlayColors(THEMES[id].canvas, THEMES[id].chart);
      expect(colors(el,'[data-swatch="line"]')).toEqual([expected.price,expected.vwap].map(normalizedColor));
      expect(colors(el,'[data-swatch="pair"] .chart-legend__line')).toEqual([expected.bid,expected.ask].map(normalizedColor));
      expect(colors(el,'[data-swatch="dots"] .chart-legend__dot')).toEqual([expected.buy,expected.sell].map(normalizedColor));
      expect(normalizedColor(OVERLAY.price.css)).toBe(normalizedColor(expected.price));
      expect(normalizedColor(OVERLAY.vwap.css)).toBe(normalizedColor(expected.vwap));
    }
  });

  it('is non-interactive chrome', () => {
    const el = render().querySelector('[data-testid="chart-legend"]')!;
    expect(el.getAttribute('role')).toBe('img'); expect(el.querySelector('button,a,[tabindex]')).toBeNull();
  });

  it('matches settled Midnight boot and a real Paper theme switch without rerendering after the parent mutation', () => {
    expect(OVERLAY.price.css).toBe('rgba(245, 248, 252, 1)');
    const el = render();
    expect(colors(el,'[data-swatch="line"]')).toEqual(['rgb(255, 255, 255)','rgb(207, 172, 243)']);
    expect(colors(el,'[data-swatch="line"]')).toEqual([OVERLAY.price.css,OVERLAY.vwap.css].map(normalizedColor));
    // Only the store notification re-renders React. No root.render follows bridge effects.
    act(() => setTheme('paper'));
    expect(colors(el,'[data-swatch="line"]')).toEqual(['rgb(53, 40, 24)','rgb(113, 60, 160)']);
    expect(colors(el,'[data-swatch="line"]')).toEqual([OVERLAY.price.css,OVERLAY.vwap.css].map(normalizedColor));
  });
});
