/**
 * Deep scroll-back history backfill (§8.3 residency, M2 T8).
 *
 * The full-res tile ring holds a bounded recent window (the residency budget,
 * see gl/tileRing). When the user pans LEFT past the oldest resident column and
 * older data still exists, the {@link HistoryLoader} issues a `HistoryRequest`
 * for the missing range, splices the returned `depth_cols` back into the ring at
 * their TRUE absolute col_seq (the ring self-slides its window backward and
 * evicts the live edge — the LRU end), and regenerates the affected SUM-mips.
 *
 * Design notes upheld here:
 *
 * - **Absolute requests.** When supported by the transport, missing pages are
 *   requested by their true col_seq range. A restart can add a timestamp seam
 *   without resetting col_seq, so the newest affine clock cannot locate an
 *   arbitrary old page. A distant pan loads the wanted page directly.
 *
 * - **col_seq ↔ before_t mapping.** Each column carries its own `t0_ns`, so the
 *   loader tracks `(col_seq → t0_ns)` for resident columns as they arrive (live
 *   or backfilled). To fetch the page immediately older than the oldest resident
 *   column it requests `before_t = t0_ns(oldestResident)` — the server's
 *   `history(before_t, n)` is EXCLUSIVE, returning the n most-recent columns with
 *   `t0 < before_t`, i.e. exactly the ones just older than what we hold. When the
 *   exact t0 is unavailable it falls back to `oldestT0 − k·dt_ns` (the spec's
 *   fallback). No dependence on col_seq==interval-index (the sim skips seqs on
 *   capped gaps), so the mapping is robust.
 *
 * - **Coalescing / debounce.** At most ONE request is in flight; `ensureVisible`
 *   is a cheap O(1) guard (compares the visible left edge to the resident oldest)
 *   so it can run every frame without history-proportional work — the §10 perf
 *   gate requires the per-frame path stay O(visible), not O(history).
 *
 * - **Start of history.** The server reports `oldest_available_t_ns`; when a
 *   response is empty or we have reached that bound (or col_seq 0), the loader
 *   latches `startOfHistory` and stops spinning — scroll-back is exhausted, not a
 *   busy-loop.
 *
 * - **Zoom-independent residency.** SUM-mips share the native ring's bounded
 *   time window. Price/time mip selection cannot replace missing columns, so
 *   every viewport that fits the ring may backfill, including its full span.
 *
 * The loader is transport-agnostic: it depends only on an injected
 * `requestHistory` (the store's) and a `spliceColumn` sink (the renderer's), so
 * the range-computation + debounce logic is unit-testable with a fake.
 */

import type { DepthColumn, HistoryResponse } from '../proto/types';
import type { ResidentRange } from '../gl/tileRing';
import { detectDepthSeam, seamGapMarker, seamToleranceNs } from './seam';

/** Max columns per HistoryRequest (mirrors the server's HISTORY_MAX_COLS clamp). */
export const HISTORY_PAGE_COLS = 256;
/**
 * Per-request frame budget. The HistoryResponse is ONE binary WS frame whose
 * size is n_cols × rows × 2 channels × 4 bytes — 256 columns of a 4096-row grid
 * is ~8.4 MB in a single message, and the vite dev proxy measurably DIES on
 * frames that large (direct-to-server delivers the identical page instantly;
 * through the proxy the socket errors server-side and the client times out at
 * 30 s — verified 2026-09-20; the ceiling is load-dependent, ≥3 MB dies even at
 * moderate concurrent traffic). The loader therefore sizes each page so the
 * encoded frame stays under a budget ({@link pageColsForRows}); the renderer
 * keeps full-size pages only on DIRECT transports (the injected Tauri sidecar
 * origin), where the same 8.4 MB frame verified clean.
 */
export const HISTORY_FRAME_BUDGET_BYTES = 2 * 1024 * 1024;
/**
 * Frame budget for the SAME-ORIGIN dev transport (the vite ws proxy): smaller
 * still, because its ceiling shrinks under concurrent live traffic. Pages are
 * latency-bound locally (~one round-trip each), so small pages cost little.
 */
export const HISTORY_DEV_FRAME_BUDGET_BYTES = 512 * 1024;
/**
 * Page size (columns) that keeps one HistoryResponse frame under
 * {@link HISTORY_FRAME_BUDGET_BYTES} for a grid of `rows` rows. Floor of 16 so
 * a poisoned row count still makes progress; ceiling at HISTORY_PAGE_COLS.
 * Pure; unit-tested (history.test.ts).
 */
