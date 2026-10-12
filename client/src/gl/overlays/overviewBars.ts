import type { BarColumn } from '../../proto/types';
import { Cvd } from './cvd';
import { PriceLine } from './priceLine';
import { VolBars } from './volbars';
import { Vwap } from './vwap';

/** Independent bar-derived overlays for one coarse history resolution.
 *
 * The producer aggregates original columns and supplies local group indexes
 * in bar.col_seq. Reusing the normal overlays preserves colors, alignment,
 * volume normalization and cumulative session semantics without allocating
 * additional GL batches or canvases. Coarse data never replaces raw history.
 */
export class OverviewBars {
  readonly price = new PriceLine();
  readonly vwap = new Vwap();
  // A coarse bar already aggregates exactly one overview group. Missing groups
  // stay empty; they must never extend the preceding group's volume interval.
  readonly volume = new VolBars({ inferSpans: false });
  readonly cvd = new Cvd();

  add(bar: BarColumn): void {
    if (!Number.isSafeInteger(bar.col_seq)) return;
    this.price.add(bar);
    this.vwap.add(bar);
    this.volume.add(bar);
    this.cvd.add(bar);
  }

  prune(oldest: number, newest: number, pad = 0): void {
    this.price.prune(oldest, newest, pad);
    this.vwap.prune(oldest, newest, pad);
    this.volume.prune(oldest, newest, pad);
    this.cvd.prune(oldest, newest, pad);
  }

  reset(): void {
    this.price.reset();
    this.vwap.reset();
    this.volume.reset();
    this.cvd.reset();
  }
}
