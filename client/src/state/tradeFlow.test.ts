import { expect, it } from 'vitest';
import { MsgType, SIDE_BUY, SIDE_SELL, SIDE_UNKNOWN, SIDE_SRC_EXCHANGE, SIDE_SRC_INFERRED, SIDE_SRC_NA, type Trade } from '../proto/types';
import { TradeFlowAccumulator } from './tradeFlow';
const print = (ms: number, size = 1, side = SIDE_BUY, src = SIDE_SRC_EXCHANGE): Trade => ({
  type: MsgType.TRADE, ts_ns: BigInt(ms) * 1_000_000n, price: 100, size, side, side_src: src, venue: 'test',
});
it('counts more prints than the display tape retains and preserves real duplicate prints', () => {
  const flow = new TradeFlowAccumulator();
  for (let i = 0; i < 10_000; i++) flow.ingest(print(1000, 0.25), 1000);
  expect(flow.summary(5000, 1000)).toMatchObject({ count: 10_000, buy: 2500, delta: 2500, notional: 250000 });
});
it('keeps unknown sides out of delta and reports inferred classifications separately', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000, 3), 1000);
  flow.ingest(print(1100, 2, SIDE_SELL, SIDE_SRC_INFERRED), 1100);
  flow.ingest(print(1200, 4, SIDE_UNKNOWN, SIDE_SRC_NA), 1200);
  flow.ingest(print(1300, 5, SIDE_BUY, SIDE_SRC_NA), 1300);
  expect(flow.summary(5000, 1300)).toMatchObject({ buy: 3, sell: 2, unknown: 9, delta: 1, exchange: 1, inferred: 1 });
});
it('ages quiet live flow, freezes replay time and accepts in-window out-of-order prints', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000), 1000); flow.ingest(print(3000), 3000); flow.ingest(print(2000, 2), 3500);
  expect(flow.summary(5000, 3500).count).toBe(3);
  expect(flow.summary(5000, 9000).count).toBe(0);
  expect(flow.summary(5000, 9000, true).count).toBe(3);
});
it('reuses bounded bins without leaking an overwritten minute into the next', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000, 100), 0); flow.ingest(print(121000, 2), 100);
  flow.ingest(print(1000, 99), 100);
  expect(flow.summary(60000, 100)).toMatchObject({ buy: 2, count: 1 });
});
it('resets instrument/session data and rejects invalid quantities and overflow', () => {
  const flow = new TradeFlowAccumulator(); flow.ingest(print(1000), 1000);
  flow.reset(); flow.ingest(print(2000, -3), 2000); flow.ingest(print(2000, Infinity), 2000);
  expect(flow.summary(60000, 2000).count).toBe(0);
});
