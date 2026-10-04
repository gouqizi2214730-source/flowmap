/**
 * Auto-follow policy — the pure math behind per-axis follow (§8.3, camera.ts).
 *
 * `camera.ts` owns the transform; this module owns the DECISIONS that drive it:
 * which axes a drag releases, where "the price" currently is, whether it has
 * drifted far enough to be worth recentring, and how fast the view eases there.
 * All of it is pure and DOM-free (the `input/keys.ts` precedent), so the policy
 * is unit-testable without a GL context or a live feed — see follow.test.ts.
 *
 * The two rules worth stating up front, because both encode a bug that a naive
 * implementation ships:
 *
 *  - **Drag kill uses PEAK displacement from the pointerdown origin, not a
 *    signed running sum.** A drag 100 px right then 96 px back nets to +4 px;
 *    with a signed sum it would keep time-follow armed and the view would snap
 *    to the live edge the instant the user released — after they had very
 *    obviously taken manual control. Peak |displacement| per axis cannot be
 *    gamed that way, and a flat per-axis threshold (rather than an axis-
 *    dominance ratio) means a deliberately horizontal drag provably keeps price
 *    tracking while a 3 px twitch releases nothing.
 *
 *  - **Tracking starts only outside the viewport.** An escaped price returns
 *    to a padded edge, preserving the visible history and the user's zoom.
 *    The padding supplies hysteresis; ordinary in-frame movement is left alone.
 */

import type { HeatmapView } from './heatmap';
import { KILL_BOTH, KILL_NONE, KILL_PRICE, KILL_TIME, type FollowKill } from './camera';

/**
 * Full visible viewport: no automatic camera move while price is on screen.
 */
export const PRICE_DEADBAND_FRACTION = 1;
/** Bring an escaped price 10% inside the edge without discarding the history. */
export const PRICE_RETURN_PADDING = 0.1;

/**
 * Exponential time constant (ms) for the recentre glide. ~90 ms reads as a
 * deliberate camera move rather than a teleport, and settles inside 3 frames at
 * 60 fps. Same family as the normalizer's EMA glide (gl/normalize.ts), which
 * exists for exactly this "don't snap the display on a regime change" reason.
 */
export const PRICE_GLIDE_TAU_MS = 90;

/** Settle threshold (rows): closer than this to the target and the glide stops. */
export const PRICE_SNAP_ROWS = 0.25;

/**
 * Peak drag displacement (CSS px) on one axis before that axis's follow is
 * released. Pointermove deltas are 1–3 px, so anything smaller releases follow
 * on hand tremor; anything much larger makes a deliberate small nudge feel inert.
 */
export const PAN_KILL_MIN_PX = 6;

/**
 * Which follows a positional drag releases, from the PEAK absolute displacement
 * on each axis since pointerdown. A drag that never travels `PAN_KILL_MIN_PX`
 * vertically keeps price-follow armed, which is the whole point: scrolling back
 * through time must not cost you price tracking.
 */
export function panFollowKill(peakDx: number, peakDy: number): FollowKill {
  const killTime = Math.abs(peakDx) >= PAN_KILL_MIN_PX;
  const killPrice = Math.abs(peakDy) >= PAN_KILL_MIN_PX;
  if (killTime && killPrice) return KILL_BOTH;
  if (killTime) return KILL_TIME;
  if (killPrice) return KILL_PRICE;
  return KILL_NONE;
}

/**
 * The row the price window should stay centred on, from ONE column's already-
 * scanned book geometry:
 *   - `bidTop` — highest row with bid > 0 (−1 when the bid side is empty),
 *   - `askBot` — lowest row with ask > 0 (−1 when the ask side is empty),
 *   - `[lo, hi]` — the column's overall non-zero row extent (−1/−1 when empty).
 *
 * Two-sided (`askBot >= bidTop`) → the inside-quote midpoint, which is the
 * closest thing to "the price" that needs no BBO channel, no capability check
 * and no overlay state. The `>=` matters: real L2 columns routinely quantize
 * the best bid and best ask onto the SAME row (`bidTop === askBot` — the BTC
 * case in survey S1/D2), for which the formula yields exactly `bidTop + 0.5`,
 * the density-cell centre. With the old strict `>` that whole class fell
 * through to the extent midpoint, so the tracked row was pulled toward the
 * far wings (and moved whenever a wall appeared) instead of the inside quote.
 * Otherwise (one-sided SYNTH_PROFILE books, a crossed snapshot mid-update) →
 * the extent midpoint. Empty column → null, and the caller keeps the previous
 * tracked row rather than jumping to row 0.
 */
export function trackedRow(
  bidTop: number,
  askBot: number,
  lo: number,
  hi: number,
): number | null {
  if (bidTop >= 0 && askBot >= 0 && askBot >= bidTop) return (bidTop + askBot + 1) / 2;
  if (lo >= 0 && hi >= lo) return (lo + hi + 1) / 2;
  return null;
}

/**
 * The new `rowCenter` to ease toward, or null when the tracked row is still
 * inside the deadband and the view should not move at all. Returning null (not
 * "the current centre") is what lets the caller skip the redraw entirely.
 */
