import { ColumnCache } from './columnCache';
import type { GLContext } from './context';
import { Heatmap, selectLevel, type HeatmapView } from './heatmap';
import { projectedRowsPerPixel } from './priceProjection';
import { MipChain } from './mips';
import { ViewportNormalizer, PHYSICAL_NORM_FLOOR } from './normalize';
import { TileRing } from './tileRing';
import { OverviewBars } from './overlays/overviewBars';
import type { TimeMap } from './overlays/coords';
import type { DepthColumn, HistoryResponse } from '../proto/types';
import { OVERVIEW_CAPACITY } from '../net/overviewHistory';
import { historyGap } from './historyGap';
import { densityForScale } from './columnGeometry';
import { rowToPrice, type PriceScale } from './priceScale';

/** A separate, fixed-size level of detail. It never evicts close-up history. */
export class OverviewSurface {
  readonly ring: TileRing;
  readonly cache = new ColumnCache({ capacity: OVERVIEW_CAPACITY });
  readonly normalizer = new ViewportNormalizer({ maxTiles: 3, floor: PHYSICAL_NORM_FLOOR,
    useWorker: true, onAsyncReady: () => this.onAsyncReady?.(), sourceColumn: col => {
    const arrays = this.cache.arrays(col);
    return arrays ? { ...arrays, scale: this.priceScaleAt(col) } : null;
  } });
  readonly heatmap: Heatmap;
  readonly bars = new OverviewBars();
  readonly mips: MipChain | null;
  private times = new Map<number, bigint>();
  private timeMemo: TimeMap | null = null;
  private originalTimeMemo: TimeMap | null = null;
  revision = 0;
  readonly columnArrays = (col: number) => this.cache.arrays(col);
  private pendingLo = Infinity;
  private pendingHi = -Infinity;
  private densityBid: Float32Array;
  private densityAsk: Float32Array;

  constructor(private readonly ctx: GLContext, rows: number, lut: WebGLTexture, readonly stride: number,
    private readonly nativeScale: PriceScale | null = null, private readonly nativeEpoch = 0,
    private readonly epochScale: ((epoch: number) => PriceScale | null) | null = null,
    private readonly onAsyncReady?: () => void) {
    this.densityBid = new Float32Array(rows);
    this.densityAsk = new Float32Array(rows);
    this.ring = new TileRing(ctx.gl, rows, OVERVIEW_CAPACITY / 256);
    this.heatmap = new Heatmap(ctx, this.ring, lut);
    this.heatmap.normalizer = this.normalizer;
    this.mips = ctx.caps.colorBufferFloat && rows % 4 === 0 ? new MipChain(ctx, 256, rows, 2) : null;
    this.heatmap.mips = this.mips;
  }

  column(column: DepthColumn): void {
    if (column.bid.length !== this.ring.rows) return;
    const group = Math.floor(column.col_seq / this.stride);
    const before = this.ring.residentRange();
    const gap = before ? group - before.newest - 1 : 0;
    const gapZeroed = gap > 0 && gap < this.ring.capacityCols;
    if (gapZeroed) {
      this.ring.zeroColumns(before!.newest + 1, group - 1);
      this.pendingLo = Math.min(this.pendingLo, before!.newest + 1);
    }
    this.ring.append(group, column.epoch, column.bid, column.ask, this.ring.rows, gapZeroed);
    const sourceScale = this.epochScale?.(column.epoch) ?? this.nativeScale;
    if (sourceScale) {
      this.ring.geometry.set(group, sourceScale, this.epochScale ? column.epoch : this.nativeEpoch);
      this.ring.geometry.setResolution(group, sourceScale, column.coarse_ranges);
    }
    this.cache.put(group, column.bid, column.ask, column.t0_ns, column.epoch, sourceScale ? {
      p0: sourceScale.kind === 'hybrid' ? sourceScale.coreP0 : sourceScale.p0,
      step: sourceScale.kind === 'hybrid' ? sourceScale.coreStep : sourceScale.step,
      scale: Object.freeze({ ...sourceScale }),
    } : null);
    if (sourceScale?.kind === 'hybrid') this.normalizer.replaceColumn(group,
      densityForScale(sourceScale, column.bid, this.densityBid), column.ask ? densityForScale(sourceScale, column.ask, this.densityAsk) : null, sourceScale);
    else this.normalizer.replaceColumn(group, column.bid, column.ask, sourceScale);
    this.times.set(group, column.t0_ns);
    this.timeMemo = null;
    this.originalTimeMemo = null;
    this.pendingLo = Math.min(this.pendingLo, group);
    this.pendingHi = Math.max(this.pendingHi, group);
    const range = this.ring.residentRange();
    if (range) {
      this.bars.prune(range.oldest, range.newest);
      for (const group of this.times.keys()) if (group < range.oldest || group >= range.newest + 1) this.times.delete(group);
    }
  }

