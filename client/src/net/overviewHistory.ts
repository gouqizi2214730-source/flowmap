import type { DepthColumn, HistoryOverviewRequest, HistoryResponse } from '../proto/types';
import type { HeatmapView } from '../gl/heatmap';
import { depthResolution, isDepthResolution } from './depthResolution';

/** A cache budget describes detail, never how far a user can see. */
export const OVERVIEW_CAPACITY = 512;
export const OVERVIEW_VISIBLE_BUCKETS = 480;
const UPLOAD_BUDGET_MS = 6;
const UPLOAD_BATCH_COLS = 8;

export interface OverviewPlan { stride: number; lo: number; hi: number }

export function overviewPlan(view: Pick<HeatmapView, 'colOffset' | 'colScale'>, newest: number): OverviewPlan | null {
  if (!Number.isFinite(view.colOffset) || !(view.colScale > 0) || !Number.isFinite(view.colScale) || newest < 0) return null;
  const stride = 2 ** Math.max(0, Math.ceil(Math.log2(view.colScale / OVERVIEW_VISIBLE_BUCKETS)));
  const lo = Math.max(0, Math.floor(view.colOffset / stride));
  const hi = Math.min(Math.floor(newest / stride), Math.ceil((view.colOffset + view.colScale) / stride) - 1);
  return hi >= lo ? { stride, lo, hi } : null;
}

export interface OverviewHistoryDeps {
  request: (before: bigint, count: number, overview: HistoryOverviewRequest) => Promise<HistoryResponse>;
  pageCols: () => number;
  before: () => bigint;
  reset: (stride: number) => void;
  column: (column: DepthColumn, stride: number) => void;
  page: (response: HistoryResponse, stride: number) => void;
  yieldToFrame: () => Promise<void>;
  changed: () => void;
  active: () => boolean;
  resident?: () => { oldest: number; newest: number } | null;
}

/**
 * Loads coarse, genuine recorded columns into an independent bounded cache.
 * Pages are addressed by absolute buckets, not a sliding screen origin. A view
 * hundreds of times larger than the full-resolution GPU ring still needs at
 * most 481 buckets. A stale page can never write into a new zoom/session.
 */
export class OverviewHistory {
  private plan: OverviewPlan | null = null;
  private generation = 0;
  private loaded = new Set<number>();
  private present = new Set<number>();
  private loading = false;
  private disposed = false;
  private retryAt = 0;
  private refreshAt = 0;
  error: string | null = null;
  requests = 0;
  oldestAvailableT0 = 0n;

  constructor(private readonly deps: OverviewHistoryDeps) {}
  get stride(): number { return this.plan?.stride ?? 1; }
  get inFlight(): boolean { return this.loading; }
  get range(): OverviewPlan | null { return this.plan; }
  get cachedBuckets(): number { return this.loaded.size; }
  get progress(): { loaded: number; total: number } {
    const p = this.plan;
    if (!p) return { loaded: 0, total: 0 };
    let loaded = 0;
    for (const col of this.loaded) if (col >= p.lo && col <= p.hi) loaded++;
    return { loaded, total: p.hi - p.lo + 1 };
  }
  get complete(): boolean { const p = this.progress; return p.total > 0 && p.loaded === p.total; }

  ensure(view: HeatmapView, newest: number, now = performance.now()): void {
    if (this.disposed || !this.deps.active()) return;
    const next = overviewPlan(view, newest);
    if (next === null) return;
    if (this.plan === null || next.stride !== this.plan.stride) {
      this.generation++;
      this.loaded.clear();
      this.present.clear();
      this.error = null;
      this.retryAt = 0;
      this.refreshAt = 0;
      this.deps.reset(next.stride);
    }
    this.plan = next;
    // Keep only a small adjacent reserve. Neither time coverage nor scale is
    // truncated when these buckets leave memory; they are fetched on demand.
    for (const bucket of this.loaded) if (bucket < next.lo - 15 || bucket > next.hi + 15) this.loaded.delete(bucket);
    if (now >= this.refreshAt && next.hi === Math.floor(newest / next.stride)) {
      this.loaded.delete(next.hi); // genuine forming bucket, at most once/sec
      this.refreshAt = now + 1000;
    }
    if (!this.loading && now >= this.retryAt) void this.pump();
  }

