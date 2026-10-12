import type { StreamMsg } from '../net/connection';
import { MsgType, SIDE_BUY, SIDE_SELL, SIDE_SRC_EXCHANGE, SIDE_SRC_INFERRED, type Trade } from '../proto/types';

const BIN_MS = 100;
const MAX_MS = 60_000;
const CAPACITY = MAX_MS / BIN_MS + 1;
interface Bin { time: number; buy: number; sell: number; unknown: number; notional: number; count: number; exchange: number; inferred: number }
export interface TradeFlowSummary {
  buy: number; sell: number; unknown: number; delta: number; notional: number;
  count: number; exchange: number; inferred: number; durationMs: number; coverageMs: number;
}
const empty = (durationMs: number): TradeFlowSummary => ({ buy: 0, sell: 0, unknown: 0, delta: 0,
  notional: 0, count: 0, exchange: 0, inferred: 0, durationMs, coverageMs: 0 });

/** Bounded event-time bins retain every received print, independently of the display tape. */
export class TradeFlowAccumulator {
  private readonly bins: (Bin | undefined)[] = new Array(CAPACITY);
  private latestMs = -1;
  private receivedAt = 0;
  private startedMs = -1;
  private firstReceivedAt = -1;

  reset(): void {
    this.bins.fill(undefined); this.latestMs = -1; this.startedMs = -1; this.receivedAt = 0; this.firstReceivedAt = -1;
  }

  ingest(msg: StreamMsg, receivedAt: number): void {
    if (msg.type === MsgType.TRADE) {
      this.trade(msg as Trade, receivedAt);
    } else if (msg.type === MsgType.BBO) {
      this.advance(Number(msg.ts_ns / 1_000_000n), receivedAt);
    } else if (msg.type === MsgType.BAR_COL) {
      this.advance(Number(msg.t0_ns / 1_000_000n), receivedAt);
    }
  }

  private advance(ms: number, receivedAt: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms < this.latestMs) return;
    if (this.startedMs < 0) this.startedMs = ms;
    if (this.firstReceivedAt < 0) this.firstReceivedAt = receivedAt;
    if (ms > this.latestMs) { this.latestMs = ms; this.receivedAt = receivedAt; }
  }

  private trade(t: Trade, receivedAt: number): void {
    if (!(t.price > 0) || !(t.size > 0) || !Number.isFinite(t.price * t.size)) return;
    const ms = Number(t.ts_ns / 1_000_000n);
    if (!Number.isFinite(ms) || ms < 0) return;
    this.advance(ms, receivedAt);
    if (ms <= this.latestMs - MAX_MS) return;
    const time = Math.floor(ms / BIN_MS);
    const slot = time % CAPACITY;
    let bin = this.bins[slot];
    if (!bin || bin.time !== time) {
      bin = { time, buy: 0, sell: 0, unknown: 0, notional: 0, count: 0, exchange: 0, inferred: 0 };
      this.bins[slot] = bin;
    }
    const classified = t.side_src === SIDE_SRC_EXCHANGE || t.side_src === SIDE_SRC_INFERRED;
    if (classified && t.side === SIDE_BUY) bin.buy += t.size;
    else if (classified && t.side === SIDE_SELL) bin.sell += t.size;
    else bin.unknown += t.size;
    if (classified && (t.side === SIDE_BUY || t.side === SIDE_SELL)) {
      if (t.side_src === SIDE_SRC_EXCHANGE) bin.exchange += 1; else bin.inferred += 1;
    }
    bin.notional += t.price * t.size; bin.count += 1;
  }

  summary(durationMs: number, now: number, replay = false): TradeFlowSummary {
    const duration = Math.min(MAX_MS, Math.max(BIN_MS, durationMs));
    const out = empty(duration);
    if (this.latestMs < 0) return out;
    const clock = this.latestMs + (replay ? 0 : Math.max(0, now - this.receivedAt));
    const hi = Math.floor(clock / BIN_MS), lo = hi - Math.ceil(duration / BIN_MS) + 1;
    out.coverageMs = Math.min(duration, Math.max(0, replay ? clock - this.startedMs : now - this.firstReceivedAt));
    for (const b of this.bins) {
      if (!b || b.time < lo || b.time > hi) continue;
      out.buy += b.buy; out.sell += b.sell; out.unknown += b.unknown;
      out.notional += b.notional; out.count += b.count; out.exchange += b.exchange; out.inferred += b.inferred;
    }
    out.delta = out.buy - out.sell;
    return out;
  }
}
