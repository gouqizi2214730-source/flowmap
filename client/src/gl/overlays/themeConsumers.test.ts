import { afterEach, describe, expect, it, vi } from 'vitest';

import { THEMES, type ThemeId } from '../../theme/registry';
import { MsgType, type BarColumn, type Marker } from '../../proto/types';
import { TextLayer } from '../textLayer';
import { makeFake2D, makeFakeGL } from '../mockGL';
import { ViewWorker } from '../viewWorker';
import { Bbo } from './bbo';
import { GridMap } from './coords';
import type { OverlayFrame } from './frame';
import { GexOverlay } from './gexLevels';
import { OverlayManager, type OverlayDrawContext } from './manager';
import { Markers } from './markers';
import { applyChartInk, applyOverlayPalette, parseCssColor } from './palette';
import { Profile } from './profile';
import type { RGBA } from './primitives';
import { VOLBAR_ALPHA } from './volbars';

interface Paint { color: string; alpha: number; label?: string; box?: number[] }

function recordingContext() {
  const paints: Paint[] = [];
  const ctx = makeFake2D();
  ctx.globalAlpha = 1;
  ctx.fillRect = (x, y, w, h) => paints.push({ color: String(ctx.fillStyle), alpha: ctx.globalAlpha, box: [x, y, w, h] });
  ctx.fill = () => paints.push({ color: String(ctx.fillStyle), alpha: ctx.globalAlpha });
  ctx.fillText = (label) => paints.push({ color: String(ctx.fillStyle), alpha: ctx.globalAlpha, label });
  // The fake does not implement canvas state; record/save the only state we test.
  const states: number[] = [];
  ctx.save = () => { states.push(ctx.globalAlpha); };
  ctx.restore = () => { ctx.globalAlpha = states.pop() ?? 1; };
  return { paints, ctx };
}

function recordingLayer() {
  const { paints, ctx } = recordingContext();
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(ctx);
  return { paints, canvas, text: new TextLayer(canvas) };
}

