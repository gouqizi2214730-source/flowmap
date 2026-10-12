/**
 * Viewport-percentile normalization (§8.3, M2 T9).
 *
 * The heatmap's contrast must normalize to the VISIBLE window, not the live edge.
 * If you pan into an overnight, low-liquidity region it should renormalize so the
 * (dimmer) structure there stays visible — instead of staying scaled to the
 * brighter live edge and rendering the old region as near-black.
 *
 * Mechanism (all CPU, all O(tiles-in-view) — never O(history)):
 *
 *   1. A coarse **per-tile 256-bin histogram** of NON-ZERO density is maintained
 *      incrementally as columns are appended/backfilled. One tile = one
 *      `colsPerTile`-wide block of columns (the tile-array layer the ring uses),
 *      keyed by ABSOLUTE tile index `floor(colSeq/colsPerTile)`. Bins are
 *      **logarithmic** — order-flow density is heavy-tailed (a handful of walls
 *      dwarf the ladder), so log bins spend resolution where the mass is and a
 *      p99 lands on a meaningful bin instead of saturating the top linear bin.
 *
 *   2. On pan/zoom (or every dirty frame) the tiles covering the visible column
 *      range have their histograms **summed** (a few × 256 adds, <1 ms) and TWO
 *      ranks are read off the ONE merged CDF with in-bin log interpolation: the
 *      KNEE ({@link DEFAULT_PERCENTILE}, p97) and the WHITE
 *      ({@link DEFAULT_WHITE_PERCENTILE}, p99.7 — what feeds `u_norm`). This is
 *      `O(tiles in view)`, not `O(columns)`: the merge touches
 *      ~`colSpan/colsPerTile` histograms regardless of how many columns those
 *      tiles hold, and the memo makes it once per dirty key.
 *
 *   3. The raw percentile is **EMA-smoothed** frame-to-frame (~0.3 s settle at
 *      60 fps) so the divisor glides into a new regime instead of flickering.
 *      `Hello.norm_seed` seeds frame 0.
 *
 *   4. **Mip coordination (the T7 seam).** Level-L mip texels SUM a 4^L×4^L block,
 *      so a naive normalization would have to multiply the percentile by the sum
 *      factor `4^L` to keep a coarser level's brighter texels inside [0,1]. BUT
 *      the T7 heatmap fragment shader already folds the *wall-preserving* `1/4^L`
 *      (`/blk`) back out of `intensity` BEFORE dividing by `u_norm`
 *      (`intensity = (accR+accG)*decodeScale/blk`). The sum factor and T7's
 *      rescale therefore CANCEL: the level-0 density percentile is already on the
 *      shader's per-pixel intensity scale for the dominant (p99, wall-like)
 *      structure, so the net mip scaling applied here is **unity**. Multiplying by
 *      `4^L` on top of T7's `1/4^L` would double-apply and make walls vanish on
 *      zoom-out — the exact bug the SUM-mip exists to prevent. See
 *      {@link mipSumFactor} / {@link t7ShaderRescale} / {@link normMipScale}: the
 *      `mipLevel` argument is honored, the two factors are made explicit, and
 *      their product is 1.
 *
 * The class is PURE CPU with no GL — histogram merge, percentile, EMA and tile
 * eviction are all unit-testable without a WebGL context (see normalize.test.ts).
 */

import { priceToRow, rowToPrice, type PriceScale } from './priceScale';
import { ViewWorker } from './viewWorker';

export const DEFAULT_BINS = 256;
const ROW_BAND = 64;
interface SpatialHistogram { scale: PriceScale; bands: Map<number, Int32Array[]>; counts: Map<number, number>; columns: Set<number> }
interface ColumnContribution { histogram: Int32Array; key: string | null; scale: PriceScale | null; rows: Uint16Array | Uint32Array }
export const PHYSICAL_NORM_FLOOR = 1e-8;
export interface NormalizeSource { bid: Float32Array; ask: Float32Array | null; scale?: PriceScale | null }
/**
 * Default viewport KNEE percentile (Bookmap-class overhaul, lane F). The knee is
 * the transfer curve's segment boundary — below it the field is lifted by the
 * display gamma, above it log-compressed so wall cores differentiate instead of
 * all clamping to the same top. p97 was the historical white point; it stays the
 * KNEE while the new {@link DEFAULT_WHITE_PERCENTILE} carries the white endpoint.
 * The p97/p99 headroom ratio is pinned by the "p97 vs p99 headroom" test.
 */
export const DEFAULT_PERCENTILE = 97;
/**
 * Default viewport WHITE point (Bookmap-class overhaul, lane F): what feeds the
 * EMA → `u_norm`. p99.7 makes the top of the ramp reachable only around the
 * heavy-tail's p99.7, so the wall band (p97..p99.7) spreads across LUT entries
 * instead of clamping early. `Hello.norm_seed` is still p99 (server, untouched)
 * — the EMA settles the ~0.3 s gap. The knee fraction uploaded to the shader is
 * `knee / white` from the SAME merged CDF (u_knee, clamped [0.05, 0.95]).
 */
