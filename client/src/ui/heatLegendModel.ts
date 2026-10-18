/** One resolved descriptor for the on-screen scale and exported PNG. */
import { rampCssGradient, rampCssGradientReversed, rampForColormap, RAMP_IMBALANCE, RAMP_SYNTH, RAMP_THEME, RAMP_THEME_SYNTH, type Colormap } from '../gl/lut';
import { resolveAppearance, stopsGradient } from '../theme/appearance';
import type { ThemeId, ChartStop } from '../theme/registry';
import type { DepthChannelMode } from './settings';
export interface LegendInput {
   channel?: DepthChannelMode;
   colormap: Colormap;
   synth?: boolean;
   theme?: ThemeId;
   tier?: string;
}
export interface LegendDescriptor {
   row: number;
   gradient: string;
   topCap: string;
   bottomCap: string;
   channelNote: string | null;
   rampName: string;
   effectiveChannel: DepthChannelMode;
}
export function resolveLegend(input: LegendInput, density?: readonly ChartStop[] | null, synthStops?: readonly ChartStop[] | null): LegendDescriptor {
  const { colormap, synth } = input;
  const channel = synth ? 'sum' : input.channel ?? 'sum';
  const appearance = input.theme ? resolveAppearance(input.theme, colormap) : null;
  const activeDensity = appearance?.density ?? density;
  const activeSynth = appearance?.synth ?? synthStops;
  let row: number;
  let gradient: string;
  let rampName: string;
  if (synth) {
   row = activeSynth ? RAMP_THEME_SYNTH : RAMP_SYNTH;
   gradient = activeSynth ? stopsGradient(activeSynth) : rampCssGradient(row);
   rampName = 'synthetic amber colormap';
  } else if (channel === 'imbalance') {
   row = RAMP_IMBALANCE;
   gradient = appearance ? stopsGradient(appearance.imbalance, true) : rampCssGradientReversed(row);
   rampName = 'divergent imbalance (ask blue → bid amber)';
  } else {
   row = activeDensity ? RAMP_THEME : rampForColormap(colormap);
   gradient = activeDensity ? stopsGradient(activeDensity) : rampCssGradient(row);
   rampName = `${colormap} colormap`;
  }
  return { row, gradient, rampName, effectiveChannel: channel,
   topCap: channel === 'imbalance' ? 'ask-heavy' : 'more',
   bottomCap: channel === 'imbalance' ? 'bid-heavy' : 'less',
   channelNote: channel === 'bid' ? 'bid depth' : channel === 'ask' ? 'ask depth' : null };
}
