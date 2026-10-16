/**
 * Timeline transport honesty tests (QA11 H1/H2/M1/M2, F12 lane).
 *
 * The transport pill/readout/controls may describe the CURRENT subscription
 * only after it has ATTACHED (a Hello for it landed + the connection is live).
 * The QA11 repro this locks down: a replay click against a session-capacitated
 * server (close 1013) kept the old pill `REPLAY 1× PLAYING`, printed the dead
 * previous session's span (`00:02:07 / 00:02:07`) and left an enabled, inert
 * pause button over a frozen chart — and the 1003 fallback left a naked
 * `FOLLOWING` over an empty chart with no progress or reason.
 */

import { act, Profiler, StrictMode, type ProfilerOnRenderCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import { Timeline, transportDisplay } from './Timeline';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 1 s per column keeps the QA11 numbers exact: 127 cols → 00:02:07.000. */
const DT_NS = 1_000_000_000;
const SPAN_COLS = 127;

function fakeTimeline(spanCols = SPAN_COLS) {
  return {
    oldestSeq: 0,
    newestSeq: spanCols,
    viewStartCol: Math.max(0, spanCols - 10),
    viewEndCol: spanCols,
    timeBase: { anchorSeq: 0, anchorT0Ns: 0n, dtNs: DT_NS },
  };
}

function fakeRenderer(spanCols = SPAN_COLS) {
  const tl = fakeTimeline(spanCols);
  const listeners = new Set<() => void>();
  const subscriptions: Array<{ callback: () => void; unsubscribe: ReturnType<typeof vi.fn> }> = [];
  const r = {
    following: true,
    range: { oldest: 0, newest: spanCols, count: spanCols + 1 } as { oldest: number; newest: number; count: number } | null,
    latestSeq: spanCols,
    drawn: { colOffset: tl.viewStartCol, colScale: tl.viewEndCol - tl.viewStartCol, rowOffset: 0, rowScale: 1 },
    timeBase: tl.timeBase,
    listeners,
    subscriptions,
    get newestColSeq() { return r.latestSeq; },
    get viewSnapshot() { return { ...r.drawn }; },
    residentRange: vi.fn(() => r.range),
    timeline: vi.fn(() => r.range === null ? null : {
      oldestSeq: 0,
      newestSeq: Math.max(r.range.newest, r.latestSeq),
      viewStartCol: r.drawn.colOffset,
      viewEndCol: r.drawn.colOffset + r.drawn.colScale,
      timeBase: r.timeBase,
    }),
    timestampAtColumn: vi.fn((col: number) => r.timeBase.anchorT0Ns + BigInt(Math.round((col - r.timeBase.anchorSeq) * r.timeBase.dtNs))),
    stats: vi.fn(),
    onViewChanged: vi.fn((callback: () => void) => {
      listeners.add(callback);
      const unsubscribe = vi.fn(() => { listeners.delete(callback); });
      subscriptions.push({ callback, unsubscribe });
      return unsubscribe;
    }),
    emitViewChanged() { for (const callback of listeners) callback(); },
  };
  return r;
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(r: ReturnType<typeof fakeRenderer> | null, options: {
  rendererRef?: { current: Renderer | null };
  onCommit?: ProfilerOnRenderCallback;
  strict?: boolean;
  onGoLive?: () => void;
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const rendererRef = options.rendererRef ?? { current: (r as unknown as Renderer) ?? null };
  const content = <Timeline rendererRef={rendererRef} onGoLive={options.onGoLive ?? vi.fn()} />;
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <Profiler id="timeline" onRender={options.onCommit ?? (() => {})}>
        {options.strict ? <StrictMode>{content}</StrictMode> : content}
      </Profiler>,
    );
  });
  const mount = { container, root, rendererRef };
  mounted.push(mount);
  return mount;
}