export const DEFAULT_WHITE_PERCENTILE = 99.7;
/** Log-bin range low edge (density below this clamps into bin 0). */
export const DEFAULT_HIST_MIN = 1e-8;
/** Log-bin range high edge (density above this clamps into the top bin). */
export const DEFAULT_HIST_MAX = 1e15; // venue base units, including low-price coins
/** Per-call EMA weight on the fresh percentile (~90% settle in ~15 calls ≈ 0.25 s @60fps). */
export const DEFAULT_EMA_ALPHA = 0.15;
/** Floor on the returned norm so a tiny seed / empty viewport can't blow out intensity. */
export const DEFAULT_NORM_FLOOR = 4;
/** Default cap on retained per-tile histograms (≥ ring layers + margin). */
export const DEFAULT_MAX_TILES = 128;
/** EMA is "settled" once |raw − ema| ≤ this fraction of ema (drives redraw-until-settled). */
const SETTLE_EPS = 0.02;

/** Slider 100 targets p90; sampler/quantization margins preserve visible walls. */
export const TOLERANCE_MAX_PERCENTILE = 90;
/** Keep the cut below the full-density endpoint when the distribution has ties. */
export const TOLERANCE_MAX_NORMALIZED_FLOOR = 0.85;

export function percentileForTolerance(tolerance: number): number {
  if (!Number.isFinite(tolerance)) return 0;
  const value = Math.min(100, Math.max(0, tolerance));
  return value <= 50 ? value : 50 + (value - 50) * 0.8;
}

export interface ColRange {
  /** Oldest visible absolute col_seq (inclusive). */
  oldest: number;
  /** Newest visible absolute col_seq (inclusive). */
  newest: number;
}

export interface RowRange {
  /** Lowest visible row (inclusive). */
  lo: number;
  /** Highest visible row (inclusive). */
  hi: number;
  /** Physical viewport bounds keep mixed native epochs on the same prices. */
  priceLo?: number;
  priceHi?: number;
  referenceStep?: number;
}

export interface NormalizeConfig {
  bins?: number;
  percentile?: number;
  /** White-point percentile (default {@link DEFAULT_WHITE_PERCENTILE} = 99.7). */
  whitePercentile?: number;
  colsPerTile?: number;
  histMin?: number;
  histMax?: number;
  emaAlpha?: number;
  floor?: number;
  maxTiles?: number;
  sourceColumn?: (col: number) => NormalizeSource | null;
  maxSpatialBytes?: number;
  useWorker?: boolean;
  onAsyncReady?: () => void;
}

/** The SUM-mip sum factor for level L: level-L texels sum a 4^L×4^L block. */
export function mipSumFactor(level: number): number {
  return 4 ** Math.max(0, Math.floor(level));
}

/**
 * The rescale T7's heatmap shader already folds into `intensity` (`/blk` where
 * blk = 4^L), reduced from the spec's naive `1/16^L` to the wall-preserving
 * `1/4^L`. This is DONE IN THE SHADER, not here — exposed so the coordination is
 * explicit and checkable.
 */
export function t7ShaderRescale(level: number): number {
  return 1 / mipSumFactor(level);
}

/**
 * Net mip scaling applied to the viewport percentile so it lands on the shader's
 * per-pixel intensity scale. Equals `mipSumFactor(L) × t7ShaderRescale(L) === 1`
 * for every L: the sum factor is exactly cancelled by T7's in-shader `/4^L`
 * (§8.3 "fold the block rescale into normalization", coordinated so it is NOT
 * double-applied). Kept as a function so a future averaging-mip convention has a
 * single place to reintroduce a real factor.
 */
export function normMipScale(level: number): number {
  return mipSumFactor(level) * t7ShaderRescale(level);
}

export class ViewportNormalizer {
  readonly bins: number;
  /** KNEE percentile (lane F): the transfer curve's segment boundary. Mutable —
   *  the Settings "Saturation" control retunes it live; read fresh off the CDF
   *  every frame. The historical white point (p99) semantics moved to
   *  {@link whitePercentile}. */
  percentile: number;
  /** WHITE-point percentile (lane F, default {@link DEFAULT_WHITE_PERCENTILE}):
   *  the rank that feeds the EMA → `u_norm`. Mutable like {@link percentile};
   *  included in the memo key so a change re-merges. */
  whitePercentile: number;
  readonly colsPerTile: number;
  readonly floor: number;
  readonly alpha: number;
  readonly maxTiles: number;

  private readonly logMin: number;
  private readonly logMax: number;
  private readonly binScale: number; // bins / (logMax - logMin)

  /** Absolute tile index → 256-bin non-zero-density histogram. */
  private readonly tiles = new Map<number, Int32Array>();
  private readonly spatialTiles = new Map<number, Map<string, SpatialHistogram>>();
  private readonly replaceableColumns = new Map<number, ColumnContribution>();
  private readonly sourceColumn: NormalizeConfig['sourceColumn'];
  private readonly maxSpatialBytes: number;
  private spatialBytes = 0;
  private readonly directTiles = new Set<number>();
  private readonly admittedColumns = new Map<number, Set<number>>();
  /** 0=sum, 1=bid, 2=ask; ranks use the same channel as the shader. */
  channel = 0;
  /** Absolute tile index → membership bits for FINAL columns already folded. */
  private readonly foldedColumns = new Map<number, Uint32Array>();
  /** Scratch merge accumulator (reused; never leaks between calls). */
  private readonly merged: Int32Array;
  /** Samples in the last visible CDF; zero for a viewport with no density. */
  private mergedTotal = 0;