export function pageColsForRows(rows: number, budgetBytes = HISTORY_FRAME_BUDGET_BYTES): number {
  if (!Number.isFinite(rows) || rows <= 0) return HISTORY_PAGE_COLS;
  const bytesPerCol = rows * 2 * 4; // bid+ask, f32
  const byBudget = Math.floor(budgetBytes / bytesPerCol);
  return Math.max(16, Math.min(HISTORY_PAGE_COLS, byBudget));
}
/** Keep the visible span resident: never fetch so many that the just-viewed
 *  columns get evicted in the same slide. Leave this much headroom. */
const RESIDENT_HEADROOM_COLS = 32;
/** Slack columns fetched below a repaired skip band so the page is aligned to
 *  the server's `before_t` shape (the band's own columns are the newest of the
 *  page; the slack guards the first page's boundary). */
const BAND_REFETCH_SLACK = 8;
/** Max pages one band refetch may consume (band ≤ GAP_ZERO_MAX_COLS = 512 →
 *  2 pages of 256 + one guard page; bounds a hostile/huge request). */
const BAND_REFETCH_MAX_PAGES = 3;

export interface HistoryLoaderDeps {
  /** Request a page of history (the store's `requestHistory`). */
  requestHistory: (before_t: bigint, n: number) => Promise<HistoryResponse>;
  /** Optional exact finalized source range; timestamps may have restart seams. */
  requestSequence?: (start: number, end: number, n: number) => Promise<HistoryResponse>;
  /** Splice one returned column into the ring + mips + CPU caches (renderer). */
  spliceColumn: (col: DepthColumn) => void;
  /** Current full-res resident window (renderer → ring). */
  residentRange: () => ResidentRange | null;
  /** First actually valid column after an unfilled forward gap. */
  validFromSeq?: () => number;
  /** Latest source column, including live columns omitted during scroll-back. */
  latestColumn?: () => { colSeq: number; t0Ns: bigint } | null;
  /** Full-res budget in columns (ring capacity). */
  budgetCols: () => number;
  /** Nominal column interval in ns for the before_t fallback (epoch dt_ns). */
  dtNs: () => number;
  /**
   * Current grid row count (renderer → ring). Drives the per-request page size
   * (see {@link pageColsForRows}): one HistoryResponse frame is n_cols × rows ×
   * 8 bytes, and transports with per-frame ceilings (the vite dev proxy) drop
   * multi-MB messages. Optional — absent means "no rows known", which keeps the
   * historical 256-column page.
   */
  rows?: () => number;
  /**
   * Transport page-size CEILING (columns). Same-origin dev (the vite ws proxy)
   * caps this low via pageColsForRows(rows, HISTORY_DEV_FRAME_BUDGET_BYTES);
   * direct transports (the injected Tauri sidecar origin) leave it at
   * HISTORY_PAGE_COLS. Optional — defaults to the full wire ceiling.
   */
  maxPageCols?: () => number;
  /** Called after a batch splices (renderer marks dirty / refits). Optional. */
  onSpliced?: (resp: HistoryResponse) => void;
  /** Yield background uploads until a display frame has painted. */
  yieldToFrame?: () => Promise<void>;
  /** A detached renderer/ring must never receive a delayed history page. */
  isActive?: () => boolean;
}

/** The view facts the per-frame guard needs (all O(1), no history scan). */
export interface VisibleState {
  /** Live follow may glide slightly behind a full ring; don't fight eviction. */
  following?: boolean;
  /** Absolute column at the viewport's left edge (floor of colOffset). */
  leftCol: number;
  /** Columns across the viewport (time span). */
  span: number;
  /** SUM-mip level the heatmap would sample this frame (0/1/2). */
  level: number;
}

export class HistoryLoader {
  private readonly deps: HistoryLoaderDeps;
  private generation = 0;

  /** (col_seq → t0_ns) for columns we've seen — pruned to the resident window. */
  private readonly colT0 = new Map<number, bigint>();
  /** Oldest col_seq we have a t0 for (anchors the dt fallback). */
  private oldestKnownSeq = -1;
  private oldestKnownT0 = 0n;