function poll(): void {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

const q = <T extends Element = Element>(sel: string): T | null =>
  document.body.querySelector<T>(sel);

function setReplay(): void {
  useFlowMapStore.setState({
    subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'replay', band: 'native' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  useFlowMapStore.setState({
    status: 'idle',
    sessionId: null,
    lastClose: null,
    subscription: null,
    paused: false,
    speed: 1,
    replayPlayback: null,
  });
});

describe('Timeline drawn-window subscription', () => {
  it('moves immediately before the next poll, without React commits, store reads or time-map/stats work', () => {
    useFlowMapStore.setState({ status: 'live', sessionId: 'live' });
    const r = fakeRenderer(100);
    const commits = vi.fn();
    render(r, { onCommit: commits });
    poll();
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    const commitCount = commits.mock.calls.length;
    r.timeline.mockClear(); r.timestampAtColumn.mockClear(); r.stats.mockClear();
    const getState = vi.spyOn(useFlowMapStore, 'getState');
    r.following = false;
    r.latestSeq = r.range!.newest = 200;
    act(() => {
      for (let i = 0; i < 60; i++) {
        r.drawn.colOffset = 20 + i / 100;
        r.drawn.colScale = 40;
        r.emitViewChanged();
      }
    });
    expect(parseFloat(window.style.left)).toBeCloseTo(10.295);
    expect(parseFloat(window.style.width)).toBeCloseTo(20);
    expect(commits).toHaveBeenCalledTimes(commitCount);
    expect(r.timeline).not.toHaveBeenCalled();
    expect(r.timestampAtColumn).not.toHaveBeenCalled();
    expect(r.stats).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('FOLLOWING');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:01:40.000');
    getState.mockRestore();
    act(() => vi.advanceTimersByTime(200));
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('SCROLLED BACK');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:03:20.000');
    expect(q('.go-live__behind')!.textContent).toBe('−00:02:20');
  });

  it('skips CSS writes for duplicate and vertical-only notifications and a quiet fallback poll', () => {
    const r = fakeRenderer(100);
    render(r); poll();
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    const left = vi.spyOn(window.style, 'left', 'set');
    const width = vi.spyOn(window.style, 'width', 'set');
    act(() => {
      r.emitViewChanged();
      r.drawn.rowOffset = 300; r.drawn.rowScale = 7;
      r.emitViewChanged(); r.emitViewChanged();
      vi.advanceTimersByTime(250);
    });
    expect(left).not.toHaveBeenCalled(); expect(width).not.toHaveBeenCalled();
  });

  it('does not rewind a newer DOM position when unrelated store state commits', () => {
    const r = fakeRenderer(100);
    render(r); poll();
    act(() => { r.drawn.colOffset = 23.123; r.emitViewChanged(); });
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    const before = window.style.cssText;
    act(() => useFlowMapStore.setState({ speed: 7, paused: true }));
    expect(window.style.cssText).toBe(before);
    expect(parseFloat(window.style.left)).toBeCloseTo(23.123);
  });

  it('attaches a renderer assigned after a null mount on the existing 250 ms poll', () => {
    const r = fakeRenderer(100);
    const { rendererRef } = render(null);
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    expect(window.style.left).toBe('0%'); expect(window.style.width).toBe('100%');
    rendererRef.current = r as unknown as Renderer;
    act(() => vi.advanceTimersByTime(249));
    expect(r.listeners.size).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(r.onViewChanged).toHaveBeenCalledTimes(1);
    expect(r.listeners.size).toBe(1);
    expect(window.style.left).toBe('90%');
    act(() => { r.drawn.colOffset = 30; r.emitViewChanged(); });
    expect(window.style.left).toBe('30%');
  });

  it('rejects stale callbacks through replacement, null and A→B→A reattachment, then unsubscribes on unmount', () => {
    const a = fakeRenderer(100); const b = fakeRenderer(200);
    const mount = render(a);
    const staleA = a.subscriptions[0].callback;
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    const oldGeometry = window.style.cssText;
    mount.rendererRef.current = b as unknown as Renderer;
    act(() => { a.drawn.colOffset = 10; staleA(); });
    expect(window.style.cssText).toBe(oldGeometry);
    act(() => vi.advanceTimersByTime(250));
    expect(a.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(a.listeners.size).toBe(0); expect(b.listeners.size).toBe(1);
    expect(b.onViewChanged).toHaveBeenCalledTimes(1);
    act(() => { b.drawn.colOffset = 50; b.emitViewChanged(); });
    expect(window.style.left).toBe('25%');
    mount.rendererRef.current = null;
    act(() => { b.drawn.colOffset = 60; b.emitViewChanged(); });
    expect(window.style.left).toBe('25%');
    act(() => vi.advanceTimersByTime(250));
    expect(b.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(window.style.left).toBe('0%'); expect(window.style.width).toBe('100%');
    mount.rendererRef.current = a as unknown as Renderer;
    act(() => staleA());
    expect(window.style.left).toBe('0%');
    act(() => vi.advanceTimersByTime(250));
    expect(a.onViewChanged).toHaveBeenCalledTimes(2);
    expect(a.listeners.size).toBe(1); expect(window.style.left).toBe('10%');
    act(() => { a.drawn.colOffset = 20; staleA(); });
    expect(window.style.left).toBe('10%');
    act(() => a.emitViewChanged());
    expect(window.style.left).toBe('20%');
    mounted.splice(mounted.indexOf(mount), 1);
    act(() => mount.root.unmount());
    expect(a.listeners.size).toBe(0);
    expect(a.subscriptions[1].unsubscribe).toHaveBeenCalledTimes(1);
    const finalGeometry = window.style.cssText;
    act(() => { a.drawn.colOffset = 50; a.subscriptions[1].callback(); vi.advanceTimersByTime(500); });
    expect(window.style.cssText).toBe(finalGeometry);
    expect(vi.getTimerCount()).toBe(0);
    mount.container.remove();
  });

  it('has exactly one listener and timer after StrictMode setup→cleanup→setup', () => {
    const r = fakeRenderer(100);
    render(r, { strict: true });
    expect(r.onViewChanged).toHaveBeenCalledTimes(2);
    expect(r.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(r.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    act(() => { r.drawn.colOffset = 30; r.subscriptions[0].callback(); });
    expect(window.style.left).toBe('90%');
    act(() => r.emitViewChanged());
    expect(window.style.left).toBe('30%');
  });

  it('unsubscribes immediately when the rendererRef prop itself changes', () => {
    const a = fakeRenderer(100); const b = fakeRenderer(200);
    const mount = render(a);
    const nextRef = { current: b as unknown as Renderer };
    act(() => mount.root.render(
      <Profiler id="timeline" onRender={() => {}}>
        <Timeline rendererRef={nextRef} onGoLive={vi.fn()} />
      </Profiler>,
    ));
    expect(a.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(a.listeners.size).toBe(0); expect(b.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    const before = window.style.cssText;
    act(() => { a.drawn.colOffset = 50; a.subscriptions[0].callback(); });
    expect(window.style.cssText).toBe(before);
    act(() => { b.drawn.colOffset = 30; b.emitViewChanged(); });
    expect(window.style.left).toBe('15%');
  });

  it.each([
    { label: 'scrolled back', newest: 100, offset: 20, scale: 30, left: 20, width: 30 },
    { label: 'eased following edge', newest: 100, offset: 90.5, scale: 10, left: 90.5, width: 9.5 },
    { label: 'zero-width zoom', newest: 100, offset: 50, scale: 0, left: 50, width: 0.6 },
    { label: 'clamped overscroll', newest: 100, offset: -20, scale: 140, left: 0, width: 100 },
    { label: 'one-column extent', newest: 0, offset: 0, scale: 1, left: 0, width: 100 },
  ])('preserves minimap percentages for $label', ({ newest, offset, scale, left, width }) => {
    const r = fakeRenderer(newest);
    // A narrower resident ring still uses session oldest=0 and max(newest).
    r.range = { oldest: Math.max(0, newest - 10), newest: Math.max(0, newest - 5), count: 6 };
    r.drawn.colOffset = offset; r.drawn.colScale = scale;
    render(r);
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    expect(parseFloat(window.style.left)).toBeCloseTo(left);
    expect(parseFloat(window.style.width)).toBeCloseTo(width);
  });

  it('restores empty defaults and ignores non-finite geometry until valid data returns', () => {
    const r = fakeRenderer(100); r.range = null;
    render(r);
    const window = q<HTMLDivElement>('[data-testid="minimap-window"]')!;
    expect(window.style.left).toBe('0%'); expect(window.style.width).toBe('100%');
    r.range = { oldest: 0, newest: 100, count: 101 };
    act(() => r.emitViewChanged());
    expect(window.style.left).toBe('90%');
    const validGeometry = window.style.cssText;
    act(() => { r.drawn.colOffset = NaN; r.emitViewChanged(); });
    expect(window.style.cssText).toBe(validGeometry);
    act(() => { r.drawn.colOffset = 50; r.latestSeq = Infinity; r.emitViewChanged(); });
    expect(window.style.cssText).toBe(validGeometry);
    act(() => { r.latestSeq = 100; r.drawn.colScale = Infinity; r.emitViewChanged(); });
    expect(window.style.cssText).toBe(validGeometry);
    act(() => { r.drawn.colScale = 10; r.range = null; r.emitViewChanged(); });
    expect(window.style.left).toBe('0%'); expect(window.style.width).toBe('100%');
    act(() => { r.range = { oldest: 0, newest: 100, count: 101 }; r.drawn.colOffset = 90; r.emitViewChanged(); });
    expect(window.style.left).toBe('90%');
  });

  it('polls quiet-view extent changes while replay geometry notifications send no transport commands', () => {
    const seek = vi.spyOn(useFlowMapStore.getState(), 'seek');
    const pause = vi.spyOn(useFlowMapStore.getState(), 'pause');
    const resume = vi.spyOn(useFlowMapStore.getState(), 'resume');
    const setSpeed = vi.spyOn(useFlowMapStore.getState(), 'setSpeed');
    const r = fakeRenderer(100);
    useFlowMapStore.setState({ status: 'live', sessionId: 'replay', replayPlayback: {
      startNs: 17_123_456_789n, endNs: 617_123_456_789n, positionNs: 34_246_456_789n,
      columns: 600, paused: true, speed: 1, ended: false, generation: 0,
    } });
    setReplay(); render(r); poll();
    act(() => { r.drawn.colOffset = 20; r.emitViewChanged(); });
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:00:17.123 / 00:10:00.000');
    expect(seek).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled(); expect(setSpeed).not.toHaveBeenCalled();
    act(() => useFlowMapStore.setState({ replayPlayback: {
      ...useFlowMapStore.getState().replayPlayback!, endNs: 677_123_456_789n,
    } }));
    poll();
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:00:17.123 / 00:11:00.000');
  });

  it('preserves trailing seek throttling, release flushing and mode-switch scrub cleanup during hot view updates', () => {
    const start = 1_791_900_000_123_456_789n;
    const seek = vi.spyOn(useFlowMapStore.getState(), 'seek');
    const r = fakeRenderer(100);
    useFlowMapStore.setState({ status: 'live', sessionId: 'replay', paused: true, replayPlayback: {
      startNs: start, endNs: start + 600_000_000_000n, positionNs: start + 300_000_000_000n,
      columns: 600, paused: true, speed: 1, ended: false, generation: 0,
    } });
    setReplay(); render(r); poll();
    const input = (value: string): void => {
      const scrubber = q<HTMLInputElement>('[data-testid="seek-scrubber"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(scrubber, value);
        scrubber.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    input('100'); input('300');
    act(() => { r.drawn.colOffset = 40; r.emitViewChanged(); vi.advanceTimersByTime(249); });
    expect(seek).not.toHaveBeenCalled();
    expect(q<HTMLInputElement>('[data-testid="seek-scrubber"]')!.value).toBe('300');
    act(() => vi.advanceTimersByTime(1));
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(start + 180_000_000_000n);
    input('500');
    act(() => q('[data-testid="seek-scrubber"]')!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' })));
    expect(seek).toHaveBeenCalledTimes(2);
    expect(seek).toHaveBeenLastCalledWith(start + 300_000_000_000n);
    act(() => vi.advanceTimersByTime(250));
    expect(seek).toHaveBeenCalledTimes(2);
    input('700');
    act(() => useFlowMapStore.setState({ subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'native' } }));
    act(() => { r.drawn.colOffset = 50; r.emitViewChanged(); vi.advanceTimersByTime(250); });
    expect(seek).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="seek-scrubber"]')).toBeNull();
    act(() => setReplay()); poll();
    expect(q<HTMLInputElement>('[data-testid="seek-scrubber"]')!.value).toBe('500');
  });

  it('keeps focus on the transport pill when GO LIVE removes its button after a hot view change', () => {
    const r = fakeRenderer(100); r.following = false;
    useFlowMapStore.setState({ status: 'live', sessionId: 'live' });
    const onGoLive = vi.fn(() => { r.following = true; });
    render(r, { onGoLive }); poll();
    act(() => { r.drawn.colOffset = 30; r.emitViewChanged(); });
    const goLive = q<HTMLButtonElement>('[data-testid="go-live"]')!;
    goLive.focus();
    act(() => goLive.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onGoLive).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="go-live"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="transport-state"]'));
  });
});

describe('transportDisplay (pure honesty contract)', () => {
  it('attached wins over everything — only then may the pill describe the clock', () => {
    expect(transportDisplay(true, true, 'live', null)).toBe('attached');
    expect(transportDisplay(true, false, 'live', 1013)).toBe('attached');
  });

  it('idle/closed reads as no-feed for both modes', () => {
    expect(transportDisplay(false, false, 'idle', null)).toBe('no-feed');
    expect(transportDisplay(false, true, 'closed', null)).toBe('no-feed');
  });

  it('a 1013 close on a replay subscription is a REFUSAL, not a generic drop', () => {
    expect(transportDisplay(false, true, 'reconnecting', 1013)).toBe('refused');
    // …but the same code on a LIVE subscription is not a replay refusal.
    expect(transportDisplay(false, false, 'reconnecting', 1013)).toBe('reconnecting');
    // and a plain drop while replaying is not a refusal either.
    expect(transportDisplay(false, true, 'reconnecting', 1006)).toBe('reconnecting');
  });

  it('connecting vs reconnecting follows the connection status', () => {
    expect(transportDisplay(false, true, 'connecting', null)).toBe('connecting');
    expect(transportDisplay(false, false, 'connecting', null)).toBe('connecting');
    expect(transportDisplay(false, false, 'reconnecting', null)).toBe('reconnecting');
  });
});

describe('Timeline attach honesty', () => {
  it('updates actual time with unchanged viewport geometry and seeks the stable future extent without losing ns precision', () => {
    const start = 1_791_900_000_123_456_789n;
    const seek = vi.spyOn(useFlowMapStore.getState(), 'seek');
    useFlowMapStore.setState({ status: 'live', sessionId: 'stable-replay', paused: true, speed: 7,
      replayPlayback: { startNs: start, endNs: start + 600_000_000_000n, positionNs: start + 17_123_000_000n,
        columns: 2400, paused: true, speed: 7, ended: false, generation: 0 } });
    setReplay(); render(fakeRenderer()); poll();
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:00:17.123 / 00:10:00.000');
    act(() => useFlowMapStore.setState({ replayPlayback: { ...useFlowMapStore.getState().replayPlayback!,
      positionNs: start + 22_456_000_000n } })); poll();
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:00:22.456 / 00:10:00.000');
    const scrubber = q<HTMLInputElement>('[data-testid="seek-scrubber"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(scrubber, '750');
      scrubber.dispatchEvent(new Event('input', { bubbles: true }));
      scrubber.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(250));
    expect(seek).toHaveBeenCalledWith(start + 450_000_000_000n); seek.mockRestore();
  });
  it('a terminal recorded column remains visible with an honest ended transport', () => {
    useFlowMapStore.setState({ status: 'live', sessionId: 'end', paused: true, speed: 7,
      replayPlayback: { startNs: 0n, endNs: 250_000_000n, positionNs: 0n, columns: 1,
        paused: true, speed: 7, ended: true, generation: 0 } });
    setReplay(); render(fakeRenderer(0)); poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY 7× ENDED');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:00:00.000 / 00:00:00.250');
    expect(q<HTMLButtonElement>('[data-testid="transport-play"]')!.disabled).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="seek-scrubber"]')!.disabled).toBe(false);
  });
  it('attached replay: pill + readout describe the real replay clock, controls enabled', () => {
    useFlowMapStore.setState({ status: 'live', sessionId: 'sess-1', lastClose: null,
      replayPlayback: { startNs: 0n, endNs: 600_000_000_000n, positionNs: 127_000_000_000n,
        columns: 600, paused: false, speed: 1, ended: false, generation: 0 } });
    setReplay();
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY 1× PLAYING');
    expect(q('[data-testid="transport-state"]')!.getAttribute('data-transport')).toBe('attached');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:02:07.000 / 00:10:00.000');
    expect((q<HTMLButtonElement>('[data-testid="transport-play"]')!).disabled).toBe(false);
    expect((q<HTMLButtonElement>('[data-testid="speed-cycle"]')!).disabled).toBe(false);
    expect((q<HTMLInputElement>('[data-testid="seek-scrubber"]')!).disabled).toBe(false);
    expect(q('[data-testid="transport-waiting"]')).toBeNull();
    expect(q('[data-testid="transport-progress"]')).toBeNull();
  });

  it('pre-attach replay claim: NO crying "PLAYING" over the previous session frame (QA11 M1)', () => {
    // The exact QA11 shape: the mode toggle ran (sessionId cleared) while the
    // renderer still holds the OLD live session's 127 s extent.
    useFlowMapStore.setState({ status: 'live', sessionId: null, lastClose: null });
    setReplay();
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY CONNECTING…');
    expect(q('[data-testid="transport-state"]')!.getAttribute('data-transport')).toBe('connecting');
    // The fabricated 00:02:07 span must NOT render.
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
    expect((q<HTMLButtonElement>('[data-testid="transport-play"]')!).disabled).toBe(true);
    expect((q<HTMLButtonElement>('[data-testid="speed-cycle"]')!).disabled).toBe(true);
    expect((q<HTMLInputElement>('[data-testid="seek-scrubber"]')!).disabled).toBe(true);
    expect(q('[data-testid="transport-progress"]')).not.toBeNull();
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('waiting for the feed');
  });

  it('1013 session-cap refusal: honest REFUSED state + reason + muted controls (QA11 H1)', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      sessionId: null,
      lastClose: { code: 1013, wasClean: false },
    });
    setReplay();
    render(fakeRenderer());
    poll();
    const pill = q('[data-testid="transport-state"]')!;
    expect(pill.textContent).toBe('REPLAY REFUSED');
    expect(pill.getAttribute('data-transport')).toBe('refused');
    // The reason is surfaced (pill tooltip + waiting line), not just the code.
    expect(pill.getAttribute('title')).toContain('server overloaded');
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('server at capacity');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
    expect(q('[data-testid="transport-progress"]')).not.toBeNull();
    expect((q<HTMLButtonElement>('[data-testid="transport-play"]')!).disabled).toBe(true);
    expect((q<HTMLButtonElement>('[data-testid="speed-cycle"]')!).disabled).toBe(true);
    expect((q<HTMLInputElement>('[data-testid="seek-scrubber"]')!).disabled).toBe(true);
  });

  it('1003 fallback while CONNECTING: progress + empty-state, never a fabricated FOLLOWING (QA11 H2)', () => {
    useFlowMapStore.setState({
      status: 'connecting',
      sessionId: null,
      lastClose: { code: 1003, wasClean: false },
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'deep' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('CONNECTING…');
    expect(q('[data-testid="transport-state"]')!.getAttribute('data-transport')).toBe('connecting');
    // No fabricated 00:00:00.000 — the extent is the dead session's.
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
    expect(q('[data-testid="transport-progress"]')).not.toBeNull();
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('waiting for the feed');
    // Live mode: no dead replay chrome at all.
    expect(q('[data-testid="transport-play"]')).toBeNull();
  });

  it('a live drop while reconnecting says RECONNECTING, not FOLLOWING', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      sessionId: null,
      lastClose: { code: 1006, wasClean: false },
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'deep' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('RECONNECTING…');
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('connection dropped');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
  });

  it('terminal closed: NO FEED, no progress theatre, no controls', () => {
    useFlowMapStore.setState({
      status: 'closed',
      sessionId: null,
      subscription: { market: 'nosuchmarket', symbol: 'NOSUCH', mode: 'live', band: 'native' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('NO FEED');
    expect(q('[data-testid="transport-waiting"]')).toBeNull();
    expect(q('[data-testid="transport-progress"]')).toBeNull();
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
  });

  it('attached live: the pill still speaks about the camera; readout is the extent', () => {
    useFlowMapStore.setState({
      status: 'live',
      sessionId: 'sess-2',
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'native' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('FOLLOWING');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:02:07.000');
  });

  it('attached replay while PAUSED: the pill says PAUSED and play is enabled', () => {
    useFlowMapStore.setState({ status: 'live', sessionId: 'sess-3', lastClose: null, paused: true });
    setReplay();
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY 1× PAUSED');
    const play = q<HTMLButtonElement>('[data-testid="transport-play"]')!;
    expect(play.disabled).toBe(false);
    expect(play.getAttribute('aria-label')).toBe('play');
  });
});