  /**
   * Bumped on EVERY histogram-affecting mutation (a column fold, a tile
   * eviction, reset). The viewport-percentile memo below keys on it, so a dirty
   * frame with an unchanged visible window and unchanged histograms skips the
   * tile merge entirely (survey #6a: updateNormalization runs every dirty
   * frame; the merge was the only O(tiles·bins) part of it).
   */
  private versionN = 0;
  /** Memo key of the last {@link viewportPercentiles} merge. */
  private memoKey = {
    oldest: Number.NaN,
    newest: Number.NaN,
    percentile: -1,
    whitePercentile: -1,
    level: -1,
    version: -1,
    rowLo: Number.NaN, rowHi: Number.NaN, priceLo: Number.NaN, priceHi: Number.NaN, referenceStep: Number.NaN, channel: -1,
  };
  /** Memoized merge result (raw knee + white ranks, pre-EMA). */
  private memoRanks = { knee: 0, white: 0 };
  /** Actual merges performed (diagnostics/tests: the memo-hit counter's twin). */
  private mergeCountN = 0;

  /** EMA of the WHITE rank — what `u_norm` is fed. */
  private ema = 0;
  /** EMA of the KNEE rank (same alpha), for the per-frame `u_knee = knee/white`. */
  private emaKnee = 0;
  private seeded = false;
  /** Last raw viewport percentile computed (pre-EMA); for the settle test. */
  private lastRaw = 0;
  private lastRawKnee = 0;
  /**
   * Test-only pin (R2-M2): while frozen, {@link updateNorm} returns the pinned
   * floored norm without stepping the EMA, so repeated grabs of a sealed frame
   * are deterministic. {@link reset} clears it.
   */
  private frozen = false;
  private readonly useWorker: boolean;
  private readonly onAsyncReady?: () => void;
  private worker: ViewWorker | null = null;
  private workerView = '';
  private workerVersion = -1;
  private workerGeneration = 0;
  calculationState: 'idle' | 'pending' | 'ready' | 'failed' = 'idle';

  constructor(cfg: NormalizeConfig = {}) {
    this.bins = cfg.bins ?? DEFAULT_BINS;
    this.percentile = cfg.percentile ?? DEFAULT_PERCENTILE;
    this.whitePercentile = cfg.whitePercentile ?? DEFAULT_WHITE_PERCENTILE;
    this.colsPerTile = cfg.colsPerTile ?? 256;
    this.floor = cfg.floor ?? DEFAULT_NORM_FLOOR;
    this.alpha = cfg.emaAlpha ?? DEFAULT_EMA_ALPHA;
    this.maxTiles = cfg.maxTiles ?? DEFAULT_MAX_TILES;
    this.sourceColumn = cfg.sourceColumn;
    this.maxSpatialBytes = cfg.maxSpatialBytes ?? 16 * 1024 * 1024;
    this.useWorker = cfg.useWorker ?? false;
    this.onAsyncReady = cfg.onAsyncReady;

    const histMin = cfg.histMin ?? DEFAULT_HIST_MIN;
    const histMax = cfg.histMax ?? DEFAULT_HIST_MAX;
    this.logMin = Math.log(histMin);
    this.logMax = Math.log(histMax);
    this.binScale = this.bins / (this.logMax - this.logMin);
    this.merged = new Int32Array(this.bins);
  }

  /** Seed the EMA (frame 0) from `Hello.norm_seed`. Floored, no-op if ≤0. The
   *  knee EMA is seeded to the same value (ratio 1 until the first real merge —
   *  the shader clamp keeps that harmless and the settle takes ~0.3 s). */
  seed(norm: number): void {
    if (!(norm > 0)) return;
    this.ema = Math.max(norm, this.floor);
    this.emaKnee = this.ema;
    this.lastRaw = this.ema;
    this.lastRawKnee = this.emaKnee;
    this.seeded = true;
    this.versionN++; // the empty-window fallback reads `ema` — re-merge once
  }

  /** Whether any non-zero density has been binned (else the seed/floor holds). */
  hasData(): boolean {
    return this.tiles.size > 0;
  }

  /** Number of per-tile histograms currently retained (bounded ≤ maxTiles). */
  get retainedTiles(): number {
    return this.tiles.size;
  }
  get retainedBytes(): number {
    let bytes = this.spatialBytes;
    for (const hist of this.tiles.values()) bytes += hist.byteLength;
    for (const value of this.replaceableColumns.values()) bytes += value.histogram.byteLength + value.rows.byteLength;
    return bytes;
  }