  private inFlightBeforeT: bigint | null = null;
  private startOfHistoryFlag = false;
  private requestCountN = 0;
  private lastError: string | null = null;
  /** Server's oldest retained t0 (from the latest response); 0 until known. */
  private oldestAvailableT0 = 0n;
  /** An empty exact page is a local hole, not exhaustion of the whole timeline. */
  private emptySequenceRange: { start: number; end: number } | null = null;
  private visibleView: VisibleState | null = null;
  /** Recently emitted synthetic seam t0s (bounded) — suppresses repeats. */
  private readonly recentSeams: bigint[] = [];
  /** Single-flight guard for {@link refetchBand} (the repaired-skip heal). */
  private bandInFlight = false;
  /** Coalesced band waiting behind an in-flight refetch (merged by min/max —
   *  adjacent bands sharing the later anchor are harmless: already-resident
   *  columns splice idempotently). */
  private pendingBand: { lo: number; hi: number; anchorT0: bigint } | null = null;

  constructor(deps: HistoryLoaderDeps) {
    this.deps = deps;
  }

  /** Current per-request page size (frame-budget + transport-ceiling aware). */
  private pageCols(): number {
    const rows = this.deps.rows ? this.deps.rows() : 0;
    const cap = this.deps.maxPageCols ? this.deps.maxPageCols() : HISTORY_PAGE_COLS;
    return Math.min(cap, pageColsForRows(rows));
  }

  /** A claimed ring slot before this edge may still contain a previous column. */
  private validOldest(range: ResidentRange): number {
    return Math.max(range.oldest, this.deps.validFromSeq?.() ?? range.oldest);
  }

  /**
   * Record a column's (col_seq, t0_ns) as it enters the ring (live or backfill).
   *
   * Self-heals a re-anchored seq→time map (QA3 C-1): a session replacement under
   * the SAME subscription does not run `resetForSession()`, so this loader (and
   * its ring) survive into the new session — whose grid restarts col_seq on a
   * fresh t0 base. A `col_seq` that is already cached with a DIFFERENT t0 is the
   * deterministic signature of that remap; the stale half (before_t anchors,
   * oldest-known anchor, server bound, exhaustion latch) is derived from the OLD
   * grid and would corrupt every subsequent history request, so it is pruned and
   * re-seeded from the live stream.
   */
  noteColumn(colSeq: number, t0Ns: bigint): void {
    const known = this.colT0.get(colSeq);
    if (known !== undefined && known !== t0Ns) {
      this.colT0.clear();
      this.oldestKnownSeq = -1;
      this.oldestKnownT0 = 0n;
      this.oldestAvailableT0 = 0n;
      this.startOfHistoryFlag = false;
      this.lastError = null;
      this.recentSeams.length = 0;
      this.emptySequenceRange = null;
    }
    this.colT0.set(colSeq, t0Ns);
    if (this.oldestKnownSeq < 0 || colSeq < this.oldestKnownSeq) {
      this.oldestKnownSeq = colSeq;
      this.oldestKnownT0 = t0Ns;
    }
    this.pruneCache();
  }

  /** Drop cached t0s well below the resident window so the map stays bounded. */
  private pruneCache(): void {
    const range = this.deps.residentRange();
    if (!range) return;
    const floor = range.oldest - HISTORY_PAGE_COLS * 2;
    const ceiling = range.newest + HISTORY_PAGE_COLS * 2;
    if (this.colT0.size <= this.deps.budgetCols() + HISTORY_PAGE_COLS * 2) return;
    for (const seq of this.colT0.keys()) {
      if (seq < floor || seq > ceiling) this.colT0.delete(seq);
    }
  }

