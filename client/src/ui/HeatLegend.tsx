/** Liquidity scale from the same resolved descriptor used by PNG export. */
import type { Colormap } from '../gl/lut';
import type { DepthChannelMode } from './settings';
import { useFlowMapStore } from '../state/store';
import { useTheme } from '../theme';
import { depthTier } from './DomLadder';
import { resolveLegend } from './heatLegendModel';
import type { ChartStop } from '../theme/registry';
interface HeatLegendProps { colormap: Colormap; channel: DepthChannelMode }
export type LegendStop = ChartStop;
/** Compatibility wrapper; all routing belongs to the shared legend model. */
export function legendForChannel(channel: DepthChannelMode, colormap: Colormap, synth: boolean, themeStops?: readonly LegendStop[] | null, themeSynthStops?: readonly LegendStop[] | null) {
 return resolveLegend({channel,colormap,synth},themeStops,themeSynthStops);
}

export function HeatLegend({ colormap, channel }: HeatLegendProps): JSX.Element {
  const { theme } = useTheme();
  const capability = useFlowMapStore((s) => s.capability);
  const tier = depthTier(capability, null);
  const synth = tier === 'SYNTH';
  const legend = resolveLegend({ channel, colormap, synth, theme });
  const channelSuffix =
    channel === 'sum' || synth ? '' : `, ${channel} channel`;
  return (
    <div
      className={`heat-legend${synth ? ' heat-legend--synth' : ''}${
        !synth && channel === 'imbalance' ? ' heat-legend--divergent' : ''
      }`}
      data-testid="heat-legend"
      data-channel={legend.effectiveChannel}
      role="img"
      aria-label={`Liquidity scale, ${legend.rampName}${channelSuffix}${tier ? `, ${tier} depth` : ''}`}
    >
      <span className="heat-legend__cap">{legend.topCap}</span>
      <div
        className="heat-legend__bar"
        data-testid="heat-legend-bar"
        data-ramp={legend.row}
        style={{
          background: `linear-gradient(to top, ${legend.gradient})`,
          // Bookmap-style swatch frame: the ramp's low end is near-black on the
          // midnight chip (invisible edge), so every legend — not just the
          // divergent one (CSS keeps its own rule) — gets a defined outline.
          // `width` compensates the 2×1px border (border-box) so the painted
          // gradient keeps its original 8px stem.
          border: '1px solid var(--chart-chip-border, #1a2030)',
          width: 10,
        }}
        aria-hidden="true"
      />
      <span className="heat-legend__cap">{legend.bottomCap}</span>
      <span className="heat-legend__tier" data-testid="heat-legend-tier">
        {tier ?? 'liq'}
      </span>
      {legend.channelNote !== null && (
        <span className="heat-legend__channel" data-testid="heat-legend-channel">
          {legend.channelNote}
        </span>
      )}
    </div>
  );
}
