import { afterEach, expect, it, vi } from 'vitest';
import { observeCanvasBox } from './canvasBox';

afterEach(() => vi.unstubAllGlobals());

it('uses resize notifications without forcing layout on repeated reads', () => {
  let notify!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe(): void {}
    disconnect = disconnect;
  });
  const canvas = document.createElement('canvas');
  const width = vi.fn(() => 62);
  const height = vi.fn(() => 700);
  Object.defineProperties(canvas, { clientWidth: { get: width }, clientHeight: { get: height } });
  const box = observeCanvasBox(canvas);
  for (let n = 0; n < 100; n++) expect(box.size()).toEqual({ width: 62, height: 700 });
  expect(width).toHaveBeenCalledTimes(1);
  expect(height).toHaveBeenCalledTimes(1);
  notify([{ target: canvas, contentRect: { width: 64, height: 800 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  expect(box.size()).toEqual({ width: 64, height: 800 });
  box.dispose();
  expect(disconnect).toHaveBeenCalledTimes(1);
});