  /** Total non-zero samples folded across all retained tiles (diagnostics/tests:
   *  the double-count detector for re-sent columns). */
  get totalSamples(): number {
    let total = 0;
    for (const hist of this.tiles.values()) {
      for (let b = 0; b < this.bins; b++) total += hist[b];
    }
    return total;
  }

  /** Histogram-mutation counter (diagnostics/tests: memo invalidations). */
  get tilesVersion(): number {
    return this.versionN;
  }

  /** Actual tile merges performed (diagnostics/tests: memo effectiveness). */
  get mergeCount(): number {
    return this.mergeCountN;
  }

  /** Current EMA-smoothed norm (what was last fed to `u_norm`), floored. */
  get current(): number {
    return Math.max(this.ema, this.floor);
  }

  /**
   * Current EMA-smoothed KNEE/WHITE pair (lane F) for the per-frame shader
   * `u_knee = clamp(knee / white, 0.05, 0.95)`. Both ranks share the same merge
   * and EMA alpha, so the ratio is a stable per-frame constant; `white` equals
   * {@link current}. Before the first real merge (seed only) the pair is the
   * seed value — the shader clamp absorbs the ratio-1 frames.
   */
  get currentPercentiles(): { knee: number; white: number } {
    return { knee: Math.max(this.emaKnee, this.floor), white: Math.max(this.ema, this.floor) };
  }

  /**
   * Calibrate the 0–100 noise filter against the last merged visible CDF.
   * A fraction of the p99.7 white point erased ordinary BTC/RUNE levels because
   * their median is orders of magnitude below that white point. This reads a
   * density rank instead: midpoint p50, strongest setting p90, zero no cut.
   * The one-bin margin prevents quantization/ties from removing a flat book.
   * No histogram merge, allocation, or full-history scan occurs here.
   */
  floorForTolerance(tolerance: number): number {
    const percentile = percentileForTolerance(tolerance);
    if (!(percentile > 0) || this.mergedTotal === 0) return 0;
    const density = this.readRank(this.merged, this.mergedTotal, percentile);
    // Physical-width sampling preserves density. Keep only the one-bin margin
    // so quantization/ties cannot erase an equal-density ladder.
    const margin = 0.95 * Math.exp(-1 / this.binScale);
    const ratio = density * margin / this.current;
    return Number.isFinite(ratio)
      ? Math.min(TOLERANCE_MAX_NORMALIZED_FLOOR, Math.max(0, ratio))
      : 0;
  }

  /** Map a strictly-positive density to a log bin index in [0, bins-1]. */
  private binOf(v: number): number {
    const idx = Math.floor((Math.log(v) - this.logMin) * this.binScale);
    return idx < 0 ? 0 : idx >= this.bins ? this.bins - 1 : idx;
  }

  /** Absolute tile index for an absolute col_seq. */
  private tileOf(colSeq: number): number {
    return Math.floor(colSeq / this.colsPerTile);
  }

  /**
   * Fold one column's NON-ZERO densities (bid, and ask when present) into its
   * tile histogram. Called for every appended / spliced column — O(rows), a
   * handful per second live. Zeros are skipped so the distribution reflects
   * active price levels only (which also makes the visible row range moot at
   * tile granularity: empty rows never enter the histogram).
   */
  addColumn(colSeq: number, bid: Float32Array, ask: Float32Array | null, scale: PriceScale | null = null, remember = false): void {
    const tile = this.tileOf(colSeq);
    let hist = this.tiles.get(tile);
    if (!hist) { this.evictIfFull(tile); hist = new Int32Array(this.bins); this.tiles.set(tile, hist); }
    const retain = remember || (scale !== null && !this.sourceColumn);
    const contribution: ColumnContribution | null = retain ? { histogram: new Int32Array(this.bins),
      key: scale ? JSON.stringify(scale) : null, scale, rows: new Uint16Array(0) } : null;
    const compact: number[] | null = retain ? [] : null;
    let spatial: SpatialHistogram | null = null;
    if (scale && !this.directTiles.has(tile)) {
      const key = JSON.stringify(scale);
      let parts = this.spatialTiles.get(tile);
      if (!parts) { parts = new Map(); this.spatialTiles.set(tile, parts); }
      spatial = parts.get(key) ?? null;
      if (!spatial) { spatial = { scale, bands: new Map(), counts: new Map(), columns: new Set() }; parts.set(key, spatial); }
      spatial.columns.add(colSeq);
    }
    for (let r = 0; r < bid.length; r++) {
      const b = bid[r], a = ask?.[r] ?? 0;
      const sum = b + a > 0 ? this.binOf(b + a) + 1 : 0;
      const bb = b > 0 ? this.binOf(b) + 1 : 0, ab = a > 0 ? this.binOf(a) + 1 : 0;
      if (bb) { hist[bb - 1]++; if (contribution) contribution.histogram[bb - 1]++; }
      if (ab) { hist[ab - 1]++; if (contribution) contribution.histogram[ab - 1]++; }
      if (!(bb || ab)) continue;
      if (compact) compact.push(r, sum, bb, ab);
      if (!spatial) continue;
      const band = Math.floor(r / ROW_BAND);
      let channels = spatial.bands.get(band);
      if (!channels) {
        if (this.spatialBytes + this.bins * 12 > this.maxSpatialBytes) {
          this.dropSpatialTile(tile); this.directTiles.add(tile); spatial = null; continue;
        }
        channels = [new Int32Array(this.bins), new Int32Array(this.bins), new Int32Array(this.bins)];
        spatial.bands.set(band, channels); this.spatialBytes += this.bins * 12;
      }
      spatial.counts.set(band, (spatial.counts.get(band) ?? 0) + 1);
      if (sum) channels[0][sum - 1]++;
      if (bb) channels[1][bb - 1]++;
      if (ab) channels[2][ab - 1]++;
    }
    this.versionN++;
    let admitted = this.admittedColumns.get(tile);
    if (!admitted) { admitted = new Set(); this.admittedColumns.set(tile, admitted); }
    admitted.add(colSeq);
    if (contribution && compact) {
      contribution.rows = this.bins < 65535 && bid.length <= 65536 ? Uint16Array.from(compact) : Uint32Array.from(compact);
      this.replaceableColumns.set(colSeq, contribution);
    }
  }

