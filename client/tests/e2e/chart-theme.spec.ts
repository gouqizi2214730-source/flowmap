import type { FlowmapTestApi } from '../../src/gl/testHook';
import { COLORMAP_CATALOG, resolveAppearance } from '../../src/theme/appearance';
import { expect, test, type Page } from '@playwright/test';

import { THEMES, THEME_IDS, type ThemeId } from '../../src/theme/registry';
import { buildRamp } from '../../src/gl/lut';

/**
 * Visual campaign 2026-09-11 (lane L4) — the chart follows the active theme.
 *
 * F6 contract: the active colormap family is stamped on `<html data-chart-ramp>`
 * and the CSS mirror declares the whole `--chart-*` set per theme; `'theme'`
 * lets the active theme own the chart ground/ink, while legacy families
 * (`flow` / `inferno` / `classic`) pin the shipped dark-island values no matter
 * the theme. This spec asserts the DOM token side unconditionally and probes the
 * real GL canvas HARD: R1-H1 (StrictMode-stale theme gate) made the paper boot
 * render the dark FLOW island until a theme switch, so the paper case now
 * requires a light canvas at boot plus `renderer.currentRamp === RAMP_THEME`.
 *
 * Default state (playwright.config storageState): `flowmap.theme=midnight` and
 * no settings blob → colormap resolves to `'theme'` after the v2 migration.
 */

type Px = [number, number, number];

/** Resolve a CSS custom property on <html> to a normalized `rgb(...)` string,
 *  so the spec ignores whether a theme authors hex or functional notation. */
function chartVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    if (!raw) return '';
    const probe = document.createElement('div');
    probe.style.color = raw;
    document.body.appendChild(probe);
    const norm = getComputedStyle(probe).color;
    probe.remove();
    return norm;
  }, name);
}

function luma(px: Px): number {
  return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
}

/**
 * Compare actual pixels with every interpolated density LUT entry. A valid
 * middle color need not be close to either authored control point.
 */
function nearestStopDistance(dom: Px, themeId: ThemeId): number {
  const ramp = buildRamp(THEMES[themeId].chart.density);
  const stops = Array.from({ length: 256 }, (_, i) =>
    Array.from(ramp.slice(i * 4, i * 4 + 3)) as Px);
  return Math.min(
    ...stops.map((r) => Math.abs(dom[0] - r[0]) + Math.abs(dom[1] - r[1]) + Math.abs(dom[2] - r[2])),
  );
}

/** The most common (quantized) color on the GL canvas — the chart ground, which
 *  owns the empty/low-density surface in every ramp family. */
function dominantCanvasColor(page: Page): Promise<Px | null> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas#gl') as HTMLCanvasElement | null;
    if (!c || c.width === 0 || c.height === 0) return null;
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    const step = 4; // every 4th pixel — ~1e5 samples on a real canvas
    for (let i = 0; i < d.length; i += 4 * step) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = buckets.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else {
        buckets.set(key, { n: 1, r, g, b });
      }
    }
    let best: { n: number; r: number; g: number; b: number } | null = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null;
  });
}

/** Mean luma of every 4th pixel over the GL canvas (the chart area), or null
 *  when the canvas is unreachable. Guarded: a light theme must not need a
 *  theme switch for the canvas to leave the dark island (R1-H1). */
function meanCanvasLuma(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas#gl') as HTMLCanvasElement | null;
    if (!c || c.width === 0 || c.height === 0) return null;
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let sum = 0;
    let n = 0;
    const step = 4;
    for (let i = 0; i < d.length; i += 4 * step) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++;
    }
    return n === 0 ? null : sum / n;
  });
}

async function bootSim(page: Page): Promise<void> {
  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (
        window as unknown as {
          __flowmapLive?: {
            renderer?: { residentRange(): { count: number } | null };
            store?: { getState(): { status: string } };
          };
        }
      ).__flowmapLive;
      if (!live?.renderer || !live.store) return false;
      const range = live.renderer.residentRange();
      return live.store.getState().status === 'live' && range !== null && range.count > 5;
    },
    undefined,
    { timeout: 45_000 },
  );
}

