/**
 * FlowMap book/tape buffer (M2 T11) — the module-scoped high-frequency store
 * for the DOM ladder + time & sales panels.
 *
 * The panels update at high frequency (book ~4-20/s, trades ~5-120/s). Pushing
 * every DepthColumn / BBO / Trade through React state would storm re-renders, so
 * — exactly like the renderer's column stream (see state/store.ts) — this buffer
 * lives OUTSIDE React: it subscribes to the store's `onStream` fan-out ONCE, keeps
 * the current book (newest DepthColumn's density arrays + geometry), the current
 * BBO, and a bounded ring of the most recent trades, and exposes:
 *
 *   - {@link getSnapshot}: a cheap, lazily-rebuilt immutable snapshot (rebuilt only
 *     when the buffer actually changed — never per read);
 *   - {@link subscribe}: a listener the panels register; notifications are THROTTLED
 *     to ~60 Hz (coalescing a burst of columns/trades into one panel update) and
 *     are only scheduled while at least one panel is subscribed. No timer spins
 *     when nothing is listening or nothing is flowing.
 *
 * Nothing here touches zustand/React state, so the GL loop and the low-frequency
 * session store are untouched. Epoch geometry (row→price) and the capability
 * descriptor stay in the zustand store; the panels read those with normal
 * selectors and combine them with this buffer's book/bbo/trades.
 */

import type { StreamMsg } from '../net/connection';
import { MsgType, type BBO, type BookUpdate, type DepthColumn, type Trade } from '../proto/types';
import { sessionResetKey, useFlowMapStore, type FlowMapState } from './store';
import { LIVE_UPDATE_MS } from './cadence';

/** Max trades retained for the tape (spec §9: "last ~200"); ring is a touch larger. */
export const TRADE_RING = 256;
/** Panel notify cadence — coalesce the high-freq stream within one frame. */
export const THROTTLE_MS = LIVE_UPDATE_MS;

/** Current book: the newest DepthColumn's density arrays + identity. */
export interface BookBuffer {
  /** Current resting size, instead of the last settled heatmap average. */
  instant?: boolean;
  epoch: number;
  /** MODE_L2 | MODE_L1_BAND | MODE_SYNTH_PROFILE (proto/types). */
  mode: number;
  colSeq: number;
  t0Ns: bigint;
  /** Per-row resting-size density (index r ↔ price p0 + r·step of the epoch). */
  bid: Float32Array;
  /** null iff mode === MODE_SYNTH_PROFILE (single-channel volume-at-price). */
  ask: Float32Array | null;
}

export interface BboBuffer {
  /** Local monotonic arrival clock; never inferred from an exchange timestamp. */
  receivedAtMs?: number;
  tsNs: bigint;
  bidPx: number;
  bidSz: number;
  askPx: number;
  askSz: number;
}

export interface TapeTrade {
  /** Local arrival clock for freshness; optional for old recordings/test models. */
  receivedAtMs?: number;
  tsNs: bigint;
  price: number;
  size: number;
  /** SIDE_BUY | SIDE_SELL | SIDE_UNKNOWN (proto/types). */
  side: number;
  /** Wire attribution for the aggressor side, when provided by the feed. */
  sideSrc?: number;
  venue: string;
}

/** Immutable per-flush view the panels render off. `trades` is NEWEST-FIRST. */
export interface BookSnapshot {
  /** Local context of this buffer, so old rows cannot acquire a new symbol label. */
  sessionKey?: string;
  /** Changes on a buffer reset even when the subscription metadata stays the same. */
  sessionVersion?: number;
  version: number;
  book: BookBuffer | null;
  bbo: BboBuffer | null;
  trades: readonly TapeTrade[];
}

const EMPTY_TRADES: readonly TapeTrade[] = Object.freeze([]);

// --- module-scoped buffer (never in React state) --------------------------------

let book: BookBuffer | null = null;
let bbo: BboBuffer | null = null;
/**
 * Fixed-slot trade ring, NEWEST-LAST with a moving head index: a push is ONE
 * slot write (no Array.shift memmove, no growth, no per-trade garbage) and the
 * eviction of the oldest trade falls out of the modulo. The panel-facing
 * snapshot materializes it newest-FIRST by iterating the ring BACKWARD — the
 * old `trades.slice().reverse()` per flush allocated TWO arrays at ~10 Hz
 * (the slice, then the reversed copy); this allocates exactly the one
 * immutable array the snapshot needs.
 */
const tradeRing: (TapeTrade | undefined)[] = new Array(TRADE_RING);
let tradeHead = -1; // slot index of the newest trade
let tradeCount = 0; // valid slots (≤ TRADE_RING)
let version = 0;
let sessionVersion = 0;
let bufferSessionKey: string | undefined;
let cachedTrades: readonly TapeTrade[] | null = EMPTY_TRADES;

