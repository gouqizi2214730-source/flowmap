import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { gammaForContrast } from './gl/heatmap';
import { Renderer } from './gl/renderer';
import type { PriceFollow } from './gl/camera';
import { applyChartInk, applyOverlayPalette } from './gl/overlays/palette';
import {
  attachThemeKey,
  DEFAULT_THEME_ID,
  getCanvasPalette,
  getTheme,
  THEMES,
  useTheme,
  type ThemeId,
} from './theme';
import { attachGlobalKeys, classifyTarget } from './input/keys';
import { decodeFrame } from './proto/decode';
import type { StreamMode } from './proto/types';
import { ChartLegend } from './ui/ChartLegend';
import { ClosedBanner } from './ui/ClosedBanner';
import { Crosshair } from './ui/Crosshair';
import { CvdPane } from './ui/CvdPane';
import { DepthChannelHotkey } from './ui/DepthChannelHotkey';
import { DrawingLayer } from './ui/DrawingLayer';
import { DomLadder } from './ui/DomLadder';
import { DrawToolbar } from './ui/DrawToolbar';
import { IndicatorOverlayCanvas } from './ui/IndicatorOverlayCanvas';
import { IndicatorPicker } from './ui/IndicatorPicker';
import { IntelligenceDrawer } from './ui/IntelligenceDrawer';
import { useIntelligenceStore } from './state/intelligenceStore';
import { isHelpToggle } from './ui/keysheet';
import { LiveControls } from './ui/LiveControls';
import { HeatLegend } from './ui/HeatLegend';
import { MeasureTool, rendererChartMap } from './ui/MeasureTool';
import { MarketStrip } from './ui/MarketStrip';
import { DeskToolbar } from './ui/DeskToolbar';
import { OrderFlowPanel } from './ui/OrderFlowPanel';
import { PaneResizer } from './ui/PaneResizer';
import { loadDeskPreferences, saveDeskPreferences, type DeskLayout } from './ui/deskPreferences';
import { useT } from './i18n/useT';
import './ui/Desk.css';
import { ChartStartupGate } from './ui/ChartStartupGate';
import { loadStartupSymbol, saveStartupSymbol } from './ui/startupSymbol';
import { OnboardingCard } from './ui/OnboardingCard';
import { PerfHud } from './ui/PerfHud';
import { PriceAlerts } from './ui/PriceAlerts';
import { PriceAxis } from './ui/PriceAxis';
import { ReconnectBanner } from './ui/ReconnectBanner';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { ShortcutsOverlay } from './ui/ShortcutsOverlay';
import { Tape } from './ui/Tape';
import { TimeAxis } from './ui/TimeAxis';
import { Timeline } from './ui/Timeline';
import { ReplayPicker } from './ui/ReplayPicker';
import { Toaster } from './ui/Toaster';
import { TopBar } from './ui/TopBar';
import { Watchlist } from './ui/Watchlist';
import { collectExportLayers, exportProvenanceNotes, runPngExport } from './ui/exportPng';
import type { SymbolSearchHandle } from './ui/SymbolSearch';
import {
  DEPTH_CHANNELS,
  historyDepthCols,
  loadSettings,
  saveSettings,
  type Colormap,
  type FlowMapSettings,
} from './ui/settings';
import { useAlertMonitor } from './state/alertMonitor';
import { bookStore } from './state/bookStore';
import { sessionResetKey, setFlowMapTransport, useFlowMapStore } from './state/store';
import type { SocketLike } from './net/connection';

/**
 * M2 shell (§9, T12). The workspace: the top bar (symbol search / venue /
 * capability badges / live-replay toggle / clock), the heatmap stage (dominant GL
 * canvas + price/time axis gutters + overlays) with the collapsible right rail
 * (DOM ladder + tape), the bottom timeline (session minimap + replay transport),
 * and the settings drawer. Persisted settings drive the live-honourable knobs
 * (overlays / bubble threshold / follow / rail); global keys add Space + `/`.
 *
 * High-frequency data stays out of React: the Renderer owns the canvas and reads
 * the store's raw stream directly; this component only holds low-frequency UI
 * state and polls the renderer's timeline geometry at ≤5 Hz.
 */

const SIM_MARKET = 'sim';
const SIM_SYMBOL = 'SIM-DEMO';

/**
 * CP1 seam (B2 lane, campaign 2026-09-11): `liveEdgeVisible` and
 * `resetOverlaysForNewSession` ship with the renderer lane in the same wave.
 * They are OPTIONAL on this compiled type so the UI lane can land in parallel;
 * a missing getter is treated as "unknown" (assume the edge is visible) — the
 * App never forces a goLive it cannot justify.
 */
type RendererCp1 = Renderer & {
  readonly liveEdgeVisible?: boolean;
  resetOverlaysForNewSession?: (sessionId?: string) => void;
};

/**
 * F6 chart-harmony bridge: the subset of `ThemeMeta.chart` the 2D ink bridge
 * (`applyChartInk`) consumes. Mapping explicitly keeps the ramps (density/synth)
 * off the 2D canvas seam — they go to the LUT store via `renderer.setChartTheme`.
 */
type ChartInk = {
  ink: string;
  inkDim: string;
  grid: string;
  gridAlpha?: number;
  axis: string;
  price: string;
  bg: string;
  chipBg: string;
};

function chartInkOf(c: ChartInk): ChartInk {
  return {
    ink: c.ink,
    inkDim: c.inkDim,
    grid: c.grid,
    gridAlpha: c.gridAlpha,
    axis: c.axis,
    price: c.price,
    bg: c.bg,
    chipBg: c.chipBg,
  };
}