  /**
   * Per-frame guard (called only when the view moved). O(1): if the visible left
   * edge precedes the oldest valid column and older data exists, fire one
   * coalesced HistoryRequest. Mip selection does not change data residency.
   */
  ensureVisible(v: VisibleState): void {
    if (this.deps.requestSequence) this.visibleView = { ...v };
    if (this.inFlightBeforeT !== null) return; // one request at a time
    const budget = this.deps.budgetCols();
    if (v.span > budget) return; // the whole requested view must fit one ring

    const range = this.deps.residentRange();
    if (!range) return;
    if (this.deps.requestSequence) {
      this.ensureSequenceVisible(v, range, budget);
      return;
    }
    const right = v.leftCol + Math.ceil(v.span) - 1;
    const latest = this.deps.latestColumn?.();
    const sourceRight = latest ? Math.min(right, latest.colSeq) : range.newest;
    if (latest && sourceRight > range.newest) {
      // Manual right-pan can revisit columns evicted by an older backfill.
      // Fetch the target's newest page, then the left guard fills any remaining
      // gap on subsequent frames. Never request beyond the real source edge.
      const dt = BigInt(Math.max(1, Math.round(this.deps.dtNs())));
      const beforeT = latest.t0Ns + BigInt(sourceRight - latest.colSeq + 1) * dt;
      const first = Math.max(0, v.leftCol, range.newest + 1);
      const n = Math.min(this.pageCols(), sourceRight - first + 1);
      if (n > 0) void this.fetch(beforeT, n, 'newer');
      return;
    }
    if (this.startOfHistoryFlag) return; // only the older edge is exhausted
    const oldest = this.validOldest(range);
    if (v.following && range.count >= budget && oldest === range.oldest) return;
    // Nothing to do while the view is still comfortably inside the resident
    // window (this also means normal live-follow, where the left edge sits far
    // from the oldest column, never touches the scroll-back path).
    if (v.leftCol >= oldest) return;
    // We WANT older data but the window already reaches absolute col_seq 0 —
    // scroll-back is exhausted at the very start of the stream.
    if (oldest <= 0) {
      this.startOfHistoryFlag = true;
      return;
    }

    const beforeT = this.beforeTFor(oldest);
    if (beforeT === null) return;
    // Already at/behind the server's oldest retained column → exhausted.
    if (this.oldestAvailableT0 > 0n && beforeT <= this.oldestAvailableT0) {
      this.startOfHistoryFlag = true;
      return;
    }

    // Clip the page to the actual requested interval. Sliding farther left than
    // right - budget + 1 would overwrite its visible right edge. Spare capacity
    // can hold a small prefetch reserve; a full-budget view stops at leftCol.
    const pageFloor = Math.max(0, right - budget + 1, v.leftCol - RESIDENT_HEADROOM_COLS);
    const n = Math.min(this.pageCols(), Math.floor(oldest - pageFloor));
    if (n <= 0) return;
    void this.fetch(beforeT, n);
  }

  /** Load only the missing visible page, without walking from the live clock. */
  private ensureSequenceVisible(v: VisibleState, range: ResidentRange, budget: number): void {
    const left = Math.max(0, Math.floor(v.leftCol));
    const right = Math.floor(v.leftCol + Math.ceil(v.span) - 1);
    const latest = this.deps.latestColumn?.();
    const sourceRight = latest ? Math.min(right, latest.colSeq) : Math.min(right, range.newest);
    if (sourceRight < left) return;
    const oldest = this.validOldest(range);
    if (sourceRight > range.newest) {
      const end = sourceRight;
      const start = Math.max(left, range.newest + 1, end - this.pageCols() + 1);
      this.fetchSequence(start, end, 'newer');
      return;
    }
    if (v.following && range.count >= budget && oldest === range.oldest) return;
    if (left >= oldest) return;
    if (oldest <= 0) {
      this.startOfHistoryFlag = true;
      return;
    }
    // A page adjacent to the resident edge is useful only if the view overlaps
    // that edge. For a distant jump, land at the requested right edge instead.
    const end = Math.min(sourceRight, oldest - 1);
    const pageFloor = Math.max(0, right - budget + 1, left - RESIDENT_HEADROOM_COLS);
    const start = Math.max(pageFloor, end - this.pageCols() + 1);
    if (end >= start) this.fetchSequence(start, end, 'older');
  }

  private fetchSequence(start: number, end: number, direction: 'older' | 'newer'): void {
    if (this.emptySequenceRange?.start === start && this.emptySequenceRange.end === end) return;
    // The sentinel only represents singleflight. It is never used as a clock
    // for this request; the server receives the absolute sequence endpoints.
    void this.fetch(0n, end - start + 1, direction, { start, end }, true);
  }

