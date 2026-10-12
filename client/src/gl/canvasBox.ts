/** Observe CSS geometry once per layout change, rather than forcing layout in
 * each frame/poll. Callers own the subscription and dispose it on rebind. */
export function observeCanvasBox(canvas: HTMLCanvasElement): {
  size: () => { width: number; height: number };
  dispose: () => void;
} {
  let box = { width: canvas.clientWidth, height: canvas.clientHeight };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === canvas) box = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
    }
  });
  observer?.observe(canvas);
  return {
    size: () => observer ? box : { width: canvas.clientWidth, height: canvas.clientHeight },
    dispose: () => observer?.disconnect(),
  };
}