/** ≤4 Hz renderer→settings price-follow reconciliation (survey D4). */
const FOLLOW_RECONCILE_MS = 250;

/** Format an absolute (session-relative for sim) ns timestamp as HH:MM:SS. */
function fmtStreamClock(ns: bigint): string | null {
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString().slice(11, 19);
  } catch {
    return null;
  }
}

/**
 * Dev/e2e control tap (`?spy=1`): wrap the WebSocket so every outbound control
 * frame is decoded (bigints → strings) into `window.__flowmapControls`, letting a
 * spec assert the exact Subscribe / Pause / Resume / SetSpeed / Seek messages the
 * transport sends. Never installed in production (the query param gates it).
 */
function installControlSpy(): void {
  const sent: unknown[] = [];
  (window as unknown as { __flowmapControls: unknown[] }).__flowmapControls = sent;
  const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  setFlowMapTransport({
    wsFactory: (url: string): SocketLike => {
      const ws = new WebSocket(url);
      const origSend = ws.send.bind(ws);
      ws.send = ((data: ArrayBufferLike | ArrayBufferView | string): void => {
        try {
          let u8: Uint8Array | null = null;
          if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) {
            u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }
          if (u8 && u8.length) {
            for (const m of decodeFrame(u8)) sent.push(JSON.parse(JSON.stringify(m, replacer)));
          }
        } catch {
          /* never let the tap break the socket */
        }
        origSend(data as never);
      }) as typeof ws.send;
      return ws as unknown as SocketLike;
    },
  });
}

