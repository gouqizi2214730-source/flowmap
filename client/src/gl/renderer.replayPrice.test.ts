import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Renderer } from './renderer';
import { makeFake2D, makeFakeGL } from './mockGL';
import { priceToRow, type HybridScale } from './priceScale';
import { MsgType, MODE_L2, type EpochParams } from '../proto/types';
import { setFlowMapTransport, useFlowMapStore } from '../state/store';
import type { SocketLike } from '../net/connection';
import type { CameraController } from '../input/gestures';

// Exact native run real-picker-qa-06 geometry/timestamp/bar price. Sparse
// crossed density reproduces its observed extent-derived center (2350.5),
// rather than pretending these aggregates are raw L2 or fabricating a BBO.
const T0 = 1791917241250000000n;
const PRICE = 83102.98;
const SCALE: HybridScale = { kind: 'hybrid', rows: 4096, dnRows: 1347,
  coreRows: 2048, coreP0: 82480, coreStep: .5,
  loPrice: 829.9200500000007, hiPrice: 912912.055 };
const EPOCH: EpochParams = { epoch: 4, tick: .01, tick_multiple: 50, dt_ns: 250_000_000,
  p0: SCALE.coreP0, rows: SCALE.rows, scale_kind: 1, dn_rows: SCALE.dnRows,
  core_rows: SCALE.coreRows, core_p0: SCALE.coreP0, core_step: SCALE.coreStep,
  lo_price: SCALE.loPrice, hi_price: SCALE.hiPrice };

function envelope(type: MsgType, payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(8 + ((payload.length + 3) & ~3)), view = new DataView(out.buffer);
  view.setUint8(0, type); view.setUint8(1, 1); view.setUint16(2, flags, true);
  view.setUint32(4, payload.length, true); out.set(payload, 8); return out;
}

function hello(id: string, seq = 0): Uint8Array {
  return envelope(MsgType.HELLO, new TextEncoder().encode(JSON.stringify({
    protocol_version: 1, session_id: id, grid_epoch: EPOCH.epoch, epoch_params: EPOCH,
    norm_seed: 2, capability: { depth: 'L2', depth_provenance: 'recorded-density',
      quote_provenance: 'recorded-row-centres', replay: true, playback: {
        start_ns: T0.toString(), end_ns: (T0 + 300_250_000_000n).toString(),
        position_ns: (T0 + BigInt(seq) * BigInt(EPOCH.dt_ns)).toString(),
        columns: 1201, paused: true, speed: 1, ended: false, generation: 1,
      } },
  })), 1);
}

function depth(seq = 0, empty = false): Uint8Array {
  const payload = new Uint8Array(24 + SCALE.rows * 8), view = new DataView(payload.buffer);
  view.setUint32(0, EPOCH.epoch, true); view.setUint32(4, seq, true);
  view.setBigInt64(8, T0 + BigInt(seq) * BigInt(EPOCH.dt_ns), true);
  view.setUint8(16, MODE_L2); view.setUint8(17, 1); view.setUint32(20, SCALE.rows, true);
  if (!empty) {
    // Extents 1347..3353 => center2350.5; inside rows2595/2590 overlap.
    for (const [row, amount] of [[1347, 2], [2595, 3]]) view.setFloat32(24 + row * 4, amount, true);
    for (const [row, amount] of [[2590, 4], [3353, 2]]) view.setFloat32(24 + SCALE.rows * 4 + row * 4, amount, true);
  }
  return envelope(MsgType.DEPTH_COL, payload);
}

function bar(seq = 0, price = PRICE): Uint8Array {
  const payload = new Uint8Array(88), view = new DataView(payload.buffer);
  view.setUint32(0, EPOCH.epoch, true); view.setUint32(4, seq, true);
  view.setBigInt64(8, T0 + BigInt(seq) * BigInt(EPOCH.dt_ns), true);
  for (const offset of [16, 24, 32, 40]) view.setFloat64(offset, price, true);
  view.setFloat64(48, 1, true); view.setFloat64(64, 1, true);
  view.setFloat64(72, price, true); view.setFloat64(80, 1, true);
  return envelope(MsgType.BAR_COL, payload);
}

class Socket implements SocketLike {
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send(): void {}
  close(): void {}
  deliver(frame: Uint8Array): void { this.onmessage?.({ data: frame }); }
}

type FitRenderer = { applyPriceFitFrame(): boolean; makeController(): CameraController };