  private sequenceStillVisible(sequence: { start: number; end: number }): boolean {
    const view = this.visibleView;
    if (!view) return true;
    const budget = this.deps.budgetCols();
    const left = Math.max(0, Math.floor(view.leftCol));
    const right = Math.floor(view.leftCol + Math.ceil(view.span) - 1);
    return view.span <= budget && sequence.end >= left && sequence.start <= right &&
      sequence.start >= Math.max(0, right - budget + 1);
  }

  /** before_t for the page immediately older than `oldestResidentSeq`. */
  private beforeTFor(oldestResidentSeq: number): bigint | null {
    const exact = this.colT0.get(oldestResidentSeq);
    if (exact !== undefined) return exact;
    if (this.oldestKnownSeq < 0) return null;
    // Fallback (spec): oldest known t0 minus the seq gap × dt.
    const dt = BigInt(Math.max(1, Math.round(this.deps.dtNs())));
    const gap = BigInt(this.oldestKnownSeq - oldestResidentSeq);
    return this.oldestKnownT0 - gap * dt;
  }

  private async fetch(
    beforeT: bigint, n: number, direction: 'older' | 'newer' = 'older',
    sequence?: { start: number; end: number },
    visibleOnly = false,
  ): Promise<void> {
    const generation = this.generation;
    let abandonedView = false;
    this.inFlightBeforeT = beforeT;
    this.requestCountN += 1;
    try {
      const resp = sequence && this.deps.requestSequence
        ? await this.deps.requestSequence(sequence.start, sequence.end, n)
        : await this.deps.requestHistory(beforeT, n);
      if (!this.active(generation)) return;
      if (visibleOnly && sequence && !this.sequenceStillVisible(sequence)) {
        abandonedView = true;
        return;
      }
      this.oldestAvailableT0 = resp.oldest_available_t_ns;
      this.lastError = null; // the previous failure no longer describes the tail
      // Sort for seam detection; splicePage then descends from the resident
      // anchor. Each upload extends validity by one adjacent column, including
      // during a yielded page, instead of claiming not-yet-uploaded slots.
      const cols = resp.depth_cols
        .filter(c => !sequence || (c.col_seq >= sequence.start && c.col_seq <= sequence.end))
        .sort((a, b) => a.col_seq - b.col_seq);
      if (cols.length === 0) {
        // Nothing older on the server → scroll-back exhausted.
        if (sequence) {
          this.emptySequenceRange = sequence;
          if (direction === 'older' && sequence.start === 0) this.startOfHistoryFlag = true;
        } else if (direction === 'older') this.startOfHistoryFlag = true;
      } else {
        this.emptySequenceRange = null;
        // Honesty (QA3 C-1): a page can belong to a different grid than the
        // resident window (reconstructed/backfilled pages, a session
        // replacement) and splice in with a seq→time break. Surface it as a
        // gap Marker — the renderer forwards `resp.markers` to the overlay
        // manager — instead of silently concatenating two timelines.
        this.markSeams(resp, cols);
        const stillWanted = visibleOnly && sequence ? () => this.sequenceStillVisible(sequence) : undefined;
        if (!await this.splicePage(cols, generation, direction, stillWanted)) {
          abandonedView = stillWanted !== undefined && !stillWanted();
          return;
        }
        // If this batch already reaches the start of history — absolute col_seq
        // 0, or the server's oldest retained column — the next request would
        // return nothing, so pre-latch to skip that wasted empty round-trip.
        // (col_seq 0 is checked explicitly because the sim's t0 base is 0, so a
        // t0-only test would be ambiguous with the "no columns → 0" sentinel.)
        const reachedStart =
          cols.some((c) => c.col_seq === 0) ||
          (!sequence && this.oldestAvailableT0 > 0n && cols.some((c) => c.t0_ns <= this.oldestAvailableT0));
        this.startOfHistoryFlag = reachedStart;
        this.deps.onSpliced?.(resp);
      }
    } catch (err) {
      if (!this.active(generation)) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      // Transient (timeout / disconnect): do NOT latch exhaustion; a later pan
      // retries. Just clear in-flight so the next frame can re-issue.
    } finally {
      if (generation === this.generation) this.inFlightBeforeT = null;
      // A view change consumed the renderer's moved flag while this page was
      // pending. Hand off directly to that latest target after discarding it.
      if (abandonedView && this.active(generation) && this.visibleView) this.ensureVisible(this.visibleView);
    }
  }

  private active(generation: number): boolean {
    return generation === this.generation && (this.deps.isActive?.() ?? true);
  }

