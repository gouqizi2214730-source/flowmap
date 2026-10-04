import { describe, expect, it } from 'vitest';

import { follow, KILL_BOTH, KILL_NONE, KILL_PRICE, KILL_TIME, toView } from './camera';
import {
  approach,
  colsBehind,
  isColVisible,
  PAN_KILL_MIN_PX,
  PRICE_DEADBAND_FRACTION,
  PRICE_GLIDE_TAU_MS,
  panFollowKill,
  priceFollowTarget,
  stepLiveEdgeLag,
  TIME_GLIDE_MAX_LAG,
  trackedRow,
} from './follow';
import type { HeatmapView } from './heatmap';

const VIEW: HeatmapView = { colOffset: 900, colScale: 200, rowOffset: 196, rowScale: 120 };

describe('panFollowKill — which axes a drag claims', () => {
  it('releases nothing below the threshold on both axes (hand tremor)', () => {
    expect(panFollowKill(3, 4)).toEqual(KILL_NONE);
    expect(panFollowKill(PAN_KILL_MIN_PX - 0.01, PAN_KILL_MIN_PX - 0.01)).toEqual(KILL_NONE);
  });

  it('a deliberately horizontal drag keeps price tracking', () => {
    expect(panFollowKill(150, 2)).toEqual(KILL_TIME);
  });

  it('a deliberately vertical drag keeps time follow', () => {
    expect(panFollowKill(1, 80)).toEqual(KILL_PRICE);
  });

  it('a diagonal drag claims both', () => {
    expect(panFollowKill(40, 40)).toEqual(KILL_BOTH);
  });

  it('is peak-based, so a there-and-back drag cannot dodge the kill', () => {
    // The CALLER feeds peak |displacement|, not a signed net: a 100px-right,
    // 96px-left drag has peak 100 even though it nets to +4.
    expect(panFollowKill(100, 0)).toEqual(KILL_TIME);
    // Sign is irrelevant — magnitude is what a takeover means.
    expect(panFollowKill(-100, 0)).toEqual(KILL_TIME);
  });

  it('fires exactly AT the threshold', () => {
    expect(panFollowKill(PAN_KILL_MIN_PX, 0)).toEqual(KILL_TIME);
  });
});

describe('trackedRow — "where is the price" from one column', () => {
  it('uses the inside-quote midpoint for a two-sided uncrossed book', () => {
    // bid tops at 100, ask starts at 104 → mid of the half-open gap.
    expect(trackedRow(100, 104, 40, 160)).toBe(102.5);
  });

  it('D2: accepts the same-row two-sided case (the real BTC book) at the cell centre', () => {
    // Live BTC columns quantize best bid and best ask onto the SAME row
    // (survey S1/D2: bidTop === askBot === 2311). The inside quote is then
    // that cell's centre — NOT the whole-book extent midpoint.
    expect(trackedRow(2311, 2311, 1161, 3411)).toBe(2311.5);
    // Counterexample pinned: the old strict `>` fell through to
    // (lo + hi + 1)/2 = 2286.5, which a far-wing wall could drag by dozens
    // of rows (the tracked-camera lurch in the survey).
    expect(trackedRow(2311, 2311, 1161, 3411)).not.toBe(2286.5);
  });

  it('keeps the inside midpoint for a genuine multi-row spread', () => {
    // One row of clearance between the sides must not change the convention.
    expect(trackedRow(100, 101, 40, 160)).toBe(101);
  });

  it('falls back to the extent midpoint for a one-sided (SYNTH) book', () => {
    expect(trackedRow(100, -1, 40, 160)).toBe(100.5);
    expect(trackedRow(-1, 104, 40, 160)).toBe(100.5);
  });

  it('falls back to the extent midpoint on a crossed snapshot', () => {
    // askBot <= bidTop: mid-update crossed book — the extent is still sane.
    expect(trackedRow(120, 110, 40, 160)).toBe(100.5);
  });

  it('returns null for an empty column so the caller keeps the last row', () => {
    expect(trackedRow(-1, -1, -1, -1)).toBeNull();
  });
});