  /** Revisions subtract their compact row/bin contribution. No dense per-column
   * histogram copies and no empty native-map index survives a replacement. */
  replaceColumn(colSeq: number, bid: Float32Array, ask: Float32Array | null, scale: PriceScale | null = null): void {
    const previous = this.replaceableColumns.get(colSeq);
    if (previous) {
      const tile = this.tileOf(colSeq), histogram = this.tiles.get(tile);
      if (histogram) for (let i = 0; i < this.bins; i++) histogram[i] -= previous.histogram[i];
      const part = previous.key ? this.spatialTiles.get(tile)?.get(previous.key) : null;
      part?.columns.delete(colSeq);
      if (part) for (let i = 0; i < previous.rows.length; i += 4) {
        const band = Math.floor(previous.rows[i] / ROW_BAND), channels = part.bands.get(band);
        if (!channels) continue;
        for (let ch = 0; ch < 3; ch++) { const bin = previous.rows[i + ch + 1] - 1; if (bin >= 0) channels[ch][bin]--; }
        const count = (part.counts.get(band) ?? 1) - 1;
        if (count <= 0) { part.bands.delete(band); part.counts.delete(band); this.spatialBytes -= this.bins * 12; }
        else part.counts.set(band, count);
      }
      if (part?.bands.size === 0 && previous.key) this.spatialTiles.get(tile)?.delete(previous.key);
    }
    this.addColumn(colSeq, bid, ask, scale, true);
  }

  /**
   * Fold one FINAL column's densities into its tile histogram, exactly ONCE per
   * column id. Membership is recorded per tile so overlapping pages deduplicate
   * while previously unseen older columns still contribute during backfill.
   *
   * Callers MUST pass only `final === true` columns here — a forming column's
   * partial fold would mark the column seen and its final data would be dropped.
   */
  foldColumnFinal(colSeq: number, bid: Float32Array, ask: Float32Array | null, scale: PriceScale | null = null): void {
    const tile = this.tileOf(colSeq);
    const offset = colSeq - tile * this.colsPerTile;
    const word = Math.floor(offset / 32);
    const bit = 1 << (offset % 32);
    let membership = this.foldedColumns.get(tile);
    if (membership !== undefined && (membership[word] & bit) !== 0) return;
    this.addColumn(colSeq, bid, ask, scale);
    if (membership === undefined) {
      membership = new Uint32Array(Math.ceil(this.colsPerTile / 32));
      this.foldedColumns.set(tile, membership);
    }
    membership[word] |= bit;
  }

  /** Evict the retained tile farthest from `nearTile` when the cap is reached. */
  private evictIfFull(nearTile: number): void {
    if (this.tiles.size < this.maxTiles) return;
    let victim = -1;
    let bestDist = -1;
    for (const t of this.tiles.keys()) {
      const d = Math.abs(t - nearTile);
      if (d > bestDist) {
        bestDist = d;
        victim = t;
      }
    }
    if (victim >= 0) {
      this.tiles.delete(victim);
      this.dropSpatialTile(victim);
      this.directTiles.delete(victim);
      this.admittedColumns.delete(victim);
      for (const col of this.replaceableColumns.keys()) if (this.tileOf(col) === victim) this.replaceableColumns.delete(col);
      // Membership belongs to the histogram and must disappear with eviction.
      this.foldedColumns.delete(victim);
      this.versionN++; // a tile left the merge set
    }
  }

  private dropSpatialTile(tile: number): void {
    const parts = this.spatialTiles.get(tile);
    if (parts) for (const part of parts.values()) this.spatialBytes -= part.bands.size * this.bins * 12;
    this.spatialTiles.delete(tile);
  }

  /**
   * RAW merged viewport KNEE percentile (no EMA) — the historical single-read
   * API, kept as a thin alias of {@link viewportPercentiles}.knee so existing
   * callers keep reading the configured (`percentile`) rank.
   */
  viewportPercentile(col: ColRange, row: RowRange, mipLevel: number): number {
    return this.viewportPercentiles(col, row, mipLevel).knee;
  }