/** Includes mode and handshake identity: replay prints are never live quotes. */
export function bookSessionKey(state: FlowMapState = useFlowMapStore.getState()): string {
  return `${sessionResetKey(state.subscription) ?? ''}:${state.subscription?.mode ?? ''}:${state.sessionId ?? ''}:${state.sessionRevision}`;
}

let cachedSnapshot: BookSnapshot | null = null;

const listeners = new Set<(s: BookSnapshot) => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Unsubscribe handle for the single store.onStream subscription (lazy). */
let streamUnsub: (() => void) | null = null;

/**
 * Coerce a canonical ns field to bigint (cold-JSON small ints decode as number).
 * NaN/±Inf quarantined to 0n at the boundary: `BigInt(NaN)` THROWS, so one
 * corrupt field would otherwise tear down the whole fan-out loop mid-frame.
 */
function toBigNs(x: bigint | number): bigint {
  if (typeof x === 'bigint') return x;
  if (!Number.isFinite(x)) return 0n;
  return BigInt(Math.round(x));
}

/**
 * NaN quarantine for depth densities. A non-finite entry is corrupt wire data
 * (a bad server-side float) and would poison every downstream max/sum — the
 * ladder's per-level size, the imbalance ratio. Zero it: "no resting size" is
 * the honest reading of a corrupt level, and the REST of the book survives.
 * This is also where the protocol's quantity-to-zero rule lands on the client:
 * a zeroed density IS a removed level — there is no separate level map to
 * forget, the arrays are the state.
 */
function quarantineF32(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i += 1) {
    if (!Number.isFinite(a[i])) a[i] = 0;
  }
  return a;
}

/** Mark the buffer dirty and schedule one throttled listener notification. */
function bump(): void {
  version += 1;
  cachedSnapshot = null;
  if (listeners.size === 0 || flushTimer !== null) return;
  flushTimer = setTimeout(flush, THROTTLE_MS);
}

/** Push one trade into the fixed ring — one slot write, oldest evicted by modulo. */
function pushTrade(t: TapeTrade): void {
  tradeHead = (tradeHead + 1) % TRADE_RING;
  tradeRing[tradeHead] = t;
  if (tradeCount < TRADE_RING) tradeCount += 1;
  cachedTrades = null;
}

/**
 * Materialize the ring NEWEST-FIRST into a fresh immutable array: walk back
 * from the head slot. O(ring) with exactly one allocation — the old
 * `slice().reverse()` per flush allocated the slice AND the reversed copy.
 */
function tradesNewestFirst(): readonly TapeTrade[] {
  if (cachedTrades !== null) return cachedTrades;
  if (tradeCount === 0) return EMPTY_TRADES;
  const out: TapeTrade[] = new Array(tradeCount);
  let idx = tradeHead;
  for (let i = 0; i < tradeCount; i += 1) {
    out[i] = tradeRing[idx] as TapeTrade;
    idx -= 1;
    if (idx < 0) idx = TRADE_RING - 1;
  }
  cachedTrades = Object.freeze(out);
  return cachedTrades;
}

function flush(): void {
  flushTimer = null;
  const snap = getSnapshot();
  for (const cb of listeners) cb(snap);
}

/** The single handler wired to the raw stream (and the test-injection seam). */
function handle(msg: StreamMsg): void {
  // Keep the old context until a reset; an in-flight frame cannot relabel it.
  bufferSessionKey ??= bookSessionKey();
  switch (msg.type) {
    case MsgType.BOOK_UPDATE:
    case MsgType.DEPTH_COL: {
      const c = msg as DepthColumn | BookUpdate;
      const instant = msg.type === MsgType.BOOK_UPDATE;
      // The live-edge column is the in-progress PARTIAL (final=false): it starts
      // EMPTY and fills over its interval, so it is NOT the current book. The
      // settled book is the newest FINALIZED column (server/core/session.py emits
      // both). Ignore partials for the ladder — the heatmap/crosshair use them, the
      // DOM ladder wants the last settled snapshot.
      if (!instant && !c.final) return;
      // Newest SESSION position wins, epoch-major: a late column from an OLD
      // epoch (a straggler frame arriving after a mid-stream re-anchor or a
      // replay seek — the server bumps epoch and resnapshots) must never clobber
      // the newer grid's book, however high its col_seq is. Within one epoch,
      // equal col_seq overwrites idempotently (re-delivery), lower is stale.
      if (book !== null) {
        if (c.epoch < book.epoch) return;
        if (c.epoch === book.epoch) {
          if (!instant && book.instant) return;
          if (instant && book.instant && toBigNs(c.t0_ns) < book.t0Ns) return;
          if (!instant && c.col_seq < book.colSeq) return;
        }
      }
      book = {
        instant,
        epoch: c.epoch,
        mode: c.mode,
        colSeq: c.col_seq,
        t0Ns: toBigNs(c.t0_ns),
        bid: quarantineF32(c.bid),
        ask: c.ask === null ? null : quarantineF32(c.ask),
      };
      bump();
      return;
    }
    case MsgType.BBO: {
      const b = msg as BBO;
      // Quarantine: a BBO carrying a non-finite price/size is corrupt — keep the
      // LAST GOOD quote instead of painting NaN into the panel.
      if (
        !Number.isFinite(b.bid_px) ||
        !Number.isFinite(b.bid_sz) ||
        !Number.isFinite(b.ask_px) ||
        !Number.isFinite(b.ask_sz)
        || b.bid_px <= 0 || b.ask_px < b.bid_px || b.bid_sz < 0 || b.ask_sz < 0
      ) {
        return;
      }
      const tsNs = toBigNs(b.ts_ns);
      if (bbo && tsNs < bbo.tsNs) return;
      bbo = {
        tsNs,
        receivedAtMs: performance.now(),
        bidPx: b.bid_px,
        bidSz: b.bid_sz,
        askPx: b.ask_px,
        askSz: b.ask_sz,
      };
      bump();
      return;
    }
    case MsgType.TRADE: {
      const t = msg as Trade;
      // Quarantine: a trade with a non-finite price or size is corrupt wire data
      // — dropping it keeps the last-good tape instead of a NaN row (and keeps
      // `toBigNs(NaN)` from ever being reached).
      if (!Number.isFinite(t.price) || !Number.isFinite(t.size)) return;
      pushTrade({
        receivedAtMs: performance.now(),
        tsNs: toBigNs(t.ts_ns),
        price: t.price,
        size: t.size,
        side: t.side,
        ...(typeof t.side_src === 'number' ? { sideSrc: t.side_src } : {}),
        venue: t.venue,
      });
      bump();
      return;
    }
    default:
      // BarColumn / Marker are not part of the ladder or tape.
      return;
  }
}