  private async splicePage(
    cols: DepthColumn[], generation: number, direction: 'older' | 'newer' = 'older',
    stillWanted?: () => boolean,
  ): Promise<boolean> {
    let start = performance.now();
    let count = 0;
    for (let step = 0; step < cols.length; step++) {
      if (!this.active(generation) || (stillWanted && !stillWanted())) return false;
      const i = direction === 'older' ? cols.length - 1 - step : step;
      const col = cols[i];
      this.noteColumn(col.col_seq, col.t0_ns);
      this.deps.spliceColumn(col);
      count++;
      // A full page can upload several MB. Bound both CPU time and queued GPU
      // work, then allow the live frame/stream to run before continuing.
      if (this.deps.yieldToFrame && step + 1 < cols.length &&
          (count >= 8 || performance.now() - start >= 4)) {
        await this.deps.yieldToFrame();
        start = performance.now();
        count = 0;
      }
    }
    return this.active(generation);
  }

  // --- repaired-skip band refetch (F24) ---------------------------------------

  /**
   * Refetch a REPAIRED forward-skip band `[lo, hi]` and splice the REAL columns
   * over the zeroed slots.
   *
   * The renderer's forward-skip repair (see gl/renderer `GAP_ZERO_MAX_COLS`)
   * zeroes the dropped band so the pre-gap history keeps painting — but a
   * server `tx_lag` drop only evicts the CLIENT'S QUEUE: the columns themselves
   * stay in the session's grid ring and `history(before_t)` still serves them
   * (measured: `inBandN` 2–89 on a live stack). Without this refetch the band
   * stays an honest-but-permanent dark scar (up to 512 columns wide), which is
   * the visible "heatmap bir anda yok oluyor" residue on a stalled/frozen tab.
   *
   * `anchorT0` is the t0 of the FIRST column AFTER the band (the live column
   * whose arrival exposed the skip). The server's `history(before_t, n)` is
   * EXCLUSIVE, so `before_t = anchorT0` returns the band as the newest columns
   * of the page; each page is filtered to `[lo, need]` before splicing (older
   * members of the page are already resident / not ours to write here).
   *
   * Bounded and guarded: single-flight (an arriving band coalesces into one
   * pending slot), at most {@link BAND_REFETCH_MAX_PAGES} pages, and any
   * failure (timeout, disconnect, grid moved on) leaves the zeroes in place —
   * the repair's honest fallback. Splices are idempotent by absolute col_seq,
   * so an overlap with already-resident columns is harmless.
   */
  refetchBand(lo: number, hi: number, anchorT0: bigint): void {
    if (hi < lo) return;
    if (this.bandInFlight) {
      const p = this.pendingBand;
      this.pendingBand =
        p === null ? { lo, hi, anchorT0 } : { lo: Math.min(p.lo, lo), hi: Math.max(p.hi, hi), anchorT0 };
      return;
    }
    void this.runBandRefetch(lo, hi, anchorT0);
  }

