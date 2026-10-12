/**
 * Volume (liquidity) profile overlay (§2 G2, §8.3, M2 T10). Toggleable; OFF by
 * default (§9 settings drawer).
 *
 * A volume-by-price histogram drawn as horizontal bars on the RIGHT side,
 * accumulated over the VISIBLE column window from the exact per-column density
 * (bid+ask resting size) in the CPU column cache — the same exact values the
 * crosshair reads, never GPU/mip texels. The point-of-control (POC, the max row)
 * is highlighted and labeled. Because it sums only the visible columns × visible
 * rows, cost is O(visible), never O(history).
 *
 * This is a resting-liquidity-by-price profile (from the L2 density grid), which
 * §7 allows as the profile source ("from BarColumn vol OR from column density");
 * it is the exact, row-aligned choice and reads honestly as book volume-at-price.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import { visibleColRange } from './coords';
import { quoteDecimals } from './axisTicks';
import { priceToRow, rowToPrice, type PriceScale } from '../priceScale';
import { ViewWorker } from '../viewWorker';

function sameGeometry(a: PriceScale, b: PriceScale): boolean {
  if (a.kind !== b.kind || a.rows !== b.rows) return false;
  if (a.kind === 'linear' && b.kind === 'linear') return a.p0 === b.p0 && a.step === b.step;
  if (a.kind === 'hybrid' && b.kind === 'hybrid') return a.dnRows === b.dnRows && a.coreRows === b.coreRows &&
    a.coreP0 === b.coreP0 && a.coreStep === b.coreStep && a.loPrice === b.loPrice && a.hiPrice === b.hiPrice;
  return false;
}

export interface ProfileResult {
  /** Summed density per row over `[rowLo, rowHi]` (index 0 = rowLo). */
  bins: Float64Array;
  rowLo: number;
  /** Max bin value (the POC height). */
  max: number;
  /** Absolute row of the POC (max), or -1 when empty. */
  pocRow: number;
  /**
   * True when columns/rows were sampled or source geometry was redistributed;
   * the POC must then disclose its approximate resolution. `rowStride > 1` is a
   * one-sample-per-mip-block SUBSAMPLE of the visible volume rather than the
   * exact per-row sums. The POC readout must be marked approximate in that
   * case (the block-sum winner can differ from the sampled winner — see the
   * `accumulateProfile` doc). `stride === 1` is always exact and `sampled`
   * is false.
   */
  sampled: boolean;
}

/**
 * Sum exact column density into per-row bins over a column × row window. Pure —
 * `getArrays(col)` returns the column's `{bid, ask}` (or null for uncached).
 *
 * `out`, when supplied, receives the bins (zeroed first) instead of allocating a
 * fresh Float64Array per call — the per-frame profile pass reuses one scratch
 * buffer across dirty frames. It is RETURNED, so `Profile.last.bins` aliases the
 * live scratch by design: consumers read the result synchronously after the
 * draw that produced it (see {@link Profile.debug} consumers).
 *
 * `rowWidth`, when supplied, gives each row's PRICE width and switches the bins
 * to density-per-unit-price. That is not cosmetic: this is a histogram, and on a
 * non-uniform price grid the bins have unequal widths — a log-wing row can cover
 * hundreds of times the price range of a core row, so on raw sums the wings win
 * the point-of-control contest on bucket width alone. The POC is rendered as
 * both a highlight and a printed price, so that would be a confidently wrong
 * quantitative claim. Omit it (the linear grid) and the raw sums are kept
 * bit-for-bit, so uniform-grid bar lengths and the POC row are unchanged.
 *
 * `rowStride` (survey #4, the row bound), when > 1, scans only every `stride`-th
 * row — aligned to absolute grid rows (the first multiple of `stride` at or
 * above `rowLo`). Callers pass the ACTIVE MIP BLOCK (4^level): at that level the
 * heatmap already sums each block into one displayed cell, so the sub-block
 * resolution is below what the display can show. The scanned work is then
 * bounded by the mip level's own footprint (level 0 can only be selected while
 * fewer than ~4 rows per device pixel are on screen), collapsing the old
 * O(cols × grid-rows) pass to O(cols × 4 × viewport-pixels). `rowStride = 1`
 * (the default) reproduces the legacy full scan bit-for-bit.
 *
 * **Honesty contract for stride > 1 (R1-M1).** The bins are a SUBSAMPLE, not
 * block sums: each sampled row contributes only its own density, while the
 * heatmap cell behind it is the SUM of its 4^L-row block. Consequently the
 * sampled `pocRow`/`max` can disagree with the true block-sum POC (e.g. four
 * quiet rows summing above one sampled loud row). The result therefore carries
 * `sampled: true` and the overlay labels the POC readout "≈POC"; a precise POC
 * claim is only made in the exact `stride === 1` pass. Bars keep the sampled
 * relative shape (they are never presented as exact totals).
 */