  page(response: HistoryResponse): void {
    for (const bar of response.bar_cols) this.bars.add({ ...bar, col_seq: Math.floor(bar.col_seq / this.stride) });
    const range = this.ring.residentRange();
    for (const marker of response.markers) {
      const gap = historyGap(marker);
      if (!gap || !range) continue;
      for (const [col, time] of [[gap.leftCol / this.stride, gap.leftStart], [gap.rightCol / this.stride, gap.rightStart]] as const) {
        if (col >= range.oldest && col < range.newest + 1) this.times.set(col, time);
      }
    }
    this.timeMemo = null; this.originalTimeMemo = null;
    this.revision++;
    this.flushMips();
  }

  view(source: HeatmapView): HeatmapView {
    return { ...source, colOffset: source.colOffset / this.stride, colScale: source.colScale / this.stride };
  }

  private flushMips(): void {
    if (this.pendingHi < this.pendingLo) return;
    this.mips?.updateRange(this.ring, this.pendingLo, this.pendingHi);
    this.pendingLo = Infinity; this.pendingHi = -Infinity;
  }

  timeMap(dtNs: number): TimeMap | null {
    if (this.timeMemo) return this.timeMemo;
    const range = this.ring.residentRange();
    if (!range) return null;
    // Only real timestamp knots are exposed; never populate an unseen gap
    // with today's book or fabricate a dense sequence across another run.
    const knots = [...this.times.entries()].filter(([col]) => col >= Math.max(range.oldest, this.ring.validFromSeq()) && col < range.newest + 1).sort((a, b) => a[0] - b[0]);
    if (!knots.length) return null;
    const [end, time] = knots[knots.length - 1];
    this.timeMemo = { anchorSeq: end, anchorT0Ns: time, dtNs: dtNs * this.stride,
      slots: { startSeq: knots[0][0], cols: Float64Array.from(knots, k => k[0]), t0: Float64Array.from(knots, k => Number(k[1])) } };
    return this.timeMemo;
  }

  originalTimeMap(dtNs: number): TimeMap | null {
    if (this.originalTimeMemo) return this.originalTimeMemo;
    const local = this.timeMap(dtNs);
    this.originalTimeMemo = local ? { ...local, anchorSeq: local.anchorSeq * this.stride, dtNs,
      slots: local.slots ? { ...local.slots, startSeq: local.slots.startSeq * this.stride, stride: this.stride,
        cols: local.slots.cols?.map(col => col * this.stride) } : undefined } : null;
    return this.originalTimeMemo;
  }

  level(view: HeatmapView): number {
    return selectLevel(projectedRowsPerPixel(view, this.heatmap.priceScale, this.ctx.gl.drawingBufferHeight),
      this.mips?.usable ? this.mips.maxLevel : 0, view.colScale / Math.max(1, this.ctx.gl.drawingBufferWidth), this.heatmap.levelFloor).level;
  }
  priceScaleAt(col: number): PriceScale | null {
    const cached = this.cache.priceAt(col)?.scale;
    if (cached) return cached;
    const epoch = this.cache.epochAt(col);
    return epoch === null ? this.nativeScale : this.epochScale?.(epoch) ?? this.nativeScale;
  }

  draw(source: HeatmapView, template: Heatmap): void {
    const view = this.view(source);
    const heatmap = this.heatmap;
    heatmap.priceScale = template.priceScale;
    heatmap.gamma = template.gamma;
    heatmap.floor = template.floor;
    heatmap.toleranceValue = template.toleranceValue;
    heatmap.channel = template.channel;
    heatmap.levelFloor = template.levelFloor;
    heatmap.encoding.decodeScale = template.encoding.decodeScale;
    heatmap.encoding.ramp = template.encoding.ramp;
    if (template.normalizer) {
      this.normalizer.percentile = template.normalizer.percentile;
      this.normalizer.whitePercentile = template.normalizer.whitePercentile;
    }
    this.flushMips();
    const range = this.ring.residentRange();
    if (range && this.normalizer.hasData()) {
      this.normalizer.channel = heatmap.channel === 3 ? 0 : heatmap.channel;
      heatmap.encoding.norm = this.normalizer.updateNorm({ oldest: Math.max(range.oldest, Math.floor(view.colOffset)),
        newest: Math.min(range.newest, Math.ceil(view.colOffset + view.colScale)) },
      { lo: Math.max(0, Math.floor(view.rowOffset)), hi: Math.min(this.ring.rows - 1, Math.ceil(view.rowOffset + view.rowScale)),
        priceLo: heatmap.priceScale ? rowToPrice(heatmap.priceScale, view.rowOffset - (heatmap.priceScale.kind === 'linear' ? .5 : 0)) : undefined,
        priceHi: heatmap.priceScale ? rowToPrice(heatmap.priceScale, view.rowOffset + view.rowScale - (heatmap.priceScale.kind === 'linear' ? .5 : 0)) : undefined,
        referenceStep: heatmap.priceScale?.kind === 'hybrid' ? heatmap.priceScale.coreStep : heatmap.priceScale?.step }, this.level(view));
    }
    heatmap.draw(view);
  }

  dispose(): void { this.normalizer.dispose(); this.mips?.dispose(); this.heatmap.dispose(); this.ring.dispose(); }
}