  private async pump(): Promise<void> {
    this.loading = true;
    const generation = this.generation;
    try {
      while (this.current(generation)) {
        const plan = this.plan!;
        let first = plan.lo;
        while (first <= plan.hi && this.loaded.has(first)) first++;
        if (first > plan.hi) break;
        const count = Math.max(1, Math.min(256, this.deps.pageCols(), plan.hi - first + 1));
        const last = first + count - 1;
        this.requests++;
        const request = {
          start_col: first * plan.stride,
          end_col: (last + 1) * plan.stride - 1,
          stride: plan.stride,
        };
        const before = this.deps.before();
        const initial = await this.deps.request(before, count, request);
        if (!this.current(generation)) return;
        const response = { ...initial, markers: [...initial.markers] };
        let metadata = initial;
        const cursors = new Set<string>();
        let metadataGeneration: string | undefined;
        for (;;) {
          const marker = metadata.markers.find(m => m.kind === 'history_metadata_page');
          if (!marker) {
            if (metadataGeneration !== undefined) throw new Error('flowmap: missing history metadata continuation');
            break; // compatible pre-pagination server
          }
          const page: { next_cursor: string | null; complete: boolean; generation: string; stale?: boolean } = JSON.parse(marker.text);
          if (!page || typeof page.complete !== 'boolean' || typeof page.generation !== 'string' ||
            !page.generation || (page.complete !== (page.next_cursor === null))) {
            throw new Error('flowmap: invalid history metadata continuation');
          }
          if (page.stale || (metadataGeneration !== undefined && page.generation !== metadataGeneration)) {
            throw new Error('flowmap: history metadata changed; retrying the page');
          }
          metadataGeneration = page.generation;
          if (page.complete && page.next_cursor === null) break;
          if (typeof page.next_cursor !== 'string' || cursors.has(page.next_cursor)) {
            throw new Error('flowmap: invalid history metadata continuation');
          }
          cursors.add(page.next_cursor);
          await this.deps.yieldToFrame();
          if (!this.current(generation)) return;
          this.requests++;
          metadata = await this.deps.request(before, count, { ...request, metadata_cursor: page.next_cursor });
          if (!this.current(generation)) return;
          response.markers.push(...metadata.markers);
        }
        this.oldestAvailableT0 = response.oldest_available_t_ns;
        const resolution = depthResolution(response.markers);
        const columns = response.depth_cols.slice().sort((a, b) => a.col_seq - b.col_seq);
        let start = performance.now();
        let batch = 0;
        for (const column of columns) {
          if (!this.current(generation)) return;
          const bucket = Math.floor(column.col_seq / plan.stride);
          // Never reinterpret an unrelated response or alias a foreign slot.
          if (bucket < first || bucket > last) continue;
          this.deps.column(resolution.has(column.col_seq) ? { ...column, coarse_ranges: resolution.get(column.col_seq) } : column, plan.stride);
          this.present.add(bucket);
          // Bound CPU work and queued GPU uploads independently, then paint.
          if (++batch >= UPLOAD_BATCH_COLS || performance.now() - start >= UPLOAD_BUDGET_MS) {
            await this.deps.yieldToFrame();
            start = performance.now(); batch = 0;
          }
        }
        if (!this.current(generation)) return;
        for (let bucket = first; bucket <= last; bucket++) this.loaded.add(bucket);
        this.deps.page({ ...response, markers: response.markers.filter(marker => !isDepthResolution(marker) && marker.kind !== 'history_metadata_page') }, plan.stride);
        const resident = this.deps.resident?.();
        if (resident) for (const bucket of this.present) {
          if (bucket < resident.oldest || bucket > resident.newest) {
            this.present.delete(bucket);
            this.loaded.delete(bucket);
          }
        }
        this.error = null;
        this.deps.changed();
      }
    } catch (error) {
      if (this.current(generation)) {
        this.error = error instanceof Error ? error.message : String(error);
        this.retryAt = performance.now() + 1000;
        this.deps.changed();
      }
    } finally {
      this.loading = false;
      this.deps.changed();
      // A zoom may have superseded this request while it was on the wire.
      if (generation !== this.generation && !this.disposed && this.deps.active()) void this.pump();
    }
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.plan !== null && this.deps.active();
  }

  dispose(): void { this.disposed = true; this.generation++; this.loaded.clear(); }
}