  /**
   * RAW merged viewport KNEE + WHITE percentiles (lane F): TWO rank reads off
   * ONE merged CDF. MEMOIZED on {visible col range, knee percentile, white
   * percentile, mip level, tilesVersion}: repeated calls with an unchanged
   * window and no histogram mutation (the every-dirty-frame case while columns
   * stream in elsewhere, or while the norm EMA settles) return the cached pair
   * WITHOUT re-merging the covered tiles' histograms — `mergeCount` increments
   * exactly once per memo-key change, never once per read. Identical output —
   * the merge is a pure function of exactly those keys.
   *
   * Both ranks carry the mip scaling ({@link normMipScale}, = 1) and the norm
   * floor. `O(tiles in view)`, executed at most once per memo-key change.
   *
   * `row` is accepted per the T9 contract but NOT used to sub-filter: the coarse
   * per-tile histograms are deliberately not row-partitioned (that would cost
   * O(rows) storage per tile and break the O(tiles) budget), and non-zero-only
   * binning already restricts the distribution to the active price band.
   */
  viewportPercentiles(
    col: ColRange,
    row: RowRange,
    mipLevel: number,
  ): { knee: number; white: number } {
    if (this.useWorker && this.sourceColumn && [...this.directTiles].some(t => t >= this.tileOf(col.oldest) && t <= this.tileOf(col.newest))) {
      return this.workerPercentiles(col, row, mipLevel);
    }
    const m = this.memoKey;
    if (
      m.version === this.versionN &&
      m.oldest === col.oldest &&
      m.newest === col.newest &&
      m.percentile === this.percentile &&
      m.whitePercentile === this.whitePercentile &&
      m.level === mipLevel
      && m.rowLo === row.lo && m.rowHi === row.hi
      && Object.is(m.priceLo, row.priceLo) && Object.is(m.priceHi, row.priceHi) && m.channel === this.channel
      && Object.is(m.referenceStep, row.referenceStep)
    ) {
      return { knee: this.memoRanks.knee, white: this.memoRanks.white };
    }
    const ranks = this.mergePercentiles(col, row, mipLevel);
    m.oldest = col.oldest;
    m.newest = col.newest;
    m.percentile = this.percentile;
    m.whitePercentile = this.whitePercentile;
    m.level = mipLevel;
    m.version = this.versionN;
    m.rowLo = row.lo; m.rowHi = row.hi; m.priceLo = row.priceLo as number; m.priceHi = row.priceHi as number; m.channel = this.channel;
    m.referenceStep = row.referenceStep as number;
    this.memoRanks = ranks;
    return { knee: ranks.knee, white: ranks.white };
  }

  private workerPercentiles(col: ColRange, row: RowRange, mipLevel: number): { knee: number; white: number } {
    const key = JSON.stringify([col, row, mipLevel, this.channel, this.percentile, this.whitePercentile]);
    if (key !== this.workerView) {
      this.worker?.dispose(); this.worker = null; this.workerGeneration++;
      this.workerView = key; this.workerVersion = -1; this.merged.fill(0); this.mergedTotal = 0;
      this.calculationState = 'idle';
    }
    if (this.calculationState !== 'failed' && !this.worker?.busy && this.workerVersion !== this.versionN) {
      this.worker ??= new ViewWorker(); this.calculationState = 'pending';
      const generation = this.workerGeneration, version = this.versionN, read = this.sourceColumn!;
      const oldest = col.oldest, newest = col.newest, admitted = this.admittedColumns, width = this.colsPerTile;
      const columns = function* () {
        for (let c = oldest; c <= newest; c++) {
          const source = admitted.get(Math.floor(c / width))?.has(c) ? read(c) : null;
          yield source ? { ...source, scale: source.scale ?? null } : null;
        }
      };
      void this.worker.run({ kind: 'histogram', rowLo: row.lo, rowHi: row.hi, priceLo: row.priceLo,
        priceHi: row.priceHi, referenceStep: row.referenceStep, channel: this.channel,
        bins: this.bins, histMin: Math.exp(this.logMin), histMax: Math.exp(this.logMax) }, columns()).then(value => {
        if (generation !== this.workerGeneration) return;
        this.merged.set(value.bins); this.mergedTotal = value.total; this.workerVersion = version;
        this.mergeCountN++; this.calculationState = 'ready'; this.onAsyncReady?.();
      }).catch(() => { if (generation === this.workerGeneration) { this.calculationState = 'failed'; this.onAsyncReady?.(); } });
    }
    const hold = Math.max(this.ema, this.floor);
    if (!this.mergedTotal) return { knee: hold, white: hold };
    return { knee: Math.max(this.floor, this.readRank(this.merged, this.mergedTotal, this.percentile)),
      white: Math.max(this.floor, this.readRank(this.merged, this.mergedTotal, this.whitePercentile)) };
  }

