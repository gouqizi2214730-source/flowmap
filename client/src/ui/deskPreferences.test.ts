import { expect, it } from 'vitest';
import { DESK_KEY, loadDeskPreferences, saveDeskPreferences } from './deskPreferences';
it('restores bounded geometry and tolerates obsolete/corrupt saved layouts', () => {
  const storage = { getItem: () => JSON.stringify({ layout: 'other', railWidth: 9000, domRatio: -.8, cvdHeight: 0 }) };
  expect(loadDeskPreferences(storage)).toEqual({ layout: 'orderflow', railWidth: 560, domRatio: .25, cvdHeight: 60 });
  expect(loadDeskPreferences({ getItem: () => 'null' })).toEqual(loadDeskPreferences(null));
  expect(loadDeskPreferences({ getItem: () => '{broken' })).toEqual(loadDeskPreferences(null));
});
it('persists the actual chosen workspace without changing chart settings', () => {
  const map = new Map<string, string>();
  const s = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
  const p = { layout: 'analysis' as const, railWidth: 420, domRatio: .4, cvdHeight: 180 };
  saveDeskPreferences(s, p); expect(map.has(DESK_KEY)).toBe(true); expect(loadDeskPreferences(s)).toEqual(p);
});
