/** Price-family key resolved from the current theme, independently of canvas bridge timing. */
import { resolveOverlayColors } from '../gl/overlays/palette';
import { THEMES, useTheme, type ThemeId } from '../theme';
import './ChartLegend.css';

/** Swatch shape: a line (price-family), a teal/red line pair (BBO), or a dot pair (trades). */
type SwatchKind = 'line' | 'pair' | 'dots';

interface LegendItem {
  label: string;
  kind: SwatchKind;
  /** One color for `line`; two for `pair` / `dots`. */
  colors: readonly string[];
}

/** The same pure palette the canvas bridge applies after React renders. */
function legendItems(theme: ThemeId): LegendItem[] {
  const colors = resolveOverlayColors(THEMES[theme].canvas, THEMES[theme].chart);
  return [
    { label: 'Last price', kind: 'line', colors: [colors.price] },
    { label: 'VWAP', kind: 'line', colors: [colors.vwap] },
    { label: 'BBO', kind: 'pair', colors: [colors.bid, colors.ask] },
    { label: 'Trades', kind: 'dots', colors: [colors.buy, colors.sell] },
  ];
}

export function ChartLegend(): JSX.Element {
  const { theme } = useTheme();
  const items = legendItems(theme);
  return (
    <div
      className="chart-legend"
      data-testid="chart-legend"
      role="img"
      aria-label="Chart legend: last price, VWAP, best bid and ask, trades"
    >
      {items.map((item) => (
        <span className="chart-legend__item" key={item.label}>
          {item.kind === 'line' && (
            <span
              className="chart-legend__line"
              data-swatch="line"
              style={{ background: item.colors[0] }}
              aria-hidden="true"
            />
          )}
          {item.kind === 'pair' && (
            <span className="chart-legend__pair" data-swatch="pair" aria-hidden="true">
              <span className="chart-legend__line" style={{ background: item.colors[0] }} />
              <span className="chart-legend__line" style={{ background: item.colors[1] }} />
            </span>
          )}
          {item.kind === 'dots' && (
            <span className="chart-legend__dots" data-swatch="dots" aria-hidden="true">
              <span className="chart-legend__dot" style={{ background: item.colors[0] }} />
              <span className="chart-legend__dot" style={{ background: item.colors[1] }} />
            </span>
          )}
          <span className="chart-legend__label">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