export function accumulateProfile(
  colLo: number,
  colHi: number,
  rowLo: number,
  rowHi: number,
  getArrays: (col: number) => { bid: Float32Array; ask: Float32Array | null } | null,
  rowWidth?: (row: number) => number,
  out?: Float64Array,
  rowStride = 1,
  projection?: { target: PriceScale; source: (col: number) => PriceScale | null },
): ProfileResult {
  const nRows = Math.max(0, rowHi - rowLo + 1);
  const bins = out !== undefined && out.length >= nRows ? out.fill(0, 0, nRows) : new Float64Array(nRows);
  const stride = Math.max(1, Math.floor(rowStride));
  let reprojected = false;
  for (let c = colLo; c <= colHi; c++) {
    const a = getArrays(c);
    if (a === null) continue;
    const { bid, ask } = a;
    if (projection) {
      const source = projection.source(c);
      if (source === null) continue; // Unknown geometry cannot be assigned a price.
      const target = projection.target;
      if (!sameGeometry(source, target)) {
        reprojected = true;
        // Native depth is binned at the nearest row in every epoch.
        const sourceShift = 0.5;
        const targetShift = 0.5;
        const priceLo = rowToPrice(target, rowLo - targetShift);
        const priceHi = rowToPrice(target, rowHi + 1 - targetShift);
        const sourceLo = Math.max(0, Math.floor(priceToRow(source, priceLo) + sourceShift));
        const sourceHi = Math.min(bid.length - 1, Math.floor(priceToRow(source, priceHi) + sourceShift));
        for (let r = sourceLo; r <= sourceHi; r++) {
          const quantity = bid[r] + (ask !== null ? ask[r] : 0);
          if (!(quantity > 0)) continue;
          const low = rowToPrice(source, r - sourceShift);
          const high = rowToPrice(source, r + 1 - sourceShift);
          const width = high - low;
          if (!(width > 0) || !Number.isFinite(width)) continue;
          const first = Math.max(rowLo, Math.floor(priceToRow(target, low) + targetShift));
          const last = Math.min(rowHi, Math.floor(priceToRow(target, high) + targetShift));
          for (let t = first; t <= last; t++) {
            const overlap = Math.min(high, rowToPrice(target, t + 1 - targetShift)) - Math.max(low, rowToPrice(target, t - targetShift));
            if (overlap > 0) bins[t - rowLo] += quantity * overlap / width;
          }
        }
        continue;
      }
    }
    const hi = Math.min(rowHi, bid.length - 1);
    const lo = Math.max(rowLo, 0);
    // Absolute-row alignment: absolute rows that are multiples of `stride` are
    // exactly the mip block starts (block L covers [k·4^L, (k+1)·4^L)).
    const first = lo + ((stride - (lo % stride)) % stride);
    for (let r = first; r <= hi; r += stride) {
      bins[r - rowLo] += bid[r] + (ask !== null ? ask[r] : 0);
    }
  }
  if (rowWidth !== undefined) {
    for (let i = 0; i < nRows; i++) {
      const w = rowWidth(rowLo + i);
      bins[i] = w > 0 && Number.isFinite(w) ? bins[i] / w : 0;
    }
  }
  let max = 0;
  let pocRow = -1;
  for (let i = 0; i < nRows; i++) {
    if (bins[i] > max) {
      max = bins[i];
      pocRow = rowLo + i;
    }
  }
  // A view of EXACTLY nRows entries: a reused scratch may be longer than this
  // frame's window (the previous frame was taller), and callers iterate
  // `bins.length` when drawing.
  return { bins: bins.subarray(0, nRows), rowLo, max, pocRow, sampled: stride > 1 || reprojected };
}