export function App() {
  // Offline DEV harnesses deliberately have no market session or presented
  // frame; their injected data and pointer interactions must remain reachable.
  const offlineHarness = import.meta.env.DEV && (() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('test') === 'heatmap' ||
      ['panels', 'perf', 'normalize', 'overlays'].some(mode => params.get(mode) === '1');
  })();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const priceAxisRef = useRef<HTMLCanvasElement>(null);
  const timeAxisRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const searchRef = useRef<SymbolSearchHandle>(null);
  // The chart container every data-space overlay (measure / drawings / indicator
  // canvas) anchors to — lane CD's mount contract.
  const stageViewportRef = useRef<HTMLDivElement>(null);
  // F6: last (theme, colormap) tuple pushed to `renderer.setChartTheme` — the
  // setter recreates the LUT texture, so only a real change may call it.
  const lastChartThemeRef = useRef<string | null>(null);

  const [settings, setSettings] = useState<FlowMapSettings>(() =>
    loadSettings(typeof window !== 'undefined' ? window.localStorage : null),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replayPicker, setReplayPicker] = useState<{ market: string; symbol: string; band: string } | null>(null);
  const [desk, setDesk] = useState(() => loadDeskPreferences(window.localStorage));
  const t = useT();
  useEffect(() => saveDeskPreferences(window.localStorage, desk), [desk]);
  const intelDrawerOpen = useIntelligenceStore((s) => s.drawerOpen);
  const setIntelDrawerOpen = useIntelligenceStore((s) => s.setDrawerOpen);
  const toggleIntelDrawer = useIntelligenceStore((s) => s.toggleDrawer);
  // The `?` shortcuts overlay (ui/ShortcutsOverlay) — a small modal listing the
  // same keysheet the settings drawer renders.
  const [helpOpen, setHelpOpen] = useState(false);
  // Non-null while the "export refused" note shows in the TopBar (lost GL
  // context — never a fake success). Cleared by dismissal or a later success.
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [streamClock, setStreamClock] = useState<string | null>(null);
  // WebGL2 unavailable: the heatmap canvas cannot render, but the DOM panels
  // (ladder, tape, search) can — the app degrades instead of dying (F1).
  const [glError, setGlError] = useState<string | null>(null);

  // Theme (lane CE): drives the canvas overlay palette bridge below. App only
  // re-renders on an actual theme switch (useSyncExternalStore), which is
  // human-frequency.
  const { theme } = useTheme();

  // F6: push the (theme, colormap) pair onto the renderer's theme ramp. Legacy
  // families pin today's ramps (`null`); `'theme'` follows the active theme.
  // Idempotent via `lastChartThemeRef` — `setChartTheme` recreates the LUT
  // texture, so repeated settings writes must not re-upload it.
  const syncChartTheme = useCallback((themeId: ThemeId, colormap: Colormap): void => {
    const r = rendererRef.current;
    if (!r) return;
    const sig = `${themeId}|${colormap}`;
    if (lastChartThemeRef.current === sig) return;
    lastChartThemeRef.current = sig;
    r.setChartTheme(
      colormap === 'theme'
        ? { id: themeId, density: THEMES[themeId].chart.density, synth: THEMES[themeId].chart.synth }
        : null,
    );
  }, []);

  // Campaign-4 P4: evaluates armed alerts for NON-active symbols by polling
  // `/api/quote` through the shared quoteFeed (visibility-gated, stale-skipping).
  useAlertMonitor();

  // ONE mapping pair for every data-space overlay (CD measure / CF drawings /
  // CG indicators). `rendererChartMap` closes over the renderer REF, so each
  // `fromChart`/`toChart` call reads the LIVE camera/cache at call time — the
  // pair itself never goes stale, and each mounted consumer re-probes on its
  // own cadence (pointer events, ~10 Hz poll, rAF signature) because the
  // renderer exposes no view-changed callback in this build.
  const chartMap = useMemo(() => rendererChartMap(rendererRef), []);

  // Keep the latest settings reachable from the mount-only renderer effect.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const prevSettingsRef = useRef(settings);
  // Keep exact LIVE policies independently of the replay camera. The persisted
  // price switch is boolean and cannot distinguish fit from track.
  const liveFollowRef = useRef<{ time: boolean; price: PriceFollow }>({
    time: settings.follow, price: settings.followPrice ? 'fit' : 'off',
  });

  useEffect(() => {
    // Observe generation changes synchronously: Hello and its first snapshot
    // can share one WS frame, before React effects have a chance to run.
    return useFlowMapStore.subscribe((state, previous) => {
      const identityChanged = sessionResetKey(state.subscription) !== sessionResetKey(previous.subscription)
        || state.sessionRevision !== previous.sessionRevision;
      const newHello = state.sessionId !== null && state.sessionId !== previous.sessionId;
      const replayGeneration = newHello && state.subscription?.mode === 'replay';
      if (identityChanged || replayGeneration) {
        const r = rendererRef.current;
        if (identityChanged && previous.subscription?.mode === 'live' && r) {
          // Canvas keys/gestures can change these just before the picker opens,
          // before the reconciliation timer. Capture BEFORE replacing them.
          liveFollowRef.current = { time: r.wantedFollowTime, price: r.priceFollow };
          const { time, price } = liveFollowRef.current;
          setSettings(prev => prev.follow === time && prev.followPrice === (price !== 'off')
            ? prev : { ...prev, follow: time, followPrice: price !== 'off' });
        }
        r?.setFollowTime(state.subscription?.mode === 'replay' ? true : liveFollowRef.current.time);
        r?.setPriceFollow(state.subscription?.mode === 'replay' ? 'fit' : liveFollowRef.current.price);
        rendererRef.current?.resetForSession();
        bookStore.resetForSession();
      } else if (newHello) {
        bookStore.resetForSession();
        rendererRef.current?.resetOverlaysForNewSession(state.sessionId ?? undefined);
      }
    });

  }, []);

  // --- renderer lifecycle (mount once) -----------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Dev-only heatmap e2e hook (T4): `?test=heatmap` owns the canvas itself.
    if (new URLSearchParams(window.location.search).get('test') === 'heatmap') {
      let disposed = false;
      void import('./gl/testHook').then((m) => {
        if (!disposed) m.installHeatmapTestHook(canvas);
      });
      return () => {
        disposed = true;
      };
    }

    const params = new URLSearchParams(window.location.search);
    const startup = loadStartupSymbol(window.localStorage);
    const perfMode = params.get('perf') === '1';
    const normalizeMode = params.get('normalize') === '1';
    const overlaysMode = params.get('overlays') === '1';
    const panelsMode = params.get('panels') === '1';
    const scrollbackMode = params.get('scrollback') === '1';
    const spyMode = params.get('spy') === '1';
    const benchmarkMode = (window as unknown as { __FLOWMAP_BENCHMARK__?: boolean }).__FLOWMAP_BENCHMARK__ === true;
    const budgetParam = params.get('budget');
    const rendererOpts = scrollbackMode
      ? { capacityColsTarget: budgetParam ? Number.parseInt(budgetParam, 10) : 512 }
      : {};

    // Install the control tap BEFORE the store opens its socket.
    if (spyMode) installControlSpy();

    // GL setup can legitimately fail (no WebGL2 in browser/context — VMs,
    // remote desktops, disabled GPU). Catch it: mark the fallback, still
    // CONNECT (DOM panels run fine without the canvas), and never spawn the
    // renderer. Letting the throw escape would unmount the whole React tree
    // into a silent black screen.
    let renderer: Renderer;
    try {
      renderer = new Renderer(canvas, useFlowMapStore, { ...rendererOpts, benchmark: benchmarkMode });
      renderer.attachOverlaySurfaces(priceAxisRef.current, timeAxisRef.current);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
      if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
        useFlowMapStore
          .getState()
          .connectAndSubscribe(startup.market, startup.symbol, 'live', settingsRef.current.priceBand);
      }
      return () => {
        useFlowMapStore.getState().disconnect();
      };
    }
    rendererRef.current = renderer;
    // R1-H1: the `lastChartThemeRef` gate below survives StrictMode's
    // setup→cleanup→setup (and Vite HMR) while the RENDERER that received the
    // first `setChartTheme` is disposed with the previous effect. Invalidate
    // the signature on every new renderer instance so the boot sync below
    // (line ~295) actually reaches it; the gate still prevents texture
    // re-uploads on later settings writes.
    lastChartThemeRef.current = null;
    // Apply persisted, live-honourable settings at boot.
    renderer.setOverlayVisibility(settingsRef.current.overlays);
    renderer.setBubbleMinSize(settingsRef.current.bubbleMinSize);
    renderer.setContrast(gammaForContrast(settingsRef.current.contrast));
    renderer.setTolerance(settingsRef.current.tolerance);
    renderer.setColormap(settingsRef.current.colormap);
    // F6 boot: seed the chart ramp from the RESOLVED theme (getTheme(), not the
    // hook value — the mount effect is [] deps and must not trust a closure).
    // The bridge effect below re-syncs on theme/colormap changes; the ref makes
    // this call a no-op then.
    syncChartTheme(getTheme(), settingsRef.current.colormap);
    renderer.setNormPercentile(settingsRef.current.normPercentile);
    // Follow policy is remembered by the renderer (`want*`) so the lazy ring
    // creation on the first column cannot discard it.
    renderer.setFollowTime(settingsRef.current.follow);
    // BOOT uses 'fit' on purpose: there is no user zoom to preserve yet, and
    // auto-fit is the only thing that frames the book instead of showing the whole
    // multi-thousand-row grid as a hairline. The "keeps your zoom" contract kicks
    // in AFTER the user has a scale — the settings toggle and the axis chip enable
    // 'track' (below / PriceAxis.tsx), and a price zoom promotes 'fit'→'track'.
    renderer.setPriceFollow(settingsRef.current.followPrice ? 'fit' : 'off');
    // Depth display channel (contract C2 — CB's setter, optional-chained so a
    // build without it keeps the default 'sum' rendering).
    renderer.setDepthChannel?.(settingsRef.current.depthChannel);
    // Tick grouping (campaign-4 P1 — optional-chained for the same reason).
    renderer.setTickGrouping?.(settingsRef.current.tickGrouping);

    if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
      useFlowMapStore
        .getState()
        .connectAndSubscribe(startup.market, startup.symbol, 'live', settingsRef.current.priceBand);
    }

    if (
      import.meta.env.DEV ||
      perfMode ||
      scrollbackMode ||
      normalizeMode ||
      overlaysMode ||
      panelsMode ||
      spyMode ||
      benchmarkMode
    ) {
      (window as unknown as { __flowmapLive: unknown }).__flowmapLive = {
        renderer,
        store: useFlowMapStore,
        bookStore,
      };
    }

    return () => {
      renderer.dispose();
      rendererRef.current = null;
      useFlowMapStore.getState().disconnect();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __flowmapLive?: unknown }).__flowmapLive;
      }
    };
  }, []);

  // --- persist + apply settings on change --------------------------------------
  useEffect(() => {
    saveSettings(settings, typeof window !== 'undefined' ? window.localStorage : null);
    const r = rendererRef.current;
    if (r) {
      r.setOverlayVisibility(settings.overlays); // idempotent
      r.setBubbleMinSize(settings.bubbleMinSize); // idempotent
      r.setContrast(gammaForContrast(settings.contrast)); // idempotent
      r.setTolerance(settings.tolerance); // calibrated against visible liquidity
      r.setColormap(settings.colormap); // idempotent
      // F6: same (theme, colormap) source of truth as the boot path; the ref
      // inside makes this a no-op unless the pair actually changed.
      syncChartTheme(theme, settings.colormap);
      r.setNormPercentile(settings.normPercentile); // idempotent
      r.setDepthChannel?.(settings.depthChannel); // C2, idempotent
      r.setTickGrouping?.(settings.tickGrouping); // P1, idempotent
      // Both follows are edge-triggered so they never fight a manual gesture,
      // and each compares against the renderer's LIVE state (a gesture changes
      // the camera without writing settings, so comparing only against the
      // previous settings value would leave the switch showing a stale ON).
      const live = useFlowMapStore.getState().subscription?.mode !== 'replay';
      if (live && settings.follow !== prevSettingsRef.current.follow && settings.follow !== r.wantedFollowTime) {
        // setFollowTime, not goLive: re-pinning the right edge must not discard
        // the price zoom the user has chosen.
        r.setFollowTime(settings.follow);
      }
      if (live && settings.followPrice !== prevSettingsRef.current.followPrice) {
        const wantOn = settings.followPrice;
        // 'track' keeps the user's zoom (recentre-on-drift); never 'fit', which
        // re-frames to the book extent and discards the chosen scale.
        if (wantOn && r.priceFollow === 'off') r.setPriceFollow('track');
        else if (!wantOn && r.priceFollow !== 'off') r.setPriceFollow('off');
      }
      if (live) liveFollowRef.current = { time: r.wantedFollowTime, price: r.priceFollow };
      // A mid-session history-depth change applies LIVE (every other drawer knob
      // does): pull the newly-chosen span now, bounded to the ring by the prefetch
      // guard. A decrease is a no-op — already-loaded history stays resident.
      if (settings.historyDepth !== prevSettingsRef.current.historyDepth && settings.historyDepth !== 'off') {
        const tl = r.timeline();
        if (tl?.timeBase) r.prefetchHistory(historyDepthCols(settings.historyDepth, tl.timeBase.dtNs));
      }
    }
    // Price coverage belongs to the subscription, including the DOM-only GL
    // fallback. With no active subscription there is no instrument to re-grid.
    if (settings.priceBand !== prevSettingsRef.current.priceBand) {
      const sub = useFlowMapStore.getState().subscription;
      if (sub) {
        useFlowMapStore.getState().connectAndSubscribe(sub.market, sub.symbol, sub.mode, settings.priceBand,
          { startNs: sub.startNs, endNs: sub.endNs });
      }
    }
    prevSettingsRef.current = settings;
  }, [settings]);

  // --- renderer→settings price-follow reconciliation (survey D4) ----------------
  // The chip and the global follow keys write through App, but the CHART-CANVAS
  // key path (input/gestures.ts owns P / Shift+P / R there) and a price pan's
  // release (KILL_PRICE) mutate the camera directly, and a gutter double-click
  // re-fits it — all renderer-owned. A ≤4 Hz value-diff reconciliation persists
  // the PRICE axis policy whenever it changes underneath us, so the drawer
  // switch and the next boot can never claim AUTO while the camera is LOCKed
  // (the reported bug: reload silently re-enabled tracking). TIME reconciles
  // wantedFollowTime, which retains explicit intent while a pan detaches the
  // camera. Replay navigation never writes these persisted LIVE policies.
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
      liveFollowRef.current = { time: r.wantedFollowTime, price: r.priceFollow };
      const followPrice = r.priceFollow !== 'off';
      // Capture before React processes the updater: replay may replace the
      // renderer policies in the meantime.
      const follow = r.wantedFollowTime;
      setSettings((prev) => {
        return prev.followPrice === followPrice && prev.follow === follow
          ? prev
          : { ...prev, followPrice, follow };
      });
    }, FOLLOW_RECONCILE_MS);
    return () => window.clearInterval(id);
  }, []);

  // Session generation teardown happens synchronously in the renderer lifecycle.
  const subscription = useFlowMapStore((s) => s.subscription);
  const subKey = sessionResetKey(subscription);

  // --- first-launch history prefetch (once per session) ------------------------
  // When the chosen depth is not 'off', wait for the first column (so we know the
  // epoch's dt), translate the wall-clock depth to columns, and eagerly pull that
  // much history into the ring so scroll-back is instant. Runs once per session.
  useEffect(() => {
    // Skip inside the e2e test harnesses (?scrollback / ?perf / …): those drive
    // history + residency deterministically, and an eager auto-prefetch would
    // pollute their request-count / LRU assertions.
    const p = new URLSearchParams(window.location.search);
    if (['scrollback', 'perf', 'normalize', 'overlays', 'panels'].some((m) => p.get(m) === '1')) return;
    let done = false;
    const id = window.setInterval(() => {
      if (done) return;
      const tl = rendererRef.current?.timeline();
      if (!tl || !tl.timeBase) return; // wait for the first data
      // Read the depth LIVE (not captured at setup) so a choice made during the
      // boot window before the first column takes effect.
      const depth = settingsRef.current.historyDepth;
      if (depth !== 'off') rendererRef.current?.prefetchHistory(historyDepthCols(depth, tl.timeBase.dtNs));
      done = true;
      window.clearInterval(id);
    }, 400);
    return () => window.clearInterval(id);
  }, [subKey]);

  // --- stream clock (≤1 Hz) -----------------------------------------------------
  useEffect(() => {
    const tick = (): void => {
      const tl = rendererRef.current?.timeline();
      if (!tl || !tl.timeBase) {
        setStreamClock((c) => (c === null ? c : null));
        return;
      }
      const { anchorSeq, anchorT0Ns, dtNs } = tl.timeBase;
      const ns = anchorT0Ns + BigInt(Math.round((tl.newestSeq - anchorSeq) * dtNs));
      const next = fmtStreamClock(ns);
      setStreamClock((c) => (c === next ? c : next));
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // --- global keyboard (Space / `/` / `E` / F / P / Shift+P / R) ----------------
  useEffect(() => {
    return attachGlobalKeys({
      onSpace: () => {
        const s = useFlowMapStore.getState();
        if (s.subscription?.mode === 'replay') {
          if (s.paused) s.resume();
          else s.pause();
        } else {
          const r = rendererRef.current;
          r?.toggleFollow();
          // D4: Space is a settings-writable global path — persist the policy it
          // just set, so the drawer switch (and the next boot) agree with the
          // camera instead of claiming ON after a detach.
          if (r) {
            setSettings((prev) =>
              prev.follow === r.following ? prev : { ...prev, follow: r.following },
            );
          }
        }
      },
      onFocusSearch: () => searchRef.current?.focus(),
      onExportPng: exportPng,
      onToggleFollow: onToggleFollowKey,
      onTogglePriceFollow: onTogglePriceFollowKey,
      onPriceAutoFit: onPriceAutoFitKey,
      onGoLive: onGoLive,
      onToggleIntel: toggleIntelDrawer,
    });
  }, []);

  // --- `?` toggles the shortcuts overlay ---------------------------------------
  // Handled OUTSIDE attachGlobalKeys (input/keys.ts is not aware of `?`), but
  // with the SAME focus-safety rules via the shared isHelpToggle: never fires
  // while typing (a typed `?` is a search character) and never while a dialog
  // owns the keyboard (the overlay closes itself with Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!isHelpToggle(e.key, classifyTarget(e.target))) return;
      e.preventDefault();
      setHelpOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- theme (lane CE) -----------------------------------------------------------
  // `T` cycles themes (self-contained binder from the theme module; editable
  // and dialog guarded, so it yields to the drawer/search like the keys above).
  useEffect(() => attachThemeKey(), []);

  // Theme → canvas bridge: GL/2D overlay colors follow the shell theme. The
  // DEFAULT theme (`midnight`) IS the shipped literal palette, so the bridge is
  // never invoked for it (pixel-identity by construction); switching back to
  // midnight restores the originals via the null call.
  useEffect(() => {
    applyOverlayPalette(theme === DEFAULT_THEME_ID ? null : getCanvasPalette(theme));
    // F6 chart harmony: theme (or colormap) changes repaint the 2D ink layers
    // through `applyChartInk` and re-ramp the GL canvas through `setChartTheme`.
    // `'theme'` skips the midnight restore (midnight IS the shipped literal
    // palette); legacy families force the null restore.
    applyChartInk(
      settings.colormap === 'theme' && theme !== DEFAULT_THEME_ID
        ? chartInkOf(THEMES[theme].chart)
        : null,
    );
    syncChartTheme(theme, settings.colormap);
  }, [theme, settings.colormap]);

  // The theme STORE owns the value (useTheme resolves stored → prefers →
  // default); this effect keeps <html data-theme> in lockstep with it, so the
  // first paint and every later render agree even when the store was resolved
  // before any setTheme/initTheme ran (fix 2026-09-10 F1-4: no second source
  // of truth, no first-run flip). setTheme also writes the attribute — this
  // only heals the pre-init path and is otherwise a no-op.
  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // F6 chart harmony: stamp the ramp choice on <html> so the CSS pin
  // `:root[data-chart-ramp='flow'|'inferno'|'classic']` can keep the legacy
  // dark chart tokens while `'theme'` lets the theme own them.
  useEffect(() => {
    document.documentElement.dataset.chartRamp = settings.colormap;
  }, [settings.colormap]);

  // --- settings patch (merge → state → effect persists + applies) --------------
  const applyPatch = useCallback((patch: Partial<FlowMapSettings>) => {
    if (useFlowMapStore.getState().subscription?.mode === 'replay') {
      const { follow, followPrice, ...shared } = patch;
      if (follow !== undefined) rendererRef.current?.setFollowTime(follow);
      if (followPrice !== undefined) rendererRef.current?.setPriceFollow(followPrice ? 'track' : 'off');
      setSettings((prev) => ({ ...prev, ...shared }));
      return;
    }
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // --- symbol / mode actions ---------------------------------------------------
  const onSelectSymbol = useCallback((market: string, symbol: string) => {
    saveStartupSymbol(window.localStorage, market, symbol);
    const mode = useFlowMapStore.getState().subscription?.mode ?? 'live';
    // The band MUST ride along: without it a symbol switch silently reverts the
    // server grid to `native` while the drawer keeps showing the chosen preset.
    useFlowMapStore
      .getState()
      .connectAndSubscribe(market, symbol, mode, settingsRef.current.priceBand);
  }, []);

  const onSetMode = useCallback((mode: StreamMode) => {
    const sub = useFlowMapStore.getState().subscription;
    // QA7 H2 (explicit-only identity): the mode toggle acts on the stream the
    // app already owns. With no subscription there is nothing to switch — the
    // old `?? SIM_MARKET` fallback silently replaced the user's live symbol
    // with sim:SIM-DEMO in any race where the subscription read null.
    if (!sub) return;
    if (mode === 'replay') {
      setReplayPicker({ market: sub.market, symbol: sub.symbol, band: sub.band });
      return;
    }
    // QA7 H1: a mode toggle is a MODE change on the CURRENT grid, so the band
    // must ride along from the subscription, never from the drawer default. The
    // old `settingsRef.current.priceBand` re-gridded the stream whenever they
    // diverged (e.g. settings 'deep' + a session on 'native'), and the deep
    // band's auto-fit frames the whole ±50% band — exactly the pancaked scale
    // QA7 measured right after clicking REPLAY.
    useFlowMapStore.getState().connectAndSubscribe(sub.market, sub.symbol, mode, sub.band);
  }, []);

  const onReplayConfirm = (startNs: bigint, endNs: bigint): void => {
    if (!replayPicker) return;
    const state = useFlowMapStore.getState();
    const sub = state.subscription;
    if (sub?.mode === 'replay' && sub.market === replayPicker.market && sub.symbol === replayPicker.symbol
      && sub.startNs === startNs && sub.endNs === endNs) {
      state.pause(); state.setSpeed(1); state.seek(state.replayPlayback?.startNs ?? startNs);
    } else {
      state.connectAndSubscribe(replayPicker.market, replayPicker.symbol, 'replay', replayPicker.band, { startNs, endNs });
    }
    setReplayPicker(null);
  };

  // GO LIVE routes through App (not straight to the renderer) so it also re-arms
  // the PERSISTED follow flags. Without that, a user who scrolled back would find
  // the drawer's follow switches still reading ON while the camera was frozen —
  // and the next drawer interaction would fight the camera.
  const onGoLive = useCallback(() => {
    const r = rendererRef.current;
    r?.goLive();
    // L3: a replay action must not write the LIVE follow policy.
    if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
    // R2-M1: GO LIVE re-pins TIME and must PRESERVE a deliberate price LOCK
    // (survey S1 verified-good). Persist the renderer's post-goLive price mode
    // instead of forcing tracking back on.
    const priceOn = r?.priceFollow !== 'off';
    setSettings((prev) =>
      prev.follow && prev.followPrice === priceOn
        ? prev
        : { ...prev, follow: true, followPrice: priceOn },
    );
  }, []);

  // Re-enable price tracking WITHOUT re-fitting: 'track' keeps the user's zoom
  // and only recentres on drift (the non-destructive counterpart to GO LIVE).
  //
  // CP1 composite (survey S1 D1): while the live edge is off-screen,
  // `stepPriceFollow` is gated on the newest column being visible, so flipping
  // the mode alone was a SILENT NO-OP (the chip vanished, the price never
  // moved). When the renderer reports the edge hidden, the click ALSO re-pins
  // TIME via goLive() — which keeps the deliberate price lock and the user's
  // zoom — so tracking can actually act. Both follow policies are persisted.
  const onTrackPrice = useCallback(() => {
    const r = rendererRef.current as RendererCp1 | null;
    if (!r) return;
    r.setPriceFollow('track');
    const repin = r.liveEdgeVisible === false;
    if (repin) r.goLive();
    if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
    setSettings((prev) => {
      const follow = repin ? true : prev.follow;
      if (prev.followPrice && prev.follow === follow) return prev;
      return { ...prev, followPrice: true, follow };
    });
  }, []);

  // D4 (survey S4 D5): ONE writer for chip / global keys / drawer toggles. It
  // applies the mode to the renderer AND persists `followPrice`, so the drawer
  // switch and the next boot can never disagree with the camera (the old chip
  // wrote the renderer only: drawer read ON while the camera was LOCKed).
  const onSetPriceFollow = useCallback((mode: PriceFollow) => {
    rendererRef.current?.setPriceFollow(mode);
    if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
    setSettings((prev) => {
      const followPrice = mode !== 'off';
      return prev.followPrice === followPrice ? prev : { ...prev, followPrice };
    });
  }, []);

  // `F` (global; survey S4 D3): toggle TIME follow like the canvas key. The
  // persisted policy is written only in live mode — a replay camera's attach
  // state has no bearing on the live-follow policy the drawer switch stores.
  const onToggleFollowKey = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.toggleFollow();
    if (useFlowMapStore.getState().subscription?.mode !== 'replay') {
      setSettings((prev) => (prev.follow === r.following ? prev : { ...prev, follow: r.following }));
    }
  }, []);

  // `P` (global): toggle the price axis off ↔ track. Reuse the one writer so the
  // persistence semantics match the chip exactly.
  const onTogglePriceFollowKey = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    onSetPriceFollow(r.priceFollow === 'off' ? 'track' : 'off');
  }, [onSetPriceFollow]);

  // `Shift+P` (global): restore price AUTO-FIT (same as a gutter double-click).
  const onPriceAutoFitKey = useCallback(() => {
    onSetPriceFollow('fit');
  }, [onSetPriceFollow]);

  const toggleRail = useCallback(
    () => {
      setSettings((prev) => ({ ...prev, railVisible: !prev.railVisible }));
      setDesk(prev => prev.layout === 'focus' ? { ...prev, layout: 'orderflow' } : prev);
    },
    [],
  );

  // PNG export (top-bar button AND the bare `E` key route through this one
  // handler): F11 (QA13 H1+H2) composes the download from ALL chart layers —
  // GL heat + 2D ink + both gutters + legend chips + provenance footer —
  // `collectExportLayers` forces the fresh frame through `snapshot()` and gates
  // the honest null (lost GL context); on null, show the TopBar's dismissible
  // note — never a fake success. State is read at call time so the filename and
  // the caveats always describe what is on screen right now.
  const exportPng = useCallback(() => {
    const { subscription: sub, capability } = useFlowMapStore.getState();
    const renderer = rendererRef.current;
    const filename = runPngExport(
      collectExportLayers(renderer, document),
      sub?.market ?? SIM_MARKET,
      sub?.symbol ?? SIM_SYMBOL,
      new Date(),
      undefined,
      {
        mode: sub?.mode ?? 'live',
        notes: exportProvenanceNotes({ following: renderer?.following ?? null, mode: sub?.mode, capability }),
        legend: {
          colormap: settingsRef.current.colormap,
          synth: typeof capability?.depth === 'string' && capability.depth.startsWith('SYNTH'),
          tier: typeof capability?.depth === 'string' ? capability.depth : undefined,
        },
      },
    );
    setExportNotice(
      filename
        ? null
        : 'PNG export unavailable — the graphics context is lost. The chart will repaint when it recovers.',
    );
  }, []);

  const dismissExportNotice = useCallback(() => setExportNotice(null), []);

  // --- lane CD: perf-HUD + depth-channel key callbacks ---------------------------
  const toggleHud = useCallback(
    () => setSettings((p) => ({ ...p, hudVisible: !p.hudVisible })),
    [],
  );
  const cycleDepthChannel = useCallback(() => {
    setSettings((p) => ({
      ...p,
      depthChannel: DEPTH_CHANNELS[(DEPTH_CHANNELS.indexOf(p.depthChannel) + 1) % DEPTH_CHANNELS.length],
    }));
  }, []);

  // Active chart scope for the per-symbol overlays (drawings persistence +
  // toolbar label). The store's subscription is the source of truth.
  const activeSymbol = subscription?.symbol ?? SIM_SYMBOL;
  const activeMarket = subscription?.market ?? SIM_MARKET;
  const selectDesk = (layout: DeskLayout): void => {
    setDesk(prev => ({ ...prev, layout, domRatio: layout === 'analysis' ? .4 : .55,
      cvdHeight: layout === 'analysis' ? 160 : 104 }));
    setSettings(prev => ({ ...prev, railVisible: layout !== 'focus', overlays: {
      ...prev.overlays, cvd: layout !== 'focus', profile: layout === 'analysis',
    } }));
  };
  const deskStyle = { '--desk-rail-width': `${desk.railWidth}px`, '--desk-dom-ratio': desk.domRatio,
    '--desk-cvd-height': `${desk.cvdHeight}px` } as CSSProperties;

  return (
    <div className="app" data-desk-root data-desk-layout={desk.layout} style={deskStyle}>
      <TopBar
        ref={searchRef}
        onSelectSymbol={onSelectSymbol}
        onSetMode={onSetMode}
        railVisible={settings.railVisible}
        onToggleRail={toggleRail}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleIntel={toggleIntelDrawer}
        onExportPng={exportPng}
        exportNotice={exportNotice}
        onDismissExportNotice={dismissExportNotice}
        streamClock={streamClock}
      />
      <MarketStrip rendererRef={rendererRef} />
      <DeskToolbar rendererRef={rendererRef} settings={settings} layout={desk.layout} onLayout={selectDesk}
        onChange={applyPatch} onTrack={onTrackPrice} onFit={() => {
          rendererRef.current?.setTimeWindowMs(null);
          rendererRef.current?.setPriceFollow('fit');
          if (useFlowMapStore.getState().subscription?.mode !== 'replay') setSettings(prev => ({ ...prev, followPrice: true }));
        }} />

      <div className="workspace">
        <div className={`stage${settings.overlays.cvd ? ' stage--cvd' : ''}`}>
          <div className={`stage__viewport${settings.overlays.volume ? ' stage__viewport--volume' : ''}`} ref={stageViewportRef}>
            <canvas id="gl" ref={canvasRef} className="gl-canvas" />
            {glError && (
              <div className="gl-fallback" role="alert" data-testid="gl-fallback">
                <span className="gl-fallback__title">Heatmap unavailable</span>
                <span className="gl-fallback__body">
                  WebGL2 is not available in this browser/context
                  {glError ? ` (${glError})` : ''}, so the chart canvas cannot render. The DOM
                  panels — symbol search, DOM ladder, time &amp; sales — keep working.
                </span>
              </div>
            )}
            {/* Campaign-3 chart overlay stack, bottom → top: GL canvas →
                indicator overlay → drawings → measure → alert markers →
                crosshair / HUD. Each layer manages its own pointer-events so
                none steals chart pan/zoom gestures while disarmed. */}
            <IndicatorOverlayCanvas chartMap={chartMap} />
            <DrawingLayer
              containerRef={stageViewportRef}
              chartMap={chartMap}
              symbol={activeSymbol}
              market={activeMarket}
              getTimeBase={() => rendererRef.current?.timeline()?.timeBase ?? null}
            />
            <MeasureTool containerRef={stageViewportRef} map={chartMap} />
            <PriceAlerts rendererRef={rendererRef} soundEnabled={settings.alertSound} />
            <Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />
            {glError === null && <ChartLegend />}
            <HeatLegend colormap={settings.colormap} channel={settings.depthChannel} />
            <PerfHud rendererRef={rendererRef} visible={settings.hudVisible} onToggle={toggleHud} />
            <ClosedBanner />
            <ReconnectBanner />
            <LiveControls
              rendererRef={rendererRef}
              onGoLive={onGoLive}
              onTrackPrice={onTrackPrice}
              mode={subscription?.mode ?? 'live'}
            />
            <DrawToolbar symbol={activeSymbol} />
            <IndicatorPicker />
            <DepthChannelHotkey onCycle={cycleDepthChannel} />
          </div>
          <PriceAxis
            canvasRef={priceAxisRef}
            rendererRef={rendererRef}
            onSetPriceFollow={onSetPriceFollow}
          />
          {settings.overlays.cvd && (
            <>
              <CvdPane rendererRef={rendererRef} />
              <div className="cvd-corner" aria-hidden="true" />
              <PaneResizer axis="y" variable="--desk-cvd-height" value={desk.cvdHeight} min={60} max={220}
                label={t('desk.resizeCvd')} onCommit={cvdHeight => setDesk(prev => ({ ...prev, cvdHeight }))} />
            </>
          )}
          <TimeAxis canvasRef={timeAxisRef} />
          <div className="stage__corner" aria-hidden="true" />
          <ChartStartupGate rendererRef={rendererRef} disabled={glError !== null || offlineHarness} />
        </div>
        {settings.railVisible && (
          <>
          <PaneResizer axis="x" variable="--desk-rail-width" value={desk.railWidth} min={280} max={560}
            label={t('desk.resizeRail')} onCommit={railWidth => setDesk(prev => ({ ...prev, railWidth }))} />
          <aside className="right-rail" data-testid="right-rail">
            <Watchlist
              activeKey={`${activeMarket}:${activeSymbol}`}
              onSelect={(key) => {
                const i = key.indexOf(':');
                if (i > 0) onSelectSymbol(key.slice(0, i), key.slice(i + 1));
              }}
            />
            <OrderFlowPanel />
            <div className="desk-book-panels">
              <DomLadder />
              <PaneResizer axis="y" variable="--desk-dom-ratio" value={desk.domRatio} min={.25} max={.75} ratio
                label={t('desk.resizeBookTape')} onCommit={domRatio => setDesk(prev => ({ ...prev, domRatio }))} />
              <Tape bigTradeUsd={settings.bigTradeUsd} />
            </div>
          </aside>
          </>
        )}
      </div>

      <Timeline rendererRef={rendererRef} onGoLive={onGoLive} />
      {replayPicker && <ReplayPicker market={replayPicker.market} symbol={replayPicker.symbol}
        onClose={() => setReplayPicker(null)} onConfirm={onReplayConfirm} />}

      {settingsOpen && (
        <SettingsDrawer
          settings={subscription?.mode === 'replay' && rendererRef.current
            ? { ...settings, follow: rendererRef.current.following, followPrice: rendererRef.current.priceFollow !== 'off' }
            : settings}
          onChange={applyPatch}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {intelDrawerOpen && (
        <IntelligenceDrawer
          activeSymbol={activeSymbol}
          onClose={() => setIntelDrawerOpen(false)}
        />
      )}

      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}

      {/* lane CE: themeable toast stack + first-run onboarding wizard */}
      <Toaster />
      <OnboardingCard />
    </div>
  );
}