describe('priceFollowTarget — the deadband', () => {
  const CENTER = 256;
  const SPAN = 120;
  const halfBand = (SPAN * PRICE_DEADBAND_FRACTION) / 2;

  it('does not move anywhere inside the visible frame, including its edges', () => {
    expect(priceFollowTarget(CENTER, SPAN, CENTER)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, CENTER + halfBand - 0.01)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, CENTER - halfBand + 0.01)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, CENTER + halfBand)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, CENTER - halfBand)).toBeNull();
  });

  it('moves only enough to bring an escaped price 10% inside the frame', () => {
    expect(priceFollowTarget(CENTER, SPAN, CENTER + halfBand + 5)).toBe(CENTER + 17);
    expect(priceFollowTarget(CENTER, SPAN, 10)).toBe(58);
  });

  it('gives no target without a tracked row or a usable span', () => {
    expect(priceFollowTarget(CENTER, SPAN, null)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, Number.NaN)).toBeNull();
    expect(priceFollowTarget(CENTER, 0, 999)).toBeNull();
  });

  it('finishes an escaped-price recovery inside the padding without retriggering', () => {
    const price = CENTER + 55;
    expect(priceFollowTarget(CENTER, SPAN, price)).toBeNull();
    const target = priceFollowTarget(CENTER, SPAN, price, true);
    expect(target).toBe(CENTER + 7);
    expect(priceFollowTarget(target!, SPAN, price, true)).toBeNull();
  });
});

describe('approach — the glide', () => {
  it('moves a fixed FRACTION of the remaining distance per tau', () => {
    const out = approach(0, 100, PRICE_GLIDE_TAU_MS, PRICE_GLIDE_TAU_MS);
    expect(out).toBeCloseTo(100 * (1 - Math.exp(-1)), 9); // ≈63.2
  });

  it('is frame-rate independent: two half-steps == one whole step', () => {
    const dt = PRICE_GLIDE_TAU_MS;
    const oneStep = approach(0, 100, dt, PRICE_GLIDE_TAU_MS);
    const halfA = approach(0, 100, dt / 2, PRICE_GLIDE_TAU_MS);
    const halfB = approach(halfA, 100, dt / 2, PRICE_GLIDE_TAU_MS);
    expect(halfB).toBeCloseTo(oneStep, 9);
  });

  it('HOLDS on a zero-length frame instead of teleporting', () => {
    // A single combined guard would return `target` here and jump the wall.
    expect(approach(10, 500, 0, PRICE_GLIDE_TAU_MS)).toBe(10);
    expect(approach(10, 500, -5, PRICE_GLIDE_TAU_MS)).toBe(10);
  });

  it('jumps when easing is disabled (tau <= 0)', () => {
    expect(approach(10, 500, 16, 0)).toBe(500);
  });

  it('never overshoots', () => {
    expect(approach(0, 100, 10_000, PRICE_GLIDE_TAU_MS)).toBeLessThanOrEqual(100);
  });
});

describe('isColVisible / colsBehind', () => {
  it('treats the window as half-open [colOffset, colOffset+colScale)', () => {
    expect(isColVisible(VIEW, 900)).toBe(true);
    expect(isColVisible(VIEW, 1099.9)).toBe(true);
    expect(isColVisible(VIEW, 1100)).toBe(false);
    expect(isColVisible(VIEW, 899.9)).toBe(false);
  });

  it('reports 0 columns behind when pinned to (or past) the live edge', () => {
    expect(colsBehind(VIEW, 1099)).toBe(0);
    expect(colsBehind(VIEW, 500)).toBe(0);
  });

  it('reports the gap when scrolled back', () => {
    // right edge = 1100; newest 1600 → 1601 - 1100 = 501 columns behind.
    expect(colsBehind(VIEW, 1600)).toBe(501);
  });
});

describe('go-live re-arm (camera.follow) — the contract the Go Live chip relies on', () => {
  // The renderer's goLive action is exactly `follow(state, range)`: re-pin the
  // right edge to newest+1 and turn TIME follow on. The PRICE axis — the user's
  // zoom (rowSpan) and follow mode — must come through untouched, or re-arming
  // live would destroy the scale the user set (the bug this pins).
  it('leaves price zoom and mode alone while making the view live again', () => {
    const scrolledBack: Parameters<typeof follow>[0] = {
      colCenter: 400,
      colSpan: 200,
      rowCenter: 80,
      rowSpan: 30, // the user's chosen price zoom
      followTime: false,
      followPrice: 'track',
    };
    const out = follow(scrolledBack, { oldest: 0, newest: 1599, count: 1600 });
    expect(out.followTime).toBe(true);
    const v = toView(out);
    expect(v.colOffset + v.colScale).toBe(1600); // right edge = newest + 1
    expect(out.rowSpan).toBe(30); // user's price zoom preserved
    expect(out.followPrice).toBe('track'); // price follow mode preserved
  });
});