  /**
   * Read one percentile rank off the merged CDF with in-bin log interpolation.
   * Pure w.r.t. the histogram: the caller reuses ONE merged accumulator for
   * every rank it needs (two reads, one merge).
   */
  private readRank(merged: Int32Array, total: number, percentile: number): number {
    const rank = (percentile / 100) * total;
    let cum = 0;
    for (let b = 0; b < this.bins; b++) {
      const next = cum + merged[b];
      if (next >= rank) {
        // Fraction through this bin's count where the rank falls.
        const inBin = merged[b] > 0 ? (rank - cum) / merged[b] : 0;
        const logv = this.logMin + (b + inBin) / this.binScale;
        return Math.exp(logv);
      }
      cum = next;
    }
    return Math.exp(this.logMin + this.bins / this.binScale);
  }

  /** The unmemoized merge: sum covered tiles' histograms ONCE, read both ranks. */
  private mergePercentiles(col: ColRange, row: RowRange, mipLevel: number): { knee: number; white: number } {
    this.mergeCountN++;
    const merged = this.merged;
    merged.fill(0);
    let total = 0;
    const tLo = this.tileOf(col.oldest);
    const tHi = this.tileOf(col.newest);
    for (let t = tLo; t <= tHi; t++) {
      const hist = this.tiles.get(t);
      if (hist === undefined) continue;
      const partialTime = t * this.colsPerTile < col.oldest || (t + 1) * this.colsPerTile - 1 > col.newest;
      if (partialTime && (this.spatialTiles.has(t) || this.directTiles.has(t))) {
        total += this.mergeExact(t, row, merged, undefined, undefined, col);
        continue;
      }
      if (this.directTiles.has(t)) {
        total += this.mergeExact(t, row, merged);
        continue;
      }
      const spatial = this.spatialTiles.get(t);
      if (spatial) {
        for (const [key, part] of spatial) {
          const reference = part.scale.kind === 'hybrid' ? part.scale.coreStep : part.scale.step;
          const shift = row.referenceStep && reference > 0 ? Math.log(row.referenceStep / reference) * this.binScale : 0;
          const lo = row.priceLo !== undefined ? priceToRow(part.scale, row.priceLo) : row.lo;
          const hi = row.priceHi !== undefined ? priceToRow(part.scale, row.priceHi) : row.hi;
          const [first, last] = this.rowBounds(part.scale, row, lo, hi);
          const bandLo = Math.floor(first / ROW_BAND), bandHi = Math.floor(last / ROW_BAND);
          for (const [band, channels] of part.bands) {
            if (band < bandLo || band > bandHi) continue;
            if (band * ROW_BAND < first || (band + 1) * ROW_BAND - 1 > last) {
              total += this.mergeExact(t, row, merged, key, band);
              continue;
            }
            const selected = channels[Math.max(0, Math.min(2, this.channel))];
            for (let b = 0; b < this.bins; b++) {
              const index = Math.max(0, Math.min(this.bins - 1, Math.round(b + shift)));
              merged[index] += selected[b]; total += selected[b];
            }
          }
        }
        continue;
      }
      for (let b = 0; b < this.bins; b++) {
        const c = hist[b];
        if (c !== 0) {
          merged[b] += c;
          total += c;
        }
      }
    }
    this.mergedTotal = total;
    if (total === 0) {
      const hold = Math.max(this.ema, this.floor);
      return { knee: hold, white: hold };
    }
    const scale = normMipScale(mipLevel);
    return {
      knee: Math.max(this.readRank(merged, total, this.percentile), this.floor) * scale,
      white: Math.max(this.readRank(merged, total, this.whitePercentile), this.floor) * scale,
    };
  }

  /** Only boundary bands (at most 128 native rows per map) read resident
   * sources. Whole inner bands remain precomputed. A spatial-index budget
   * fallback reads those same exact quantities, never discards history. */
  private mergeExact(tile: number, row: RowRange, merged: Int32Array, key?: string, band?: number, visibleCols?: ColRange): number {
    let total = 0;
    const columns = key ? this.spatialTiles.get(tile)?.get(key)?.columns : this.admittedColumns.get(tile);
    for (const col of columns ?? []) {
      if (visibleCols && (col < visibleCols.oldest || col > visibleCols.newest)) continue;
      const source = this.sourceColumn?.(col) ?? null;
      const contribution = source ? null : this.replaceableColumns.get(col);
      const scale = source?.scale ?? contribution?.scale ?? null;
      if (key && (scale ? JSON.stringify(scale) : null) !== key) continue;
      if (!source && !contribution) continue;
      const lo = scale && row.priceLo !== undefined ? priceToRow(scale, row.priceLo) : row.lo;
      const hi = scale && row.priceHi !== undefined ? priceToRow(scale, row.priceHi) : row.hi;
      const bounds = this.rowBounds(scale, row, lo, hi);
      const first = Math.max(bounds[0], band === undefined ? 0 : band * ROW_BAND);
      const last = Math.min(bounds[1], band === undefined ? Infinity : (band + 1) * ROW_BAND - 1);
      const reference = scale?.kind === 'hybrid' ? scale.coreStep : scale?.step ?? 1;
      const shift = row.referenceStep && reference > 0 ? Math.log(row.referenceStep / reference) * this.binScale : 0;
      const add = (bin: number) => { merged[Math.max(0, Math.min(this.bins - 1, Math.round(bin + shift)))]++; total++; };
      if (source) {
        for (let r = first; r <= Math.min(last, source.bid.length - 1); r++) {
          let b = source.bid[r], a = source.ask?.[r] ?? 0;
          if (!(b > 0 || a > 0)) continue;
          if (scale) {
            const width = scale.kind === 'linear' ? scale.step : r - .5 >= scale.dnRows && r + .5 <= scale.dnRows + scale.coreRows ? scale.coreStep
              : rowToPrice(scale, r + .5) - rowToPrice(scale, r - .5);
            b = Math.fround(b * reference / Math.max(width, Number.MIN_VALUE)); a = Math.fround(a * reference / Math.max(width, Number.MIN_VALUE));
          }
          const value = this.channel === 1 ? b : this.channel === 2 ? a : b + a;
          if (value > 0) add(this.binOf(value));
        }
      } else if (contribution) {
        for (let i = 0; i < contribution.rows.length; i += 4) {
          const r = contribution.rows[i], bin = contribution.rows[i + 1 + Math.max(0, Math.min(2, this.channel))] - 1;
          if (r >= first && r <= last && bin >= 0) add(bin);
        }
      }
    }
    return total;
  }

