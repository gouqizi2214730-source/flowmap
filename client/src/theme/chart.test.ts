import { afterEach, describe, expect, it } from 'vitest';
import { buildRamp, buildLUTAtlas, clearColorForRamp, setThemeStops, RAMP_THEME, RAMP_THEME_SYNTH, RAMP_IMBALANCE, rampForMode } from '../gl/lut';
import { MODE_L2, MODE_L1_BAND } from '../proto/types';
import { THEMES, THEME_IDS } from './registry';
import { COLORMAP_CATALOG, resolveAppearance, hexRgb } from './appearance';
import { applyChartInk, applyOverlayPalette, OVERLAY, parseCssColor } from '../gl/overlays/palette';
import { resolveLegend } from '../ui/heatLegendModel';
import { exportGradientStops } from '../ui/exportPng';
import { normalizeSettings } from '../ui/settings';
function lum(rgb: readonly number[] | Uint8Array): number { const c = Array.from(rgb).slice(0,3).map(v => {const s=v/255; return s<=.04045?s/12.92:((s+.055)/1.055)**2.4}); return .2126*c[0]+.7152*c[1]+.0722*c[2] }
function contrast(a: readonly number[] | Uint8Array, b: readonly number[] | Uint8Array): number { const x=lum(a),y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
afterEach(() => {setThemeStops(null);applyOverlayPalette(null)});
describe('adaptive appearance matrix', () => {
 for (const id of THEME_IDS) for (const {id:family} of COLORMAP_CATALOG) it(`${id} × ${family}: density, synth, imbalance, price and legend`, () => {
  const a=resolveAppearance(id,family), t=THEMES[id], bg=hexRgb(t.chart.bg);
  expect(resolveAppearance(id,family)).toBe(a);
  expect(a.density[0].rgb).toEqual(bg); expect(a.synth[0].rgb).toEqual(bg);
  setThemeStops(a);
  expect(clearColorForRamp(RAMP_THEME)).toEqual([...bg.map(c=>c/255),1]);
  expect(clearColorForRamp(RAMP_THEME_SYNTH)).toEqual([...bg.map(c=>c/255),1]);
  const atlas=buildLUTAtlas();
  expect([...atlas.slice(RAMP_IMBALANCE*1024+127*4,RAMP_IMBALANCE*1024+127*4+3)]).toEqual(bg);
  expect([...atlas.slice(RAMP_IMBALANCE*1024+128*4,RAMP_IMBALANCE*1024+128*4+3)]).toEqual(bg);
  applyOverlayPalette(t.canvas); applyChartInk(t.chart);
  const price=parseCssColor(OVERLAY.price.css)!,halo=parseCssColor(OVERLAY.priceHalo.css)!;
  expect(halo[3]).toBe(1);
  for (const [name,stops] of [['density',a.density],['synth',a.synth]] as const) {
   const ramp=buildRamp(stops); let previous=lum(ramp.slice(0,3));
   for(let i=0;i<256;i++) {
    const px=ramp.slice(i*4,i*4+3), l=lum(px);
    // < .002 relative luminance tolerates at most a single sRGB byte-rounding step.
    expect(t.mode==='light'?l-previous:previous-l,`${name} monotonic @${i}`).toBeLessThanOrEqual(.002);
    expect(Math.max(contrast(price,px),contrast(halo,px)),`${name} price @${i}`).toBeGreaterThanOrEqual(3);
    previous=l;
   }
  }
  for (const stop of a.synth.slice(1)) {expect(stop.rgb[0]).toBeGreaterThanOrEqual(stop.rgb[1]);expect(stop.rgb[1]).toBeGreaterThanOrEqual(stop.rgb[2]);}
  expect(a.synth).not.toEqual(a.density);
  expect(rampForMode(MODE_L2,'L2',family,{density:5,synth:6})).toBe(5);
  expect(rampForMode(MODE_L1_BAND,'SYNTH',family,{density:5,synth:6})).toBe(6);
  for (const channel of ['sum','bid','ask','imbalance'] as const) {
   const legend=resolveLegend({theme:id,colormap:family,channel});
   const exported=exportGradientStops(legend.gradient);
   expect(exported[0].t).toBe(0);expect(exported.at(-1)!.t).toBe(1);
   for(let i=1;i<exported.length;i++) expect(exported[i].t).toBeGreaterThanOrEqual(exported[i-1].t);
   if(channel==='imbalance') {expect(legend.topCap).toBe('ask-heavy');expect(legend.row).toBe(4)}
   const synth=resolveLegend({theme:id,colormap:family,channel,synth:true});
   expect(synth.effectiveChannel).toBe('sum');expect(synth.row).toBe(6);expect(synth.topCap).toBe('more');
  }
  for(const key of ['axis','vwap','cvd','liquidation','event','unknown'] as const) expect(contrast(parseCssColor(OVERLAY[key].css)!,bg),key).toBeGreaterThanOrEqual(3);
  expect(contrast(hexRgb(t.chart.inkDim),hexRgb(t.chart.gutterBg))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(hexRgb(t.canvas.bid),hexRgb(t.chart.gutterBg))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(hexRgb(t.canvas.ask),hexRgb(t.chart.gutterBg))).toBeGreaterThanOrEqual(4.5);
  expect(normalizeSettings({settingsVersion:2,colormap:family}).colormap).toBe(family);
 });
});