function ensureStreamSubscription(): void {
  if (streamUnsub !== null) return;
  streamUnsub = useFlowMapStore.getState().onStream(handle);
}

// --- public surface -------------------------------------------------------------

/**
 * Current immutable snapshot. Cheap: the object is memoized and only rebuilt after
 * a mutation (so many reads between updates share one allocation). `trades` is
 * reversed to newest-first here, off the high-frequency path.
 */
export function getSnapshot(): BookSnapshot {
  if (cachedSnapshot === null) {
    cachedSnapshot = {
      sessionKey: bufferSessionKey ?? bookSessionKey(),
      sessionVersion,
      version,
      book,
      bbo,
      trades: tradesNewestFirst(),
    };
  }
  return cachedSnapshot;
}

/**
 * Register a panel listener (notified at ~10 Hz max). Lazily opens the single
 * store.onStream subscription on first subscriber. Returns an unsubscribe fn that
 * stops the throttle timer once the last panel leaves.
 */
export function subscribe(cb: (s: BookSnapshot) => void): () => void {
  ensureStreamSubscription();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };
}

/**
 * Clear the current book / BBO / tape for a NEW subscription (symbol switch),
 * WITHOUT tearing down the stream subscription or panel listeners (unlike
 * {@link resetForTest}). Otherwise the DOM ladder keeps the OLD symbol's settled
 * book until the new session's first FINALIZED column arrives (a full interval
 * later, since partials are ignored), and the tape ring keeps showing the old
 * symbol's trades until {@link TRADE_RING} new ones push them out. Bumps the
 * version + schedules a throttled flush so subscribed panels repaint empty.
 * Called from App.tsx alongside the renderer reset on an actual symbol/market
 * switch (see Renderer.resetForSession).
 */
export function resetForSession(): void {
  sessionVersion += 1;
  bufferSessionKey = bookSessionKey();
  book = null;
  bbo = null;
  clearTradeRing();
  bump();
}

// --- test seams (not for production use) ----------------------------------------

/** Inject a stream message directly (bypasses the socket). Unit/e2e only. */
export function ingestForTest(msg: StreamMsg): void {
  handle(msg);
}

/** Force an immediate synchronous listener notification. Unit/e2e only. */
export function flushForTest(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

/** Drop every trade from the ring (session switch / test reset). */
function clearTradeRing(): void {
  tradeRing.fill(undefined);
  tradeHead = -1;
  tradeCount = 0;
  cachedTrades = EMPTY_TRADES;
}

/** Reset all buffer + subscription state. Unit tests only. */
export function resetForTest(): void {
  sessionVersion = 0;
  bufferSessionKey = undefined;
  book = null;
  bbo = null;
  clearTradeRing();
  version = 0;
  cachedSnapshot = null;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  listeners.clear();
  if (streamUnsub !== null) {
    streamUnsub();
    streamUnsub = null;
  }
}

/** Namespace handle (exposed on window.__flowmapLive for the panels e2e). */
export const bookStore = {
  getSnapshot,
  subscribe,
  resetForSession,
  ingestForTest,
  flushForTest,
  resetForTest,
  TRADE_RING,
  THROTTLE_MS,
};
