import { describe, expect, it } from 'vitest';
import { GexOverlay } from './gexLevels';
import type { OverlayFrame } from './frame';
import { MsgType, type GexLevelUpdate } from '../../proto/types';

function makeFrame() {
  const lineCalls: Array<{ y: number; color: readonly [number, number, number, number] }> = [];
  const textCalls: Array<{ x: number; y: number; text: string }> = [];
  const gm = {
    price: { p0: 100, step: 0.5 },
    dims: { cssW: 1000, cssH: 800 },
    priceToRow: (p: number) => (p - 100) / 0.5,
    clipY: (_row: number) => 0.2,
    cssY: (row: number) => 800 - row,
  };
  const frame = {
    gm,
    solid: {
      begin() {},
      addThickLine(_x0: number, y0: number, _x1: number, _y1: number, _width: number, color: readonly [number, number, number, number]) {
        lineCalls.push({ y: y0, color });
      },
      flush() {},
    },
    text: {
      text(x: number, y: number, text: string) {
        textCalls.push({ x, y, text });
      },
      badge(x: number, y: number, text: string) {
        textCalls.push({ x, y, text });
      },
    },
  } as unknown as OverlayFrame;

  return { frame, lineCalls, textCalls };
}

describe('GexOverlay (FLOW <GO>)', () => {
  it('initializes empty and draws nothing when unset', () => {
    const overlay = new GexOverlay();
    expect(overlay.get()).toBeNull();
    const { frame, lineCalls, textCalls } = makeFrame();
    overlay.draw(frame);
    expect(lineCalls.length).toBe(0);
    expect(textCalls.length).toBe(0);
  });

  it('draws Call Wall, Put Wall, and Gamma Flip when set', () => {
    const overlay = new GexOverlay();
    const sample: GexLevelUpdate = {
      type: MsgType.GEX_UPDATE,
      symbol: 'SPY',
      spot_price: 500,
      net_gex: 1250000000,
      call_wall: 510,
      put_wall: 490,
      gamma_flip: 498,
    };
    overlay.set(sample);
    expect(overlay.get()).toEqual(sample);

    const { frame, lineCalls, textCalls } = makeFrame();
    overlay.draw(frame);

    expect(lineCalls.length).toBe(3);
    expect(textCalls.length).toBe(3);
    expect(textCalls.some((t) => t.text.includes('CALL WALL'))).toBe(true);
    expect(textCalls.some((t) => t.text.includes('PUT WALL'))).toBe(true);
    expect(textCalls.some((t) => t.text.includes('GAMMA FLIP'))).toBe(true);
  });

  it('honors setEnabled(false)', () => {
    const overlay = new GexOverlay();
    overlay.set({
      type: MsgType.GEX_UPDATE,
      symbol: 'AAPL',
      spot_price: 220,
      net_gex: 5000000,
      call_wall: 225,
      put_wall: 215,
      gamma_flip: 218,
    });
    overlay.setEnabled(false);
    expect(overlay.isEnabled()).toBe(false);

    const { frame, lineCalls } = makeFrame();
    overlay.draw(frame);
    expect(lineCalls.length).toBe(0);
  });

  it('clears state on reset()', () => {
    const overlay = new GexOverlay();
    overlay.set({
      type: MsgType.GEX_UPDATE,
      symbol: 'NVDA',
      spot_price: 130,
      net_gex: 8500000,
      call_wall: 135,
      put_wall: 120,
      gamma_flip: 128,
    });
    overlay.reset();
    expect(overlay.get()).toBeNull();
  });
});
