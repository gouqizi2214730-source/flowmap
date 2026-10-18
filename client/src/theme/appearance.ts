/** Pure, cached appearance resolution shared by GL, legends, export and previews. */
import { THEMES, type ChartStop, type ThemeId } from './registry';
import type { ThemeRampStops } from '../gl/lut';
import type { Colormap } from './colormaps';
export { COLORMAP_CATALOG, isColormap } from './colormaps';
type Colors = readonly string[];
// Light variants encode more density with darker ink; hue paths are authored independently.
const DARK: Record<Exclude<Colormap, 'theme'>, Colors> = {
 flow: ['#143A18','#27652B','#4F9345','#96C768','#E0E59A'],
 inferno: ['#371C4D','#71315D','#B45B5D','#DF9870','#F1D497'],
 classic: ['#102B88','#087D9E','#30B985','#D0CA4B','#FFE58A'],
 ice: ['#121F55','#203D91','#346ED2','#70AEEC','#C4E7FA'],
 viridis: ['#472063','#315595','#159C91','#6CCB6E','#E4E46C'],
 cividis: ['#102D75','#3B5E94','#7B8D85','#BFB74A','#F1DE73'],
 mono: ['#2B2B2B','#545454','#858585','#B7B7B7','#E5E5E5'],
};
const LIGHT: Record<Exclude<Colormap, 'theme'>, Colors> = {
 flow: ['#C7E8B8','#93BE76','#65933F','#3B681D','#1D3B0A'],
 inferno: ['#EACCA7','#D09F87','#A56D79','#6E4265','#382747'],
 // Keep the thermal family distinct from Inferno's peach-to-purple light ramp.
 classic: ['#BDEDEE','#83C298','#C88735','#AB3924','#4C182C'],
 ice: ['#BFE8FA','#80BCEB','#4889D0','#2358A7','#102C72'],
 viridis: ['#DDED97','#A3D16A','#4BA883','#237A91','#48245F'],
 cividis: ['#EDE4AA','#CABC57','#97952E','#586F36','#203B62'],
 mono: ['#D9D9D9','#B0B0B0','#858585','#565656','#202020'],
};
export function hexRgb(hex: string): readonly [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function ramp(colors: Colors): readonly ChartStop[] {
  return colors.map((color, i) => ({ t: i / (colors.length - 1), rgb: hexRgb(color) }));
}

export interface Appearance extends ThemeRampStops {
  readonly id: string;
  readonly key: string;
  readonly themeId: ThemeId;
  readonly colormap: Colormap;
  readonly imbalance: readonly ChartStop[];
}

const cache = new Map<string, Appearance>();

export function resolveAppearance(themeId: ThemeId, colormap: Colormap): Appearance {
  const key = `${themeId}|${colormap}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const theme = THEMES[themeId];
  const bg = theme.chart.bg;
  const density = colormap === 'theme'
    ? theme.chart.density
    : ramp([bg, ...(theme.mode === 'light' ? LIGHT : DARK)[colormap]]);
  const imbalance = [
    { t: 0, rgb: hexRgb(theme.mode === 'light' ? '#185D98' : '#94CAFF') },
    // Both centre texels are neutral; signed zero does not acquire a side tint.
    { t: 127 / 255, rgb: hexRgb(bg) },
    { t: 128 / 255, rgb: hexRgb(bg) },
    { t: 1, rgb: hexRgb(theme.mode === 'light' ? '#925010' : '#FFCE6E') },
  ];
  const result: Appearance = { id: key, key, themeId, colormap, density, synth: theme.chart.synth, imbalance };
  cache.set(key, result);
  return result;
}

export function stopsGradient(stops: readonly ChartStop[], reverse = false): string {
  const ordered = reverse ? [...stops].reverse().map(s => ({ ...s, t: 1 - s.t })) : stops;
  return ordered.map(s => `rgb(${s.rgb.map(Math.round).join(', ')}) ${(s.t * 100).toFixed(1)}%`).join(', ');
}
