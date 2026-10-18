/** Pure, cached appearance resolution shared by GL, legends, export and previews. */
import { THEMES, type ChartStop, type ThemeId } from './registry';
import type { ThemeRampStops } from '../gl/lut';
import type { Colormap } from './colormaps';
export { COLORMAP_CATALOG, isColormap } from './colormaps';
type Colors = readonly string[];
// Light variants encode more density with darker ink; hue paths are authored independently.
const DARK: Record<Exclude<Colormap, 'theme'>, Colors> = {
 flow: ['#12304A','#20556C','#42878E','#89B4AE','#D3D8AB'],
 inferno: ['#371C4D','#71315D','#B45B5D','#DF9870','#F1D497'],
 classic: ['#162B66','#225D9A','#4C9DAF','#B1C48B','#F0DD8C'],
 ice: ['#16384C','#28637E','#4994B1','#8CC4D4','#D0E6EC'],
 viridis: ['#3E295E','#3D597B','#3F8A85','#83BA75','#E0D985'],
 cividis: ['#1D345B','#4E617D','#858C8A','#BAB78C','#EBDD9A'],
 mono: ['#30373F','#59616A','#869099','#B6BEC5','#E3E8EC'],
};
const LIGHT: Record<Exclude<Colormap, 'theme'>, Colors> = {
 flow: ['#C1DCE0','#8DBBC2','#548E9C','#2E6177','#163A50'],
 inferno: ['#EACCA7','#D09F87','#A56D79','#6E4265','#382747'],
 // Keep the thermal family distinct from Inferno's peach-to-purple light ramp.
 classic: ['#BDEDEE','#83C298','#C88735','#AB3924','#4C182C'],
 ice: ['#C8DFE8','#93BCCF','#6095B1','#356986','#173E56'],
 viridis: ['#D6DDA6','#A1BC91','#669384','#3A6676','#342E52'],
 cividis: ['#DED6AB','#B7B08B','#858D80','#526777','#243C5B'],
 mono: ['#D3D8DD','#A6AFB8','#7A8794','#4D5F71','#203448'],
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