/** Re-read the seeds after reload with the same readiness contract. */
async function reloadSim(page: Page): Promise<void> {
  await page.reload();
  await bootSim(page);
}

test('default midnight + theme colormap keeps the shipped dark chart ground', async ({ page }) => {
  await bootSim(page);

  // Post-migration default colormap is `theme` (F6 wiring stamps it on <html>).
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.chartRamp), { timeout: 15_000 })
    .toBe('theme');

  // DOM mirror: midnight keeps the shipped chart tokens — the ground is the
  // active ramp's first stop (#05080e), i.e. the exact GL clear colour.
  expect(await chartVar(page, '--chart-bg')).toBe('rgb(11, 17, 27)');
  expect(await chartVar(page, '--chart-ink')).toBe('rgb(226, 235, 246)');

  // S2-Q1 decoupling check: midnight's OWN density ramp is served from the
  // theme row now — the renderer must report RAMP_THEME (5), not the frozen
  // FLOW row 3. This is the user-visible shorthand for "midnight got its
  // Bookmap-class ramp" (the row-5 bytes are pinned by chart.test.ts).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const live = (window as unknown as { __flowmapLive?: { renderer?: { currentRamp?: number } } })
            .__flowmapLive;
          return typeof live?.renderer?.currentRamp === 'number' ? live.renderer.currentRamp : null;
        }),
      { timeout: 15_000 },
    )
    .toBe(5);

  // Canvas ground ~ the midnight ramp head (5, 8, 14). Soft: only meaningful
  // when the live canvas is reachable (it is under the sim feed). The dominant
  // color includes the near-black low-density field, so allow a dark-bucket
  // tolerance instead of a byte-exact match.
  const dom = await dominantCanvasColor(page);
  if (dom) {
    expect(luma(dom), `dark ground expected, dominant=${dom.join(',')}`).toBeLessThan(70);
    // F10 policy: the modal colour is the midnight ramp head (~10,25,67), not
    // the bare bg — pin it to the active ramp instead (QA25, measured dist 7).
    expect(
      nearestStopDistance(dom, 'midnight'),
      `dominant=${dom.join(',')} nearest midnight stop`,
    ).toBeLessThanOrEqual(48);
  } else {
    test.info().annotations.push({
      type: 'gated',
      description: 'canvas probe skipped: GL canvas not reachable',
    });
  }
});

test('paper theme flips the chart ground + ink to the light palette', async ({ page }) => {
  await bootSim(page);

  await page.evaluate(() => localStorage.setItem('flowmap.theme', 'paper'));
  await reloadSim(page);

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 15_000 })
    .toBe('paper');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.chartRamp), { timeout: 15_000 })
    .toBe('theme');

  expect(await chartVar(page, '--chart-bg')).toBe('rgb(242, 245, 248)');
  const inkNorm = await chartVar(page, '--chart-ink');
  const inkRgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(inkNorm);
  expect(inkRgb, `--chart-ink resolved to "${inkNorm}"`).not.toBeNull();
  // Dark ink on a light ground: luma clearly below mid.
  expect(luma([Number(inkRgb![1]), Number(inkRgb![2]), Number(inkRgb![3])])).toBeLessThan(128);

  // Canvas ground follows the theme ramp AT BOOT (R1-H1 hard check): before the
  // fix, StrictMode's stale gate left renderer #2 on RAMP_FLOW (dark island)
  // until a theme cycle. `currentRamp` is exposed diagnostics on the renderer.
  const ramp = await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive?: { renderer?: { currentRamp?: number } } })
      .__flowmapLive;
    return typeof live?.renderer?.currentRamp === 'number' ? live.renderer.currentRamp : null;
  });
  expect(ramp, 'renderer should resolve RAMP_THEME(5) at boot (R1-H1)').toBe(5);

  // The GL canvas must be a light field: mean luma over the chart area > 90
  // (tolerance for grid/overlay ink), dominant colour near the paper bg.
  const mean = await meanCanvasLuma(page);
  expect(mean, 'GL canvas probe should be reachable').not.toBeNull();
  expect(mean!, `light canvas expected, mean luma ${mean}`).toBeGreaterThan(90);
  const dom = await dominantCanvasColor(page);
  expect(dom, 'GL canvas probe should be reachable').not.toBeNull();
  // F10 policy (QA25, measured dist 26): modal colour is a paper ramp stop.
  expect(
    nearestStopDistance(dom!, 'paper'),
    `dominant=${dom!.join(',')} nearest paper stop`,
  ).toBeLessThanOrEqual(48);
});

