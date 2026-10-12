import { priceToRow, rowToPrice, type PriceScale } from './priceScale';

export interface ViewColumn { bid: Float32Array; ask: Float32Array | null; scale: PriceScale | null }
export type ViewTask = {
  kind: 'profile'; rowLo: number; rowHi: number; target: PriceScale; normalizeWidths: boolean;
} | {
  kind: 'histogram'; rowLo: number; rowHi: number; priceLo?: number; priceHi?: number;
  referenceStep?: number; channel: number; bins: number; histMin: number; histMax: number;
};
export interface ViewResult { bins: Int32Array | Float64Array; total: number; columns: number; missing: number; sampled: boolean }

/** Pure incremental worker state: all source columns are consumed, one at a
 * time. Native source geometry is projected once; no mip or histogram output
 * is used as authoritative input. */
export class ViewWorkerEngine {
  private readonly bins: Int32Array | Float64Array;
  private total = 0;
  private columns = 0;
  private missing = 0;
  private sampled = false;
  constructor(private task: ViewTask) {
    this.bins = task.kind === 'histogram' ? new Int32Array(task.bins)
      : new Float64Array(Math.max(0, task.rowHi - task.rowLo + 1));
  }
  add(column: ViewColumn | null): void {
    if (!column || !column.scale) { this.missing++; return; }
    this.columns++;
    const { bid, ask, scale } = column, task = this.task;
    if (task.kind === 'histogram') {
      const physical = task.priceLo !== undefined && task.priceHi !== undefined && task.priceHi > task.priceLo;
      const reference = scale.kind === 'hybrid' ? scale.coreStep : scale.step;
      const epsilon = physical ? Math.max(1e-10, Number.EPSILON * Math.max(Math.abs(task.priceLo!), Math.abs(task.priceHi!), 1) / reference * 4) : 0;
      const lo = physical ? Math.floor(priceToRow(scale, task.priceLo!) + .5 + epsilon) : Math.ceil(task.rowLo - .5);
      const hi = physical ? Math.ceil(priceToRow(scale, task.priceHi!) + .5 - epsilon) - 1 : Math.floor(task.rowHi + .5);
      const logMin = Math.log(task.histMin), binScale = task.bins / (Math.log(task.histMax) - logMin);
      const shift = task.referenceStep ? Math.log(task.referenceStep / reference) * binScale : 0;
      for (let row = Math.max(0, lo); row <= Math.min(bid.length - 1, hi); row++) {
        const width = rowToPrice(scale, row + .5) - rowToPrice(scale, row - .5);
        const b = Math.fround(bid[row] * reference / Math.max(width, Number.MIN_VALUE));
        const a = Math.fround((ask?.[row] ?? 0) * reference / Math.max(width, Number.MIN_VALUE));
        const value = task.channel === 1 ? b : task.channel === 2 ? a : b + a;
        if (!(value > 0) || !Number.isFinite(value)) continue;
        const nativeBin = Math.max(0, Math.min(task.bins - 1, Math.floor((Math.log(value) - logMin) * binScale)));
        const bin = Math.max(0, Math.min(task.bins - 1, Math.round(nativeBin + shift)));
        this.bins[bin]++; this.total++;
      }
      return;
    }
    const target = task.target;
    const same = JSON.stringify(scale) === JSON.stringify(target);
    this.sampled ||= !same;
    if (same) {
      for (let row = Math.max(0, task.rowLo); row <= Math.min(task.rowHi, bid.length - 1); row++) {
        this.bins[row - task.rowLo] += bid[row] + (ask?.[row] ?? 0);
      }
      return;
    }
    const visibleLo = rowToPrice(target, task.rowLo - .5), visibleHi = rowToPrice(target, task.rowHi + .5);
    const lo = Math.max(0, Math.floor(priceToRow(scale, visibleLo) + .5));
    const hi = Math.min(bid.length - 1, Math.floor(priceToRow(scale, visibleHi) + .5));
    for (let row = lo; row <= hi; row++) {
      const quantity = bid[row] + (ask?.[row] ?? 0);
      if (!(quantity > 0)) continue;
      const low = rowToPrice(scale, row - .5), high = rowToPrice(scale, row + .5);
      const width = high - low;
      if (!(width > 0)) continue;
      const first = Math.max(task.rowLo, Math.floor(priceToRow(target, low) + .5));
      const last = Math.min(task.rowHi, Math.floor(priceToRow(target, high) + .5));
      for (let t = first; t <= last; t++) {
        const overlap = Math.min(high, rowToPrice(target, t + .5)) - Math.max(low, rowToPrice(target, t - .5));
        if (overlap > 0) this.bins[t - task.rowLo] += quantity * overlap / width;
      }
    }
  }
  finish(): ViewResult {
    const bins = this.bins.slice();
    if (this.task.kind === 'profile' && this.task.normalizeWidths) {
      for (let i = 0; i < bins.length; i++) {
        const row = this.task.rowLo + i, scale = this.task.target;
        const width = rowToPrice(scale, row + .5) - rowToPrice(scale, row - .5);
        bins[i] = width > 0 ? bins[i] / width : 0;
      }
    }
    return { bins, total: this.total, columns: this.columns, missing: this.missing, sampled: this.sampled || this.missing > 0 };
  }
}
