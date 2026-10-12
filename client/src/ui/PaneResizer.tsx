import { useRef, type PointerEvent } from 'react';

interface Props { axis: 'x' | 'y'; value: number; min: number; max: number; variable: string; label: string; onCommit: (value: number) => void; ratio?: boolean }
/** Drag changes one CSS variable; React/settings persist only when the gesture ends. */
export function PaneResizer({ axis, value, min, max, variable, label, onCommit, ratio = false }: Props): JSX.Element {
  const drag = useRef<{ start: number; value: number; latest: number; root: HTMLElement; scale: number } | null>(null);
  const paint = (root: HTMLElement, n: number): void => { root.style.setProperty(variable, ratio ? String(n) : `${n}px`); };
  const begin = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const root = e.currentTarget.closest<HTMLElement>('[data-desk-root]');
    if (!root) return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: axis === 'x' ? e.clientX : e.clientY, value, latest: value, root,
      scale: ratio ? Math.max(1, e.currentTarget.parentElement?.clientHeight ?? 1) : -1 };
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current; if (!d) return;
    const diff = (axis === 'x' ? e.clientX : e.clientY) - d.start;
    d.latest = Math.max(min, Math.min(max, d.value + diff / d.scale));
    paint(d.root, d.latest);
  };
  const finish = (cancel: boolean): void => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    if (cancel) paint(d.root, value); else onCommit(d.latest);
  };
  return <div className={`pane-resizer pane-resizer--${axis}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    onPointerDown={begin} onPointerMove={move} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)}
    onLostPointerCapture={() => finish(false)} onDoubleClick={() => onCommit((min + max) / 2)}
    onKeyDown={e => {
      const n = ratio ? .05 : 16;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        onCommit(Math.max(min, Math.min(max, value + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -n : n))));
      }
    }} />;
}