  private async runBandRefetch(lo: number, hi: number, anchorT0: bigint): Promise<void> {
    const generation = this.generation;
    this.bandInFlight = true;
    try {
      let need = hi;
      let beforeT = anchorT0;
      let lastResp: HistoryResponse | null = null;
      for (let page = 0; page < BAND_REFETCH_MAX_PAGES && need >= lo; page++) {
        const want = need - lo + 1;
        const n = Math.min(this.pageCols(), want + (this.deps.requestSequence ? 0 : BAND_REFETCH_SLACK));
        const resp = this.deps.requestSequence
          ? await this.deps.requestSequence(need - n + 1, need, n)
          : await this.deps.requestHistory(beforeT, n);
        if (!this.active(generation)) return;
        const cols = resp.depth_cols
          .filter((c) => c.col_seq >= lo && c.col_seq <= need)
          .sort((a, b) => a.col_seq - b.col_seq);
        if (cols.length === 0) break; // the server does not hold the band — keep zeroes
        if (!await this.splicePage(cols, generation)) return;
        lastResp = resp;
        // The next page must be strictly older than everything this page held.
        let oldestT = cols[0].t0_ns;
        for (const c of resp.depth_cols) if (c.t0_ns < oldestT) oldestT = c.t0_ns;
        beforeT = oldestT;
        need = cols[0].col_seq - 1;
        if (resp.depth_cols.length < n) break; // server exhausted
      }
      if (lastResp !== null) this.deps.onSpliced?.(lastResp);
    } catch (err) {
      if (!this.active(generation)) return;
      // Transient failure: the zeroed band stays the honest fallback; do not
      // latch anything — the next skip gets its own attempt.
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation !== this.generation) return;
      this.bandInFlight = false;
      const p = this.pendingBand;
      this.pendingBand = null;
      if (p !== null) void this.runBandRefetch(p.lo, p.hi, p.anchorT0);
    }
  }

  /**
   * Append synthetic `gap` Markers to a page about to be spliced when the page
   * cannot be one continuous timeline with the resident window (QA3 C-1).
   *
   * Two boundaries are checked:
   *  1. inside the page — consecutive columns must march forward at the epoch
   *     cadence. Only the FIRST inconsistent pair of a run is reported: a
   *     reconstructed page is uniformly warped (one marker at its head is the
   *     honest report, not 256).
   *  2. page ↔ resident anchor — the newest page column's t0 must sit
   *     `(anchorSeq − pageSeq) × dt` below the resident oldest's t0. A mismatch
   *     means the page and the ring span different grids; the marker lands at
   *     the resumption side (the anchor), where the chart shows the jump.
   *
   * Markers already present on the response (the server's own gap markers) and
   * recently emitted seams are not duplicated.
   */
  private markSeams(resp: HistoryResponse, cols: DepthColumn[]): void {
    const dtRaw = this.deps.dtNs();
    const dtNs = Number.isFinite(dtRaw) && dtRaw > 0 ? BigInt(Math.round(dtRaw)) : null;
    const tol = seamToleranceNs(dtNs);
    const found: { ts: bigint; text: string }[] = [];

    let runConsistent = true;
    for (let i = 1; i < cols.length; i++) {
      const prev = cols[i - 1];
      const next = cols[i];
      if (next.col_seq <= prev.col_seq) continue;
      const verdict = detectDepthSeam(prev, next, dtNs);
      if (verdict === null) {
        runConsistent = true;
        continue;
      }
      if (runConsistent || verdict.kind === 'backward') {
        found.push({
          ts: next.t0_ns,
          text:
            verdict.kind === 'backward'
              ? 'history page seam (time went backward)'
              : 'history page seam (cadence break)',
        });
      }
      runConsistent = false;
    }

    const range = this.deps.residentRange();
    if (range !== null && dtNs !== null) {
      const oldest = this.validOldest(range);
      const anchorT0 = this.colT0.get(oldest);
      const newest = cols[cols.length - 1];
      if (anchorT0 !== undefined && newest.col_seq < oldest) {
        const expected = anchorT0 - BigInt(oldest - newest.col_seq) * dtNs;
        const delta = newest.t0_ns - expected;
        const dev = delta > 0n ? delta : -delta;
        if (dev > tol) {
          found.push({ ts: anchorT0, text: 'history seam (page grid mismatch)' });
        }
      }
    }

    for (const seam of found) {
      if (this.seamRecentlyReported(seam.ts, dtNs)) continue;
      if (this.hasServerGapNear(resp, seam.ts, dtNs)) continue;
      resp.markers.push(seamGapMarker(seam.ts, seam.text));
      this.recentSeams.push(seam.ts);
      if (this.recentSeams.length > 8) this.recentSeams.shift();
    }
  }

  /** Dedupe window: wide enough to collapse the two sides of one gap. */
  private seamDedupeNs(dtNs: bigint | null): bigint {
    const fromDt = dtNs !== null && dtNs > 0n ? dtNs * 64n : 0n;
    const floor = 30_000_000_000n; // 30 s
    return fromDt > floor ? fromDt : floor;
  }

  private seamRecentlyReported(tsNs: bigint, dtNs: bigint | null): boolean {
    const win = this.seamDedupeNs(dtNs);
    for (const seen of this.recentSeams) {
      const d = seen > tsNs ? seen - tsNs : tsNs - seen;
      if (d <= win) return true;
    }
    return false;
  }

  private hasServerGapNear(resp: HistoryResponse, tsNs: bigint, dtNs: bigint | null): boolean {
    const win = this.seamDedupeNs(dtNs);
    for (const m of resp.markers) {
      if (m.kind !== 'gap') continue;
      const d = m.ts_ns > tsNs ? m.ts_ns - tsNs : tsNs - m.ts_ns;
      if (d <= win) return true;
    }
    return false;
  }

  /**
   * One-time eager backfill (the first-launch "history depth" setting): page
   * history in until `targetCols` columns are resident or history is exhausted.
   *
   * The requested depth is CLAMPED to the ring budget minus a headroom reserve
   * (the same protection {@link ensureVisible} gives itself): the tile ring only
   * holds `budgetCols` columns, so pulling more would slide the window backward
   * and physically overwrite the live edge. With the clamp the loop terminates
   * before the ring fills, leaving the newest/live columns resident. Paged and
   * sequential (respects the single-in-flight rule); a hard page cap stops it from
   * ever spinning. Yields immediately if a scroll-back fetch is already active.
   */
  async prefetch(targetCols: number): Promise<void> {
    const generation = this.generation;
    if (!(targetCols > 0)) return;
    // Never ask for more than the ring can hold alongside a resident live window.
    const budget = this.deps.budgetCols();
    const effTarget = Math.min(targetCols, Math.max(1, budget - RESIDENT_HEADROOM_COLS));
    for (let page = 0; page < 64; page++) {
      if (!this.active(generation)) return;
      if (this.startOfHistoryFlag) return;
      if (this.inFlightBeforeT !== null) return; // a scroll-back fetch owns the channel
      const range = this.deps.residentRange();
      if (!range) return;
      const oldest = this.validOldest(range);
      const count = range.newest - oldest + 1;
      if (count >= effTarget) return; // enough actually loaded (and ring-safe)
      if (oldest <= 0) {
        this.startOfHistoryFlag = true;
        return;
      }
      if (this.deps.requestSequence) {
        const end = oldest - 1;
        const n = Math.max(1, Math.min(this.pageCols(), Math.ceil(effTarget - count), oldest));
        const start = end - n + 1;
        if (this.emptySequenceRange?.start === start && this.emptySequenceRange.end === end) return;
        await this.fetch(0n, n, 'older', { start, end });
        continue;
      }
      const beforeT = this.beforeTFor(oldest);
      if (beforeT === null) return;
      if (this.oldestAvailableT0 > 0n && beforeT <= this.oldestAvailableT0) {
        this.startOfHistoryFlag = true;
        return;
      }
      const n = Math.max(1, Math.min(this.pageCols(), Math.ceil(effTarget - count)));
      await this.fetch(beforeT, n);
    }
  }

  /**
   * Clear ALL scroll-back state (go-live / re-subscribe / context restore).
   *
   * This is more than the in-flight/latch pair it used to clear: the (col_seq →
   * t0_ns) cache, the oldest-known anchor and the server's oldest-available
   * bound belong to the SESSION the loader was backfilling. A re-subscribe
   * reuses this instance for a NEW session whose grid restarts at col_seq 0 —
   * a surviving cache would (a) derive before_t from the OLD symbol's price
   * frame (wrong t0s under the reused seq keys) and (b) false-latch
   * start-of-history as soon as the new session's early t0s fall below the old
   * server bound, killing scroll-back for the new symbol. Clearing costs a
   * re-seed (the renderer notes every column it writes, so the next live column
   * restores the mapping) and at worst one wasted probe round-trip after
   * go-live.
   */
  reset(): void {
    this.generation++;
    this.bandInFlight = false;
    this.pendingBand = null;
    this.inFlightBeforeT = null;
    this.startOfHistoryFlag = false;
    this.colT0.clear();
    this.oldestKnownSeq = -1;
    this.oldestKnownT0 = 0n;
    this.oldestAvailableT0 = 0n;
    this.emptySequenceRange = null;
    this.visibleView = null;
    this.lastError = null;
  }

  // --- diagnostics (dev hook / e2e) --------------------------------------------

  /** Number of HistoryRequests issued so far. */
  get requestCount(): number {
    return this.requestCountN;
  }
  /** Whether a request is currently in flight. */
  get inFlight(): boolean {
    return this.inFlightBeforeT !== null;
  }
  /** Whether scroll-back has hit the start of available history. */
  get startOfHistory(): boolean {
    return this.startOfHistoryFlag;
  }
  /** Last request error message (or null). */
  get error(): string | null {
    return this.lastError;
  }
}