test('classic colormap preserves the light chart ground and dark ink', async ({ page }) => {
  await bootSim(page);

  await page.evaluate(() => {
    localStorage.setItem('flowmap.theme', 'paper');
    const key = 'flowmap.settings.v1';
    const raw = localStorage.getItem(key);
    const base = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(key, JSON.stringify({ ...base, settingsVersion: 2, colormap: 'classic' }));
  });
  await reloadSim(page);

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 15_000 })
    .toBe('paper');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.chartRamp), { timeout: 15_000 })
    .toBe('classic');

  expect(await chartVar(page, '--chart-bg')).toBe('rgb(242, 245, 248)');
  expect(await chartVar(page, '--chart-ink')).toBe('rgb(29, 44, 61)');
  expect((await meanCanvasLuma(page))!).toBeGreaterThan(90);
});

// Every combination is painted by the real heatmap shader, including its exact zero and high-density endpoint.
test('all theme × family combinations render adaptive density and amber synthetic pixels', async ({ page }) => {
 await page.goto('/?test=heatmap');
 await page.waitForFunction(() => '__flowmapTest' in window);
 const appearances = THEME_IDS.flatMap(id=>COLORMAP_CATALOG.map(c=>resolveAppearance(id,c.id)));
 const probes=await page.evaluate((items)=>{
  const api=(window as unknown as {__flowmapTest:FlowmapTestApi}).__flowmapTest;
  api.init(64,1,128,128);
  const bid=Array(64).fill(0);for(let r=28;r<=36;r++)bid[r]=100;
  for(let c=0;c<64;c++)api.appendColumn(c,bid,Array(64).fill(0));
  api.fitView();const range=api.residentRange();
  return items.map(a=>{
   api.setThemeRamp(a.density,a.synth);api.setEncoding(1,100);api.setColormap(a.colormap);
   const zero=api.readPixels(64,8,1,1), wall=api.readPixels(64,64,1,1);
   api.setEncoding(1,100,true);const synthetic=api.readPixels(64,64,1,1);
   return {key:a.key,zero,wall,synthetic,retained:JSON.stringify(api.residentRange())===JSON.stringify(range)};
  });
 },appearances);
 for(const [i,p] of probes.entries()) {
  const a=appearances[i];expect(p.retained,p.key).toBe(true);
  expect(p.zero.slice(0,3),`${p.key} zero`).toEqual([...a.density[0].rgb]);
  for(const [px,target] of [[p.wall,a.density.at(-1)!.rgb],[p.synthetic,a.synth.at(-1)!.rgb]] as const) for(let c=0;c<3;c++) expect(Math.abs(px[c]-target[c]),`${p.key} high-density pixel`).toBeLessThanOrEqual(2);
 }
});

test('changing theme and a new family persists together across reload', async ({ page }) => {
 await bootSim(page);await page.getByTestId('settings-open').click();
 await page.getByTestId('theme-swiss').click();await page.getByTestId('colormap-cividis').click();
 await page.reload();await bootSim(page);
 expect(await chartVar(page,'--chart-bg')).toBe('rgb(255, 255, 255)');
 expect(await page.evaluate(()=>document.documentElement.dataset.chartRamp)).toBe('cividis');
});