function rgb(color: string): number[] { return parseCssColor(color)!.slice(0, 3); }
function luminance(c: readonly number[]): number {
  const linear = c.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(foreground: readonly number[], ground: readonly number[], alpha = 1): number {
  const a = luminance(foreground.map((v, i) => v * alpha + ground[i] * (1 - alpha)));
  const b = luminance(ground);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function theme(id: ThemeId) { applyOverlayPalette(THEMES[id].canvas); applyChartInk(THEMES[id].chart); }

// Alternate modes on the SAME consumers: drawing-time lookups must not cache
// the original plate or categorical ink. Includes every registered ground.
const SWITCHES: ThemeId[] = ['swiss', 'sea', 'paper', 'amber', 'paper-deut', 'contrast', 'midnight'];
const LIGHT_EVENTS = ['#075D88', '#24632D', '#9B235D'];
const DARK_EVENTS = ['#68C9F0', '#91D6A1', '#F392C1'];
const LIGHT_GEX = ['#24632D', '#A32B33', '#006477'];
const DARK_GEX = ['#61D48C', '#F18C91', '#73CEE7'];

afterEach(() => { applyOverlayPalette(null); applyChartInk(null); vi.restoreAllMocks(); });

function frame(text: TextLayer) {
  const glyphs: RGBA[] = [], lines: RGBA[] = [];
  const gm = new GridMap({ colOffset: 0, colScale: 8, rowOffset: 0, rowScale: 8 },
    { cssW: 640, cssH: 480, drawW: 640, drawH: 480 },
    { anchorSeq: 0, anchorT0Ns: 0n, dtNs: 250_000_000 },
    { p0: 100, step: .5, scale: { kind: 'linear', rows: 8, p0: 100, step: .5 } });
  const result = {
    gm, text, resident: { oldest: 0, newest: 7 }, capability: null,
    columnArrays: () => ({ bid: Float32Array.of(1, 2, 3, 9, 0, 0, 0, 0), ask: null }),
    solid: {
      begin() {}, flush() {}, addRect() {},
      addQuad(...args: [...number[], RGBA]) { glyphs.push(args.at(-1) as RGBA); },
      addThickLine(_x0: number, _y0: number, _x1: number, _y1: number, _w: number, color: RGBA) { lines.push(color); },
    },
  } as unknown as OverlayFrame;
  return { frame: result, glyphs, lines };
}

describe('actual chart consumer paints', () => {
  it('uses the current opaque plate and default text in square and rounded TextLayer badges', () => {
    const { text, paints } = recordingLayer();
    for (const id of SWITCHES) {
      theme(id);
      for (const radius of [0, 3]) {
        paints.length = 0;
        text.badge(10, 10, 'default', { radius });
        expect(parseCssColor(paints[0].color)).toEqual([...rgb(THEMES[id].chart.chipBg), 1]);
        expect(rgb(paints[1].color)).toEqual(rgb(THEMES[id].chart.ink));
        expect(contrast(rgb(paints[1].color), rgb(paints[0].color))).toBeGreaterThanOrEqual(4.5);
      }
      paints.length = 0;
      text.text(0, 0, 'axis');
      expect(rgb(paints[0].color)).toEqual(rgb(THEMES[id].chart.axis));
    }
    applyChartInk(null);
    paints.length = 0;
    text.badge(0, 0, 'raw');
    expect(paints.map(p => p.color)).toEqual(['rgba(5, 8, 12, 0.82)', 'rgba(230, 237, 243, 1)']);
  });

  it('paints actual BBO and both profile badge paths with theme plates and readable channel ink', () => {
    const { text, paints } = recordingLayer();
    const { frame: f } = frame(text);
    const bbo = new Bbo(), profile = new Profile(), pending = new Profile({ maxCols: 1 });
    vi.spyOn(ViewWorker.prototype, 'run').mockImplementation(() => new Promise(() => {}));
    bbo.set({ bidPx: 101, bidSz: 2, askPx: 102, askSz: 3, source: 'bbo' });
    for (const id of SWITCHES) {
      theme(id); paints.length = 0;
      bbo.draw(f); profile.draw(f); pending.draw(f);
      const labels = paints.filter(p => p.label !== undefined);
      expect(labels.map(p => p.label)).toEqual(['A 102.0 ×3.00', 'B 101.0 ×2.00', 'POC 101.5', 'Profil hesaplanıyor…']);
      expect(labels.slice(0, 2).map(p => rgb(p.color))).toEqual([rgb(THEMES[id].canvas.ask), rgb(THEMES[id].canvas.bid)]);
      expect(labels.slice(2).map(p => rgb(p.color))).toEqual([
        rgb(THEMES[id].mode === 'light' ? '#865509' : '#F0CD7A'),
        rgb(THEMES[id].mode === 'light' ? '#3D628B' : '#8FB5DC'),
      ]);
      for (let i = 0; i < paints.length; i += 2) {
        expect(parseCssColor(paints[i].color)).toEqual([...rgb(THEMES[id].chart.chipBg), 1]);
        expect(contrast(rgb(paints[i + 1].color), rgb(paints[i].color)), `${id} ${paints[i + 1].label}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    pending.dispose(); profile.dispose();
  });

  it('adapts actual Capitol/defense/clinical glyphs and labels without merging their meanings', () => {
    const { text, paints } = recordingLayer();
    const { frame: f, glyphs } = frame(text);
    const markers = new Markers();
    (['capitol', 'defense_contract', 'clinical'] as const).forEach((kind, i) =>
      markers.add({ ts_ns: BigInt(i + 1) * 250_000_000n, kind, price: 101, text: '' } as Marker));
    for (const id of SWITCHES) {
      theme(id); paints.length = 0; glyphs.length = 0;
      markers.draw(f);
      const expected = THEMES[id].mode === 'light' ? LIGHT_EVENTS : DARK_EVENTS;
      expect(paints.map(p => rgb(p.color))).toEqual(expected.map(rgb));
      // Glyphs draw newest-first; labels are sorted by horizontal anchor.
      expect(glyphs).toEqual([...expected].reverse().map(c => [...rgb(c).map(v => v / 255), .95]));
      expect(new Set(paints.map(p => p.color)).size).toBe(3);
      for (const p of paints) expect(contrast(rgb(p.color), rgb(THEMES[id].chart.bg))).toBeGreaterThanOrEqual(4.5);
      for (const g of glyphs) expect(contrast(g.slice(0, 3).map(v => v * 255), rgb(THEMES[id].chart.bg), g[3])).toBeGreaterThanOrEqual(3);
    }
    applyChartInk(null); paints.length = 0; glyphs.length = 0;
    markers.draw(f);
    expect(paints.map(p => p.color)).toEqual(['#38bdf8', '#4ade80', '#ec4899']);
    expect(glyphs).toEqual([[.93, .28, .60, .95], [.29, .87, .50, .95], [.22, .74, .97, .95]]);
  });

  it('adapts actual GEX lines and badge paint and preserves exact raw channels', () => {
    const { text, paints } = recordingLayer();
    const { frame: f, lines } = frame(text);
    const gex = new GexOverlay();
    gex.set({ type: MsgType.GEX_UPDATE, symbol: 'SPY', spot_price: 101, net_gex: 10,
      call_wall: 102, put_wall: 100.5, gamma_flip: 101 });
    for (const id of SWITCHES) {
      theme(id); paints.length = 0; lines.length = 0;
      gex.draw(f);
      const expected = THEMES[id].mode === 'light' ? LIGHT_GEX : DARK_GEX;
      const labels = paints.filter(p => p.label);
      expect(labels.map(p => rgb(p.color))).toEqual(expected.map(rgb));
      expect(labels.map(p => p.label)).toEqual(['CALL WALL 102.0', 'PUT WALL 100.5', 'GAMMA FLIP 101.0']);
      expect(lines).toEqual(expected.map((c, i) => [...rgb(c).map(v => v / 255), i === 2 ? .75 : .85]));
      for (let i = 0; i < paints.length; i += 2) {
        expect(parseCssColor(paints[i].color)).toEqual([...rgb(THEMES[id].chart.chipBg), 1]);
        expect(contrast(rgb(paints[i + 1].color), rgb(paints[i].color))).toBeGreaterThanOrEqual(4.5);
      }
      for (const g of lines) expect(contrast(g.slice(0, 3).map(v => v * 255), rgb(THEMES[id].chart.bg), g[3])).toBeGreaterThanOrEqual(3);
    }
    applyChartInk(null); paints.length = 0; lines.length = 0;
    gex.draw(f);
    expect(paints.filter(p => p.label).map(p => p.color)).toEqual(['#00ff73', '#ff4040', '#33d6ff']);
    expect(lines).toEqual([[0, 1, .45, .85], [1, .25, .25, .85], [.2, .85, 1, .75]]);
  });

  it('paints the manager volume canvas with the exact opaque chart ground and preserves bar geometry/data', () => {
    const layers: ReturnType<typeof recordingContext>[] = [];
    const byCanvas = new WeakMap<HTMLCanvasElement, ReturnType<typeof recordingContext>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      let layer = byCanvas.get(this);
      if (!layer) { layer = recordingContext(); layers.push(layer); byCanvas.set(this, layer); }
      return layer.ctx;
    } as unknown as HTMLCanvasElement['getContext']);
    const manager = new OverlayManager(makeFakeGL(), document.createElement('canvas'));
    manager.setVisibility({ axes: false, bbo: false, profile: false, price: false, markers: false, vwap: false, bubbles: false, gex: false });
    manager.onBar({ col_seq: 1, c: 101, vol_buy: 9, vol_sell: 1 } as BarColumn);
    manager.onBar({ col_seq: 2, c: 101, vol_buy: 1, vol_sell: 8 } as BarColumn);
    const ctx: OverlayDrawContext = { view: { colOffset: 0, colScale: 8, rowOffset: 0, rowScale: 8 },
      dims: { cssW: 640, cssH: 480, drawW: 640, drawH: 480 }, dpr: 1,
      resident: { oldest: 0, newest: 7 }, capability: null, time: null, price: { p0: 100, step: .5 },
      columnArrays: () => null, newestArrays: null };
    const volume = layers[1].paints;
    let geometry: number[][] | undefined;
    for (const id of SWITCHES) {
      theme(id); volume.length = 0;
      manager.draw(ctx);
      expect(parseCssColor(volume[0].color)).toEqual([...rgb(THEMES[id].chart.bg), 1]);
      expect(volume[0].alpha).toBe(1);
      const bars = volume.slice(2);
      expect(bars).toHaveLength(2);
      expect(bars.map(p => rgb(p.color))).toEqual([rgb(THEMES[id].canvas.bid), rgb(THEMES[id].canvas.ask)]);
      for (const p of bars) {
        expect(p.alpha).toBe(VOLBAR_ALPHA);
        expect(contrast(rgb(p.color), rgb(volume[0].color), p.alpha)).toBeGreaterThanOrEqual(3);
      }
      const current = bars.map(p => p.box!);
      geometry ??= current;
      expect(current).toEqual(geometry);
      expect(manager.debug().volumeBars).toBe(2);
    }
    applyChartInk(null); volume.length = 0; manager.draw(ctx);
    expect(volume[0].color).toBe('rgb(5, 8, 12)');
    manager.dispose();
  });
});
