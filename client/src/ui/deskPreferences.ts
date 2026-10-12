export type DeskLayout = 'orderflow' | 'analysis' | 'focus';
export interface DeskPreferences { layout: DeskLayout; railWidth: number; domRatio: number; cvdHeight: number }
export const DESK_KEY = 'flowmap.desk.v1';
const DEFAULTS: DeskPreferences = { layout: 'orderflow', railWidth: 340, domRatio: .55, cvdHeight: 104 };
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
export function loadDeskPreferences(storage: Pick<Storage, 'getItem'> | null): DeskPreferences {
  try {
    const p = JSON.parse(storage?.getItem(DESK_KEY) ?? '{}');
    if (!p || typeof p !== 'object') return { ...DEFAULTS };
    return { layout: ['orderflow', 'analysis', 'focus'].includes(p.layout) ? p.layout : DEFAULTS.layout,
      railWidth: clamp(p.railWidth, 280, 560, DEFAULTS.railWidth),
      domRatio: clamp(p.domRatio, .25, .75, DEFAULTS.domRatio), cvdHeight: clamp(p.cvdHeight, 60, 220, DEFAULTS.cvdHeight) };
  } catch { return { ...DEFAULTS }; }
}
export function saveDeskPreferences(storage: Pick<Storage, 'setItem'> | null, value: DeskPreferences): void {
  try { storage?.setItem(DESK_KEY, JSON.stringify(value)); } catch { /* session preferences remain usable */ }
}