  private rowBounds(scale: PriceScale | null, view: RowRange, lo: number, hi: number): [number, number] {
    const physical = scale !== null && view.priceLo !== undefined && view.priceHi !== undefined && view.priceHi > view.priceLo;
    const step = scale?.kind === 'hybrid' ? scale.coreStep : scale?.step ?? 1;
    const epsilon = physical ? Math.max(1e-10, Number.EPSILON * Math.max(Math.abs(view.priceLo!), Math.abs(view.priceHi!), 1) / step * 4) : 0;
    return [Math.max(0, physical ? Math.floor(lo + .5 + epsilon) : Math.ceil(lo - .5)),
      Math.min((scale?.rows ?? Infinity) - 1, physical ? Math.ceil(hi + .5 - epsilon) - 1 : Math.floor(hi + .5))];
  }

  /**
   * Recompute the raw viewport KNEE+WHITE pair (one memoized merge) and
   * EMA-step BOTH toward it, returning the smoothed, floored WHITE norm to feed
   * `u_norm` (lane F: `updateNorm` keeps returning the EMA of the white value).
   * The knee EMA rides the same alpha so {@link currentPercentiles} gives a
   * stable per-frame ratio for the shader's `u_knee`. Call once per dirty frame
   * (or on view-settle). O(tiles in view).
   */
  updateNorm(col: ColRange, row: RowRange, mipLevel: number): number {
    if (this.frozen) return Math.max(this.ema, this.floor);
    const raw = this.viewportPercentiles(col, row, mipLevel);
    this.lastRaw = raw.white;
    this.lastRawKnee = raw.knee;
    if (!this.seeded) {
      this.ema = raw.white;
      this.emaKnee = raw.knee;
      this.seeded = true;
    } else {
      this.ema += this.alpha * (raw.white - this.ema);
      this.emaKnee += this.alpha * (raw.knee - this.emaKnee);
    }
    return Math.max(this.ema, this.floor);
  }

  /**
   * Test-only (R2-M2): pin the norm so repeated grabs of a sealed frame cannot
   * drift through the EMA glide. Sets the EMA (and its raw target, so `settled`
   * reads true) to `value ?? current`, both floored, and makes {@link updateNorm}
   * return it without stepping until {@link reset}.
   */
  freezeForTest(value?: number): void {
    const v = Math.max(value ?? this.current, this.floor);
    this.ema = v;
    this.emaKnee = v;
    this.lastRaw = v;
    this.lastRawKnee = v;
    this.seeded = true;
    this.frozen = true;
  }

  /** Whether the EMA has essentially reached the last raw target (settle gate). */
  get settled(): boolean {
    const whiteDenom = Math.max(this.ema, this.floor, 1e-12);
    const kneeDenom = Math.max(this.emaKnee, this.floor, 1e-12);
    return Math.abs(this.lastRaw - this.ema) <= SETTLE_EPS * whiteDenom &&
      Math.abs(this.lastRawKnee - this.emaKnee) <= SETTLE_EPS * kneeDenom;
  }

  reset(): void {
    this.workerGeneration++; this.worker?.dispose(); this.worker = null;
    this.workerView = ''; this.workerVersion = -1; this.calculationState = 'idle';
    this.tiles.clear();
    this.spatialTiles.clear();
    this.directTiles.clear(); this.spatialBytes = 0;
    this.admittedColumns.clear();
    this.replaceableColumns.clear();
    this.foldedColumns.clear();
    this.merged.fill(0);
    this.mergedTotal = 0;
    this.ema = 0;
    this.emaKnee = 0;
    this.lastRaw = 0;
    this.lastRawKnee = 0;
    this.seeded = false;
    this.frozen = false;
    this.versionN++;
    this.memoKey.version = -1;
  }
  dispose(): void { this.reset(); }
}
