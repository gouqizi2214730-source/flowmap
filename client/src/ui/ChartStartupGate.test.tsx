import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFlowMapStore } from '../state/store';
import { ChartStartupGate } from './ChartStartupGate';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let element: HTMLDivElement;
let root: Root;
let callbacks: Map<number, FrameRequestCallback>;
let nextId: number;
let renderer: { marketFrameReady: boolean; residentRange?: () => { count: number } | null };
let residentCount: number;
let rendererRef: { current: typeof renderer | null };

beforeEach(() => {
  callbacks = new Map();
  nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  useFlowMapStore.setState({
    status: 'live', feedState: 'live', noFeed: false, sessionId: 'btc-session', sessionRevision: 0,
    subscription: { market: 'binance-spot', symbol: 'BTCUSDT', band: 'deep', mode: 'live' },
  });
  residentCount = 16;
  renderer = { marketFrameReady: false, residentRange: () => residentCount ? { count: residentCount } : null };
  rendererRef = { current: renderer };
  element = document.createElement('div');
  root = createRoot(element);
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function frame(timestamp: number): void {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(timestamp);
  });
}

function reveal(start = 100): void {
  renderer.marketFrameReady = true;
  for (let n = 0; n <= 4; n++) frame(start + 16 * n);
}

it('waits for four real presentations and resets when graphics readiness is lost', () => {
  frame(0);
  frame(100_000);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  renderer.marketFrameReady = true;
  frame(100_016);
  frame(100_032);
  frame(100_048);
  renderer.marketFrameReady = false;
  frame(100_148);
  renderer.marketFrameReady = true;
  frame(100_164);
  frame(100_180);
  frame(100_196);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  frame(100_212);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('retains presented history through a reconnect, then gates a new session', () => {
  reveal();
  act(() => useFlowMapStore.setState({ status: 'reconnecting', feedState: 'reconnecting' }));
  frame(1000);
  expect(element.querySelector('[role="status"]')).toBeNull();
  act(() => useFlowMapStore.setState({ status: 'live', feedState: 'live', sessionId: 'new-btc-session' }));
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  reveal(2000);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('waits again after graphics readiness is lost and keeps refused feeds honest', () => {
  reveal();
  renderer.marketFrameReady = false;
  frame(200);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  act(() => useFlowMapStore.setState({ noFeed: true, feedState: 'closed' }));
  reveal(300);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  expect(element.textContent).toContain('no feed');
});

it('leaves the existing graphics error surface uncovered', () => {
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} disabled />));
  expect(element.querySelector('[role="status"]')).toBeNull();
  expect(callbacks.size).toBe(0);
});

it('waits for a fresh presentation after the graphics error is cleared', () => {
  reveal();
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} disabled />));
  renderer.marketFrameReady = false;
  act(() => root.render(<ChartStartupGate rendererRef={rendererRef} />));
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  reveal(1000);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('reveals real recorded history when the market is closed', () => {
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  reveal();
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('reports unavailable history for an attached closed feed with no retained columns', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  frame(100);
  expect(element.querySelector('strong')?.textContent).toBe('Historical data unavailable');
  expect(element.textContent).toContain('No recorded or provider history is available. Choose another symbol or try again.');
  expect(element.querySelector('.chart-startup__mark')).toBeNull();
  expect(element.textContent).toContain('BTCUSDT');
  frame(100_000);
  expect(element.querySelector('strong')?.textContent).toBe('Historical data unavailable');
});

it('keeps closed history pending presentation distinct from an unavailable provider', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  frame(100);
  expect(element.textContent).toContain('Historical data unavailable');
  // A closed Status can arrive immediately before its real historical columns.
  residentCount = 10;
  frame(116);
  expect(element.textContent).toContain('MARKET CLOSED');
  expect(element.textContent).not.toContain('Historical data unavailable');
  renderer.marketFrameReady = true;
  frame(132);
  frame(148);
  frame(164);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  frame(180);
  expect(element.querySelector('[role="status"]')).toBeNull();
});

it('does not call a GPU rebuild unavailable history after real columns were retained', () => {
  act(() => useFlowMapStore.setState({ feedState: 'closed' }));
  reveal();
  renderer.marketFrameReady = false;
  residentCount = 0; // the graphics restore temporarily re-creates an empty ring
  frame(300);
  expect(element.textContent).toContain('MARKET CLOSED');
  expect(element.textContent).not.toContain('Historical data unavailable');
});

it('requires a connected session and a known empty range before reporting unavailable history', () => {
  residentCount = 0;
  act(() => useFlowMapStore.setState({ feedState: 'closed', sessionId: null }));
  frame(100);
  expect(element.textContent).not.toContain('Historical data unavailable');
  act(() => useFlowMapStore.setState({ sessionId: 'btc-session', status: 'reconnecting' }));
  frame(200);
  expect(element.textContent).not.toContain('Historical data unavailable');
  delete renderer.residentRange;
  act(() => useFlowMapStore.setState({ status: 'live' }));
  frame(300);
  expect(element.textContent).not.toContain('Historical data unavailable');
});

it('reveals a successfully drawn market on a slow display without requiring 25 FPS', () => {
  renderer.marketFrameReady = true;
  frame(0);
  frame(100);
  frame(200);
  expect(element.querySelector('[role="status"]')).not.toBeNull();
  frame(300);
  expect(element.querySelector('[role="status"]')).toBeNull();
});
