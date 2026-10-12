import { expect, it, vi } from 'vitest';
import { OverviewHistory } from './overviewHistory';
import { MODE_L2, MsgType, type HistoryOverviewRequest, type HistoryResponse } from '../proto/types';

it('consumes metadata continuation before declaring the history page complete', async () => {
  const requests: HistoryOverviewRequest[] = [], markers: string[] = [];
  const page = (next: string | null): HistoryResponse => ({ type: MsgType.HISTORY_RESP,
    req_id: 1, epoch: 1, oldest_available_t_ns: 1n,
    depth_cols: next ? [{ type: MsgType.DEPTH_COL, epoch: 1, col_seq: 0, t0_ns: 1n,
      mode: MODE_L2, final: true, bid: new Float32Array([1]), ask: null }] : [],
    bar_cols: [], big_trades: [], markers: [
      { type: MsgType.MARKER, ts_ns: 1n, kind: 'gap', text: next ? 'gap1' : 'gap1025', price: null, size: null },
      { type: MsgType.MARKER, ts_ns: 1n, kind: 'history_metadata_page',
        text: JSON.stringify({ next_cursor: next, complete: next === null, generation: 'g1' }), price: null, size: null },
    ],
  });
  const loader = new OverviewHistory({
    request: async (_before, _count, request) => { requests.push(request); return page(request.metadata_cursor ? null : 'page2'); },
    pageCols: () => 1, before: () => 2n, reset: () => {}, column: () => {},
    page: response => markers.push(...response.markers.map(m => m.text)),
    yieldToFrame: async () => {}, changed: () => {}, active: () => true,
  });
  loader.ensure({ colOffset: 0, colScale: 800, rowOffset: 0, rowScale: 1 }, 0, 0);
  await vi.waitFor(() => expect(loader.inFlight).toBe(false));
  expect(requests).toHaveLength(2);
  expect(requests[1].metadata_cursor).toBe('page2');
  expect(markers).toContain('gap1025');
  expect(loader.complete).toBe(true);
});

it.each(['missing-page-marker', 'contradictory-complete-flag'])('rejects %s without declaring complete coverage', async fault => {
  let calls = 0;
  const loader = new OverviewHistory({
    request: async () => {
      calls++;
      const marker = { type: MsgType.MARKER as const, ts_ns: 1n,
        kind: 'history_metadata_page' as const, price: null, size: null,
        text: JSON.stringify({ next_cursor: 'page2', complete: fault === 'contradictory-complete-flag', generation: 'g1' }) };
      return { type: MsgType.HISTORY_RESP, req_id: 1, epoch: 1, oldest_available_t_ns: 1n,
        depth_cols: [], bar_cols: [], big_trades: [], markers: calls === 1 ? [marker] : [] };
    },
    pageCols: () => 1, before: () => 2n, reset: () => {}, column: () => {},
    page: () => {}, yieldToFrame: async () => {}, changed: () => {}, active: () => true,
  });
  loader.ensure({ colOffset: 0, colScale: 800, rowOffset: 0, rowScale: 1 }, 0, 0);
  await vi.waitFor(() => expect(loader.inFlight).toBe(false));
  expect(loader.error).toMatch(/history metadata continuation/);
  expect(loader.complete).toBe(false);
  loader.dispose();
});