describe('recorded paused price presentation through real Hello/stream routing', () => {
  let r: Renderer, socket: Socket, sockets: Socket[];
  let raf: Array<(ts: number) => void>, time: number;
  let unsubscribe: () => void;

  const pump = (): void => { time += 16; expect(raf.length).toBeGreaterThan(0); raf.shift()!(time); };
  const fitted = (): void => {
    const row = priceToRow(SCALE, PRICE), view = r.viewSnapshot;
    expect(row).toBeCloseTo(2592.96);
    expect(view.rowOffset).toBeLessThan(row);
    expect(view.rowOffset + view.rowScale).toBeGreaterThan(row);
    expect(view.rowOffset + view.rowScale / 2).toBeCloseTo(row);
    expect(view.rowScale).toBeCloseTo(64);
    expect(r.overlayEffectiveBboForTest()).toBeNull();
    expect(useFlowMapStore.getState().paused).toBe(true);
  };

  beforeEach(() => {
    vi.useFakeTimers(); sockets = []; raf = []; time = 0;
    const gl = makeFakeGL(), twoD = makeFake2D();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (kind: string) {
      return (kind === 'webgl2' ? gl : kind === '2d' ? twoD : null) as never;
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => { raf.push(cb); return raf.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    setFlowMapTransport({ url: 'wss://test.invalid/ws', wsFactory: () => {
      const next = new Socket(); sockets.push(next); return next;
    } });
    r = new Renderer(canvas, useFlowMapStore, { capacityColsTarget: 512 });
    // App's production replay generation boundary: synchronous before the
    // Hello's following hot snapshot pairs in the same socket frame.
    unsubscribe = useFlowMapStore.subscribe((state, previous) => {
      if (state.sessionId !== null && state.sessionId !== previous.sessionId) {
        r.setFollowTime(true); r.setPriceFollow('fit'); r.resetForSession();
      }
    });
    useFlowMapStore.getState().connectAndSubscribe('binance-spot', 'BTCUSDT', 'replay');
    socket = sockets[0]; socket.onopen?.();
  });

  afterEach(() => {
    unsubscribe(); r.dispose(); useFlowMapStore.getState().disconnect(); setFlowMapTransport({});
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it('fits the actual first bar before any next depth while retaining crossed density/no quote', () => {
    socket.deliver(hello('recorded-initial')); socket.deliver(depth()); pump();
    expect(r.viewSnapshot.rowOffset + r.viewSnapshot.rowScale / 2).toBe(2350.5);
    const firstTime = r.wantedFollowTime;
    socket.deliver(bar()); pump();
    fitted();
    expect(r.wantedFollowTime).toBe(firstTime);
    expect(r.newestColSeq).toBe(0);
    expect(r.timestampAtColumn(0)).toBe(T0);
    const arrays = (r as unknown as { columnCache: {
      arrays(seq: number): { bid: Float32Array; ask: Float32Array | null } | null;
    } }).columnCache.arrays(0);
    expect(arrays?.bid[2595]).toBe(3); expect(arrays?.ask?.[2590]).toBe(4);
  });

  it('fits the final first-column bar after a backward replay generation/paused seek', () => {
    socket.deliver(hello('recorded-forward', 120)); socket.deliver(depth(120)); socket.deliver(bar(120, PRICE + 20)); pump();
    socket.deliver(hello('recorded-backward')); socket.deliver(depth()); socket.deliver(bar()); pump();
    fitted(); expect(r.newestColSeq).toBe(0);
  });

  it('fits on same-session reconnect when the finalized depth is deduplicated and only the missing bar arrives', () => {
    socket.deliver(hello('recorded-reconnect')); socket.deliver(depth()); pump();
    socket.onclose?.({ code: 1006 }); useFlowMapStore.getState().retryNow();
    socket = sockets[1]; expect(socket).toBeDefined(); socket.onopen?.();
    socket.deliver(hello('recorded-reconnect')); socket.deliver(depth()); socket.deliver(bar()); pump();
    fitted(); expect(r.newestColSeq).toBe(0);
  });

  it('coalesces bar corrections to one fit before a draw and does no refits on unchanged paused frames', () => {
    socket.deliver(hello('recorded-coalesced')); socket.deliver(depth()); pump();
    const fit = vi.spyOn(r as unknown as FitRenderer, 'applyPriceFitFrame');
    socket.deliver(bar(0, PRICE - 1)); socket.deliver(bar()); socket.deliver(bar());
    pump(); fitted(); expect(fit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) pump();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it.each(['off', 'price-pan'] as const)('respects %s chosen after the bar arrives but before its presentation', policy => {
    socket.deliver(hello('recorded-manual')); socket.deliver(depth()); pump();
    socket.deliver(bar());
    if (policy === 'off') r.setPriceFollow('off');
    else (r as unknown as FitRenderer).makeController().panPriceSteps(1);
    const manual = r.viewSnapshot;
    for (let i = 0; i < 5; i++) pump();
    expect(r.viewSnapshot.rowOffset).toBe(manual.rowOffset);
    expect(r.viewSnapshot.rowScale).toBe(manual.rowScale);
    expect(r.priceFollow).toBe('off');
    expect(r.overlayEffectiveBboForTest()).toBeNull();
  });

  it('TRACK recovers the late genuine bar without changing the user price span or time policy', () => {
    socket.deliver(hello('recorded-track')); socket.deliver(depth()); pump();
    r.setPriceFollow('track'); const span = r.viewSnapshot.rowScale, timePolicy = r.wantedFollowTime;
    socket.deliver(bar()); for (let i = 0; i < 60; i++) pump();
    const row = priceToRow(SCALE, PRICE), view = r.viewSnapshot;
    expect(view.rowOffset).toBeLessThan(row); expect(view.rowOffset + view.rowScale).toBeGreaterThan(row);
    expect(view.rowScale).toBeCloseTo(span); expect(r.wantedFollowTime).toBe(timePolicy);
    expect(r.priceFollow).toBe('track'); expect(r.overlayEffectiveBboForTest()).toBeNull();
  });

  it('TRACK follows the bar even if recorded depth is empty, without inventing density or BBO', () => {
    socket.deliver(hello('recorded-empty')); socket.deliver(depth(0, true)); pump();
    r.setViewForTest(0, 1, 2318.5, 64); r.setPriceFollow('track');
    socket.deliver(bar()); for (let i = 0; i < 60; i++) pump();
    const row = priceToRow(SCALE, PRICE), view = r.viewSnapshot;
    expect(view.rowOffset).toBeLessThan(row); expect(view.rowOffset + view.rowScale).toBeGreaterThan(row);
    expect(view.rowScale).toBeCloseTo(64); expect(r.overlayEffectiveBboForTest()).toBeNull();
  });

  it('FIT shows a real recorded bar even when its depth density is empty', () => {
    socket.deliver(hello('recorded-empty-fit')); socket.deliver(depth(0, true)); pump();
    socket.deliver(bar()); pump(); fitted();
  });
});