export function priceFollowTarget(
  rowCenter: number,
  rowSpan: number,
  tracked: number | null,
  continuing = false,
): number | null {
  if (tracked === null || !Number.isFinite(tracked) || !(rowSpan > 0)) return null;
  const half = (rowSpan * PRICE_DEADBAND_FRACTION) / 2;
  const innerHalf = rowSpan * (0.5 - PRICE_RETURN_PADDING);
  const delta = tracked - rowCenter;
  if (Math.abs(delta) <= (continuing ? innerHalf : half)) return null;
  return tracked - Math.sign(delta) * innerHalf;
}

/**
 * Frame-rate-independent exponential ease toward `target`. The two guards are
 * deliberately SPLIT: a non-positive `tauMs` means "no easing configured", so
 * jump; a non-positive `dtMs` means "no time has passed", so hold. Collapsing
 * them into one guard that returns `target` teleports the view on any frame the
 * clock reports a zero delta.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return target;
  if (!(dtMs > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

/** Whether an absolute column falls inside the view's horizontal window. */
export function isColVisible(view: HeatmapView, col: number): boolean {
  return col >= view.colOffset && col < view.colOffset + view.colScale;
}

/**
 * How many columns the view's right edge sits behind the newest column — 0 when
 * pinned to (or past) the live edge. Drives the transport's `−HH:MM:SS`
 * behind-readout once multiplied by the epoch's `dt_ns`.
 */
export function colsBehind(view: HeatmapView, newestSeq: number): number {
  const right = view.colOffset + view.colScale;
  const behind = newestSeq + 1 - right;
  return behind > 0 ? behind : 0;
}

/**
 * The constant-velocity reserve: in steady flow the drawn edge trails the
 * logical follow frame by up to two intervals in steady flow. The spare
 * interval absorbs ordinary delivery jitter without letting the scroll stop.
 */
export const TIME_GLIDE_STEADY_LAG = 2;

/**
 * Runaway guard only (columns). Real feeds arrive in BURSTS — a Binance L2
 * queue flushes 2-4 finalized columns at once, and a backpressured dev proxy
 * can deliver 30+ after a stall — and the lag must absorb the WHOLE burst,
 * because every clamped column becomes an instant forward jump of the display
 * (the "perde perde" wave; measured 2026-09-20 on live BTCUSDT: multi-column
 * leaps within single frames). Between bursts the excess drains smoothly
 * (TIME_GLIDE_CATCHUP_MS) at ~lag/1.2 s, so on a steady feed the trail sits at
 * the steady reserve and the cap is never reached; after a big burst the view
 * sweeps back to the live edge in about a second instead of teleporting.
 */
export const TIME_GLIDE_MAX_LAG = 24;

/** Time constant for draining burst backlog above the steady reserve (ms). */
export const TIME_GLIDE_CATCHUP_MS = 1200;

/** The glide is converged below this residual (columns); the view snaps exact. */
export const TIME_GLIDE_SETTLE_EPS = 0.002;

/**
 * One frame of the live-edge scroll — CONSTANT-VELOCITY catch-up.
 *
 * The logical follow frame still pins the right edge a whole column past
 * `newestSeq` the moment a column lands; the drawn view trails that edge by
 * `lag` columns and consumes the trail at EXACTLY the column arrival rate:
 *
 *   lag -= dt / interval              (advance `dt/interval` of a column)
 *   lag -= excess × drain(dt)         (burst backlog above the reserve drains
 *                                      smoothly — never as a display jump)
 *   lag += arrivals                   (a landed column must not teleport the
 *                                      display forward; it lengthens the trail)
 *   clamp to [0, TIME_GLIDE_MAX_LAG]
 *
 * so on a steady feed the map moves at a perfectly even `1 column per
 * interval` with no slide-then-freeze tail, and on a bursty real feed the
 * burst is absorbed into the trail and drained — the two failure modes that
 * read as stepped "curtain" motion. Pure; unit-tested (follow.test.ts).
 *
 * `intervalMs` is the epoch's column duration. Packet jitter must not alter the
 * time-axis velocity. A delay longer than the reserve can still exhaust the
 * available data; the camera then waits instead of inventing new columns.
 */
export function stepLiveEdgeLag(
  lag: number,
  arrivals: number,
  dtMs: number,
  intervalMs: number,
): number {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 250;
  let next = lag - dtMs / interval;
  const excess = next - TIME_GLIDE_STEADY_LAG;
  if (excess > 0) {
    next -= excess * (1 - Math.exp(-dtMs / TIME_GLIDE_CATCHUP_MS));
  }
  next += Math.max(0, arrivals);
  // Per-frame reduction bound: while the measured interval re-converges after
  // a cadence change the computed consumption briefly outruns the data rate;
  // capping the reduction at 1 column keeps every single-frame screen move
  // within ~one column no matter what the EMA is doing.
  if (lag - next > 1) next = lag - 1;
  if (next < 0) next = 0;
  if (next > TIME_GLIDE_MAX_LAG) next = TIME_GLIDE_MAX_LAG;
  return next;
}