describe('stepLiveEdgeLag — the constant-velocity live-edge scroll', () => {
  const INTERVAL = 250; // one column per 250 ms (crypto/sim cadence)

  it('advances at exactly one column per interval, in equal frame steps', () => {
    // Sustained feed, 60 fps: every frame consumes dt/interval of a column and
    // every arrival adds one — the lag sawtooths with a CONSTANT step size,
    // which is the whole smoothness contract (no slide-then-freeze).
    let lag = 1;
    const steps: number[] = [];
    for (let i = 0; i < 120; i++) {
      const arrivals = i % 15 === 14 ? 1 : 0; // one column per 250 ms at 60 fps
      const before = lag;
      lag = stepLiveEdgeLag(lag, arrivals, 16.7, INTERVAL);
      steps.push(+(before - lag).toFixed(4));
    }
    const moving = steps.filter((s) => s > 0);
    const maxDev = Math.max(...moving.map((s) => Math.abs(s - 16.7 / INTERVAL)));
    expect(maxDev).toBeLessThan(0.015); // every advancing frame moves the same
  });

  it('never stalls between arrivals on a slow cadence (1 s equity grid)', () => {
    // With a 1 s interval the lag is consumed over the full second — the edge
    // is still moving just before the next column lands.
    let lag = 1;
    for (let i = 0; i < 58; i++) lag = stepLiveEdgeLag(lag, 0, 16.7, 1000);
    expect(lag).toBeGreaterThan(0.02); // ~1 - 970/1000 still pending
    lag = stepLiveEdgeLag(lag, 1, 16.7, 1000); // the column lands, lag refills
    expect(lag).toBeLessThan(1.05); // steady reserve (sub-pixel overshoot ok)
  });

  it('is display-continuous at the arrival instant: lag grows by the arrivals', () => {
    // Below the cap the lag grows by EXACTLY the arrival count (the display
    // edge must not move at the instant a column lands).
    const before = stepLiveEdgeLag(0.4, 0, 16.7, INTERVAL);
    const after = stepLiveEdgeLag(before, 0.5, 0, INTERVAL);
    expect(after - before).toBeCloseTo(0.5, 5);
  });

  it('clamps to [0, maxLag]: a burst never trails more than one column', () => {
    expect(stepLiveEdgeLag(0, 500, 16.7, INTERVAL)).toBe(TIME_GLIDE_MAX_LAG);
    expect(stepLiveEdgeLag(0.2, 0, 10_000, INTERVAL)).toBe(0); // idle gap drains
    expect(stepLiveEdgeLag(-3, 0, 16.7, INTERVAL)).toBe(0);
  });

  it('survives a poisoned interval via the 250 ms fallback', () => {
    expect(stepLiveEdgeLag(0.5, 0, 250, Number.NaN)).toBe(0);
    expect(stepLiveEdgeLag(0.5, 0, 125, 0)).toBeCloseTo(0, 5);
  });

  it('is frame-rate independent over the same elapsed time', () => {
    // Same 500 ms, same two arrivals, split across 30 fps and 120 fps frames.
    // Frame quantization of the arrival phase bounds the divergence at
    // ~dt/interval per boundary (0.13 at 30 fps / 250 ms) — well under a pixel.
    let at30 = 0;
    for (let i = 0; i < 15; i++) at30 = stepLiveEdgeLag(at30, i === 0 || i === 8 ? 1 : 0, 33.4, INTERVAL);
    let at120 = 0;
    for (let i = 0; i < 60; i++) at120 = stepLiveEdgeLag(at120, i === 0 || i === 30 ? 1 : 0, 8.35, INTERVAL);
    expect(Math.abs(at30 - at120)).toBeLessThan(0.15);
  });
});