export interface ProfileOptions {
  /** Max bar length as a fraction of viewport width (default 0.22). */
  widthFrac?: number;
  /** Column threshold for moving the full calculation off the render thread. */
  maxCols?: number;
}

const DEFAULTS: Required<ProfileOptions> = { widthFrac: 0.22, maxCols: 1024 };

export class Profile {
  private opts: Required<ProfileOptions>;
  /** Last computed result (for tests / readouts). Its `bins` is the live
   *  scratch when the draw supplied one — read synchronously after a draw. */
  last: ProfileResult | null = null;
  /** Per-frame bin accumulator, reused across dirty frames (no per-frame alloc). */
  private scratch: Float64Array = new Float64Array(0);
  private worker: ViewWorker | null = null;
  private viewKey = '';
  private completedVersion = -1;
  private workerResult: ProfileResult | null = null;
  private generation = 0;
  calculationState: 'idle' | 'pending' | 'ready' | 'failed' = 'idle';

  constructor(opts: ProfileOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  draw(frame: OverlayFrame): void {
    const { gm, solid, text } = frame;
    if (gm.price === null) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;
    // Bound the column sweep (wide zoom-out) so the sum stays O(visible).
    const colLo = range.lo;
    const colHi = range.hi;
    // Visible absolute row band from the view, clamped to the GRID on both ends.
    // The price camera can overscroll a full viewport past either edge (see
    // gl/camera.ts rowCenterBounds), and rows outside [0, rows) hold nothing —
    // without the upper clamp the per-frame `new Float64Array(rowHi-rowLo+1)`
    // would be sized by how far the user has scrolled into empty background
    // rather than by what is actually on the grid.
    const scale = gm.price?.scale;
    const gridRows = scale?.rows ?? frame.columnArrays(colHi)?.bid.length ?? 0;
    if (gridRows <= 0) return;
    const centered = scale?.kind === 'hybrid';
    const shift = centered ? 0.5 : 0;
    const rowLo = Math.max(0, Math.floor(gm.view.rowOffset + shift));
    const rowHi = Math.min(gridRows - 1, Math.floor(gm.view.rowOffset + gm.view.rowScale + shift));
    if (rowHi < rowLo) return;

    // Unequal-width bins on a non-uniform grid must be normalized by price
    // width, or the wings win the POC on bucket width alone. Uniform grids pass
    // no width function and keep the raw sums exactly. The scratch buffer makes
    // the per-frame pass allocation-free (rows can only grow so much; the
    // helper regrows internally if the view gets taller).
    //
    // Every native row contributes. Frame-wide mip skipping loses wing buckets
    // whose physical price interval is still plainly visible on screen.
    let result: ProfileResult;
    if (scale && colHi - colLo + 1 > this.opts.maxCols) {
      const key = JSON.stringify([colLo, colHi, rowLo, rowHi, scale]);
      if (key !== this.viewKey) {
        this.worker?.dispose(); this.worker = null; this.generation++;
        this.viewKey = key; this.workerResult = null; this.completedVersion = -1;
        this.calculationState = 'idle';
      }
      const version = frame.dataVersion ?? 0;
      if (this.calculationState !== 'failed' && !this.worker?.busy && this.completedVersion !== version) {
        this.worker ??= new ViewWorker();
        this.calculationState = 'pending';
        const generation = this.generation;
        const read = frame.columnArrays, nativeScale = frame.columnScale, changed = frame.changed;
        const columns = function* () {
          for (let c = colLo; c <= colHi; c++) {
            const arrays = read(c);
            yield arrays ? { ...arrays, scale: nativeScale?.(c) ?? scale } : null;
          }
        };
        void this.worker.run({ kind: 'profile', rowLo, rowHi, target: scale, normalizeWidths: scale.kind !== 'linear' }, columns()).then(value => {
          if (generation !== this.generation) return;
          const bins = value.bins as Float64Array;
          let max = 0, pocRow = -1;
          for (let i = 0; i < bins.length; i++) if (bins[i] > max) { max = bins[i]; pocRow = rowLo + i; }
          this.workerResult = { bins, rowLo, max, pocRow, sampled: value.sampled || value.missing > 0 };
          this.completedVersion = version; this.calculationState = 'ready'; changed?.();
        }).catch(() => { if (generation === this.generation) { this.calculationState = 'failed'; changed?.(); } });
      }
      if (!this.workerResult) {
        this.last = null;
        text.badge(gm.dims.cssW - 3, 18, this.calculationState === 'failed' ? 'Profil hesaplanamadı' : 'Profil hesaplanıyor…', { align: 'right', color: OVERLAY.profile.css, size: 10 });
        return;
      }
      result = { ...this.workerResult, sampled: this.workerResult.sampled || this.completedVersion !== version };
    } else {
      result = accumulateProfile(
      colLo,
      colHi,
      rowLo,
      rowHi,
      frame.columnArrays,
      scale !== undefined && scale.kind !== 'linear' ? (row) => gm.stepAtRow(row) : undefined,
      this.scratch,
      1,
      scale && frame.columnScale ? { target: scale, source: frame.columnScale } : undefined,
    );
    }
    this.scratch = result.bins;
    this.last = result;
    if (result.max <= 0) return;

    const cssW = gm.dims.cssW;
    const maxLenClip = gm.pxToClipW(Math.max(24, cssW * this.opts.widthFrac));
    const rightEdge = 1; // clip right

    solid.begin();
    for (let i = 0; i < result.bins.length; i++) {
      const v = result.bins[i];
      if (v <= 0) continue;
      const row = result.rowLo + i;
      const y0 = gm.clipY(row - shift);
      const y1 = gm.clipY(row + 1 - shift);
      const len = (v / result.max) * maxLenClip;
      const isPoc = row === result.pocRow;
      const color = isPoc ? OVERLAY.poc.gl : OVERLAY.profile.gl;
      solid.addRect(rightEdge - len, y0, rightEdge, y1, color);
    }
    solid.flush();

    // Physical redistribution from another epoch is approximate inside its
    // native buckets; disclose that precision with the "≈POC" label.
    if (result.pocRow >= 0) {
      const center = result.pocRow + 0.5 - shift;
      const price = gm.rowToPrice(result.pocRow);
      // The bucket can be much wider than the venue's actual quote increment.
      const decimals = quoteDecimals(gm.price.tick ?? gm.price.step);
      const y = gm.cssY(center);
      const prefix = result.sampled ? '≈POC' : 'POC';
      text.badge(cssW - 3, y, `${prefix} ${price.toFixed(decimals)}`, {
        align: 'right',
        color: OVERLAY.poc.css,
        size: 10,
      });
    }
  }

  setOptions(opts: Partial<ProfileOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }
  reset(): void {
    this.generation++;
    this.worker?.dispose();
    this.worker = null;
    this.workerResult = null;
    this.last = null;
    this.viewKey = '';
    this.completedVersion = -1;
    this.calculationState = 'idle';
    this.scratch = new Float64Array(0);
  }

  dispose(): void { this.reset(); }
}
