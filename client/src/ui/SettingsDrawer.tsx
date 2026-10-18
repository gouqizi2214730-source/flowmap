/**
 * Settings drawer (§9, T12). A right-side sheet exposing the workspace knobs:
 * colormap, normalization percentile, tick grouping, bubble-size threshold, follow
 * mode, right-rail visibility, and the heatmap overlay toggles.
 *
 * Every change flows up via `onChange(patch)`; the App merges it, persists the
 * whole object to localStorage, and applies the live-honourable knobs to the
 * renderer (bubble threshold, overlays, follow, rail). The display knobs (colormap
 * / normalization / tick grouping) are persisted so the choice survives reloads.
 */

import { useEffect, useRef } from 'react';
import { COLORMAP_CATALOG, resolveAppearance, stopsGradient } from '../theme/appearance';

import type { OverlayVisibility } from '../gl/overlays/frame';
import { LOCALES, getLocale, localeLabel, setLocale } from '../i18n';
import { useT } from '../i18n/useT';
import { useFlowMapStore } from '../state/store';
import { THEME_IDS, THEMES, useTheme } from '../theme';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import { useIndicatorStore } from '../indicators/store';
import { isTopOverlay, pushOverlay } from './overlayStack';
import { toggleIndicatorPicker } from './IndicatorPicker';
import { openOnboarding } from './OnboardingCard';
import { OverlayToggles } from './OverlayToggles';
import { KEYSHEET } from './keysheet';
import {
  DEFAULT_SETTINGS,
  DEPTH_CHANNELS,
  HISTORY_DEPTHS,
  PRICE_BANDS,
  type DepthChannelMode,
  type FlowMapSettings,
  type HistoryDepth,
  type PriceBand,
} from './settings';

/** i18n key for each server price band label + the honest trade-off (§8.1). */
const BAND_LABEL_KEY: Record<PriceBand, string> = {
  native: 'settings.band.native',
  wide: 'settings.band.wide',
  full: 'settings.band.full',
  deep: 'settings.band.deep',
};
const BAND_HINT_KEY: Record<PriceBand, string> = {
  native: 'settings.bandHint.native',
  wide: 'settings.bandHint.wide',
  full: 'settings.bandHint.full',
  deep: 'settings.bandHint.deep',
};


/** i18n keys for the depth display channel (contract C2). */
const CHANNEL_LABEL_KEY: Record<DepthChannelMode, string> = {
  sum: 'settings.channel.sum',
  bid: 'settings.channel.bid',
  ask: 'settings.channel.ask',
  imbalance: 'settings.channel.imbalance',
};
const CHANNEL_HINT_KEY: Record<DepthChannelMode, string> = {
  sum: 'settings.channelHint.sum',
  bid: 'settings.channelHint.bid',
  ask: 'settings.channelHint.ask',
  imbalance: 'settings.channelHint.imbalance',
};

/** i18n keys for the first-launch history-depth choices. */
const HISTORY_LABEL_KEY: Record<HistoryDepth, string> = {
  off: 'settings.history.off',
  '1h': 'settings.history.1h',
  '4h': 'settings.history.4h',
  '1d': 'settings.history.1d',
  max: 'settings.history.max',
};

/**
 * P3 handoff: lane C1 adds `alertSound: boolean` (default true) to
 * `ui/settings.ts`. Reading/writing through this optional-shaped alias keeps
 * the drawer compiling AND behaving identically before and after that field
 * lands: absent → ON (the documented default), and the emitted patch carries
 * the field the moment `FlowMapSettings` owns it.
 */
type AlertSoundPatch = Partial<FlowMapSettings> & { alertSound?: boolean };

/**
 * The keyboard surface lives in ui/keysheet.ts, SHARED with the `?` shortcuts
 * overlay so the drawer and the overlay can never drift apart. Every entry is a
 * binding that actually exists in code (input/keys.ts, input/gestures.ts, the
 * App-level `?` toggle) — no aspirational ones.
 */

interface SettingsDrawerProps {
  settings: FlowMapSettings;
  onChange: (patch: Partial<FlowMapSettings>) => void;
  onClose: () => void;
}

export function SettingsDrawer({ settings, onChange, onClose }: SettingsDrawerProps): JSX.Element {
  const t = useT(); // re-renders on locale change (i18n shell pass)
  const { theme, setTheme } = useTheme();
  const toolbarVisible = useDrawingsStore((s) => s.toolbarVisible);
  const pickerOpen = useIndicatorStore((s) => s.pickerOpen);
  const depthTier = useFlowMapStore((s) => s.capability?.depth);
  const synthetic = typeof depthTier === 'string' && depthTier.startsWith('SYNTH');
  const densityControlsDisabled = settings.depthChannel === 'imbalance' && !synthetic;
  const asideRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Esc closes the drawer — but only when the drawer is the TOPMOST open
  // overlay. If the `?` shortcuts overlay sits above it, that overlay's own
  // Escape handler owns the keystroke; `stopPropagation` cannot express this
  // between two listeners on the same window target (see ui/overlayStack.ts).
  // `e.defaultPrevented` covers the other half (QA12 M-1): a surface whose
  // Escape is handled in REACT (the symbol palette) flushes its update — and
  // its registry pop — before this window listener runs, so the stack alone
  // would read this drawer as top and close a second surface on one Escape.
  // A consumed keystroke must stay consumed.
  useEffect(() => {
    const off = pushOverlay('settings');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTopOverlay('settings')) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [onClose]);

  // Modal focus management: capture the opener, move focus inside on open, and
  // restore it on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Trap Tab / Shift+Tab within the drawer while it is open.
  const onTrapKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const aside = asideRef.current;
    if (!aside) return;
    const focusable = aside.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !aside.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const toggleOverlay = (key: keyof OverlayVisibility): void => {
    onChange({ overlays: { ...settings.overlays, [key]: !settings.overlays[key] } });
  };

  const restoreDefaults = (): void => {
    onChange({ ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_SETTINGS.overlays } });
  };

  // P3: absent field reads as the documented default (ON).
  const alertSound = (settings as AlertSoundPatch).alertSound !== false;
  const toggleAlertSound = (): void => {
    const patch: AlertSoundPatch = { alertSound: !alertSound };
    onChange(patch);
  };
  const rowsPerCell =
    settings.tickGrouping === 1
      ? t('settings.rowsPerCellOne')
      : t('settings.rowsPerCell', { n: 4 ** Math.ceil(Math.log2(settings.tickGrouping) / 2) });

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} data-testid="settings-scrim" />
      <aside
        ref={asideRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="settings"
        data-testid="settings-drawer"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
      >
        <header className="drawer__header">
          <span className="drawer__title">{t('drawer.title')}</span>
          <button
            ref={closeRef}
            type="button"
            className="drawer__close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label={t('drawer.close')}
          >
            ✕
          </button>
        </header>

        <div className="drawer__body">
          <span className="drawer__section" data-testid="section-appearance">
            {t('drawer.sectionAppearance')}
          </span>

          {/* theme picker (lane CE registry; T cycles, this pins a choice) */}
          <div className="setting">
            <span className="setting__label">{t('settings.theme')}</span>
            <div className="appearance-grid" role="group" aria-label="theme" data-testid="setting-theme">
              {THEME_IDS.map((id) => {
                const chart = THEMES[id].chart;
                const preview = resolveAppearance(id, settings.colormap);
                return <button type="button" key={id}
                  className={`appearance-choice${theme === id ? ' is-on' : ''}`}
                  aria-pressed={theme === id} data-testid={`theme-${id}`} onClick={() => setTheme(id)}>
                  <svg className="theme-preview" viewBox="0 0 144 64" aria-hidden="true">
                    <rect width="144" height="64" fill={THEMES[id].canvas.bg} />
                    <rect width="144" height="10" fill={chart.chipBg} />
                    <path d="M5 5H21M28 5H46" stroke={chart.ink} strokeWidth="2" />
                    <path d="M118 5H139" stroke={chart.accent} strokeWidth="3" />
                    <rect y="11" width="105" height="46" fill={chart.bg} />
                    <path d="M0 25H105M0 41H105M32 11V57M67 11V57" stroke={chart.grid} strokeOpacity=".25" />
                    {[.2,.4,.6,.8].map((n,i) => <rect key={n} x={5+i*8} y={18+i*9} width={90-i*14} height="3" fill={`rgb(${preview.density[i+1].rgb.join(',')})`} />)}
                    <path d="M0 46L14 40L25 44L42 29L57 34L69 23L85 27L104 17" fill="none" stroke={THEMES[id].mode === 'light' ? '#FFFFFF' : '#000000'} strokeWidth="3" />
                    <path d="M0 46L14 40L25 44L42 29L57 34L69 23L85 27L104 17" fill="none" stroke={chart.price} strokeWidth="1.3" />
                    <rect x="106" y="11" width="38" height="46" fill={chart.gutterBg} />
                    <path d="M111 17H137M111 25H137M111 33H137M111 41H137M111 49H137" stroke={chart.chipBorder} />
                    <path d="M127 21H138M127 29H134" stroke={THEMES[id].canvas.ask} strokeWidth="3" />
                    <path d="M111 37H122M115 45H122" stroke={THEMES[id].canvas.bid} strokeWidth="3" />
                    <rect y="58" width="144" height="6" fill={chart.chipBg} />
                    <path d="M5 61H138" stroke={chart.accent} strokeOpacity=".65" />
                  </svg>
                  <span className="appearance-choice__name">{t(`theme.${id}.name`)}<span aria-hidden="true">{theme === id ? '✓' : ''}</span></span>
                  <span className="appearance-choice__hint">{t(`theme.${id}.hint`)}</span>
                </button>;
              })}
            </div>
          </div>

          {/* language picker (i18n shell: EN default + TR). useT() above makes
              the whole drawer re-render the moment setLocale lands. */}
          <div className="setting">
            <span className="setting__label">{t('settings.language')}</span>
            <div className="segrow" role="group" aria-label="language" data-testid="setting-locale">
              {LOCALES.map((l) => (
                <button
                  type="button"
                  key={l}
                  className={`segrow__btn${getLocale() === l ? ' is-on' : ''}`}
                  aria-pressed={getLocale() === l}
                  data-testid={`locale-${l}`}
                  onClick={() => setLocale(l)}
                >
                  {localeLabel(l)}
                </button>
              ))}
            </div>
          </div>

          {/* panel toggles — surfaces whose setters live in the feature stores */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.hudVisible}
            className={`check${settings.hudVisible ? ' is-on' : ''}`}
            data-testid="toggle-hud"
            onClick={() => onChange({ hudVisible: !settings.hudVisible })}
          >
            {t('settings.hud')}
            <span className="check__box" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={toolbarVisible}
            className={`check${toolbarVisible ? ' is-on' : ''}`}
            data-testid="toggle-draw-toolbar"
            onClick={toggleDrawToolbar}
          >
            {t('settings.drawToolbar')}
            <span className="check__box" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={pickerOpen}
            className={`check${pickerOpen ? ' is-on' : ''}`}
            data-testid="toggle-indicator-picker"
            onClick={toggleIndicatorPicker}
          >
            {t('settings.indicatorPicker')}
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* re-run the first-run wizard (Skip/Done persist; Esc only hides) */}
          <button
            type="button"
            className="drawer__restore"
            data-testid="show-onboarding"
            onClick={openOnboarding}
          >
            {t('settings.showOnboarding')}
          </button>

          <span className="drawer__section" data-testid="section-display">
            {t('drawer.sectionDisplay')}
          </span>
          {densityControlsDisabled && (
            <span className="setting__hint" data-testid="setting-imbalance-hint">
              {t('settings.imbalanceDisplayHint')}
            </span>
          )}

          {/* heatmap contrast (drives the perceptual display gamma; live) */}
          <div className="setting">
            <span className="setting__label">
              {t('settings.contrast')}
              <span className="setting__value">{settings.contrast}</span>
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={100}
              step={1}
              value={settings.contrast}
              aria-label={t('settings.contrast')}
              aria-valuetext={`${settings.contrast}`}
              data-testid="setting-contrast"
              disabled={densityControlsDisabled}
              onChange={(e) => onChange({ contrast: Number(e.target.value) })}
            />
            <span className="setting__hint">{t('settings.contrastHint')}</span>
          </div>

          {/* colormap */}
          <div className="setting">
            <span className="setting__label">{t('settings.colormap')}</span>
            <div className="appearance-grid" role="group" aria-label="colormap" data-testid="setting-colormap">
              {COLORMAP_CATALOG.map(({ id: c, label, hint }) => (
                <button
                  type="button"
                  key={c}
                  className={`appearance-choice${settings.colormap === c ? ' is-on' : ''}`}
                  aria-pressed={settings.colormap === c}
                  data-testid={`colormap-${c}`}
                  disabled={densityControlsDisabled}
                  onClick={() => onChange({ colormap: c })}
                >
                  <span className="palette-preview" aria-hidden="true" style={{background:`linear-gradient(to right, ${stopsGradient(resolveAppearance(theme,c).density)})`}} />
                  <span className="appearance-choice__name">{c === 'theme' ? t('palette.theme') : label}<span aria-hidden="true">{settings.colormap === c ? '✓' : ''}</span></span>
                  <span className="appearance-choice__hint">{t(`palette.${hint}`)}</span>
                </button>
              ))}
            </div>
            <span className="setting__hint">{t('settings.colormapHint')}</span>
          </div>

          {/* depth display channel (contract C2) — applied via renderer.setDepthChannel */}
          <div className="setting">
            <span className="setting__label">{t('settings.depthChannel')}</span>
            <div className="segrow" role="group" aria-label="depth channel" data-testid="setting-depthChannel">
              {DEPTH_CHANNELS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`segrow__btn${settings.depthChannel === c ? ' is-on' : ''}`}
                  aria-pressed={settings.depthChannel === c}
                  data-testid={`depthChannel-${c}`}
                  disabled={synthetic && c !== 'sum'}
                  onClick={() => onChange({ depthChannel: c })}
                >
                  {t(CHANNEL_LABEL_KEY[c])}
                </button>
              ))}
            </div>
            <span className="setting__hint">{t(synthetic ? 'settings.channelSyntheticHint' : CHANNEL_HINT_KEY[settings.depthChannel])}</span>
          </div>

          {/* normalization percentile */}
          <div className="setting">
            <span className="setting__label">
              {t('settings.normalization')}
              <span className="setting__value">p{settings.normPercentile}</span>
            </span>
            <input
              type="range"
              className="range"
              min={80}
              max={100}
              step={0.1}
              value={settings.normPercentile}
              aria-label={t('settings.normalization')}
              aria-valuetext={`p${settings.normPercentile}`}
              data-testid="setting-normPercentile"
              disabled={densityControlsDisabled}
              onChange={(e) => onChange({ normPercentile: Number(e.target.value) })}
            />
            <span className="setting__hint">{t('settings.normalizationHint')}</span>
          </div>

          {/* Raw slider position; the visible depth CDF calibrates its cut. */}
          <div className="setting">
            <span className="setting__label">
              {t('settings.tolerance')}
              <span className="setting__value">
                {settings.tolerance > 0 ? settings.tolerance : t('settings.off')}
              </span>
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={100}
              step={1}
              value={settings.tolerance}
              aria-label={t('settings.tolerance')}
              aria-valuetext={settings.tolerance > 0 ? `${settings.tolerance}` : t('settings.off')}
              data-testid="setting-tolerance"
              disabled={densityControlsDisabled}
              onChange={(e) => onChange({ tolerance: Number(e.target.value) })}
            />
            <span className="setting__hint">{t('settings.toleranceHint')}</span>
          </div>

          <span className="drawer__section" data-testid="section-trades">
            {t('drawer.sectionTrades')}
          </span>

          {/* tick grouping */}
          <div className="setting">
            <span className="setting__label">
              {t('settings.tickGrouping')}
              <span className="setting__value">{rowsPerCell}</span>
            </span>
            <input
              type="range"
              className="range"
              min={1}
              max={16}
              step={1}
              value={settings.tickGrouping}
              aria-label={t('settings.tickGrouping')}
              aria-valuetext={rowsPerCell}
              data-testid="setting-tickGrouping"
              onChange={(e) => onChange({ tickGrouping: Number(e.target.value) })}
            />
            <span className="setting__hint">{t('settings.tickGroupingHint')}</span>
          </div>

          {/* bubble threshold */}
          <div className="setting">
            <span className="setting__label">
              {t('settings.bubble')}
              <span className="setting__value">
                {settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : t('settings.allTrades')}
              </span>
            </span>
            <input
              type="number"
              className="setting__num"
              min={0}
              max={1e9}
              step="any"
              value={settings.bubbleMinSize}
              aria-label={t('settings.bubbleThreshold')}
              aria-valuetext={settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : t('settings.allTrades')}
              data-testid="setting-bubble"
              onChange={(e) => {
                const value = Number(e.target.value);
                onChange({ bubbleMinSize: Number.isFinite(value) ? Math.min(1e9, Math.max(0, value)) : 0 });
              }}
            />
            <span className="setting__hint">{t('settings.bubbleHint')}</span>
          </div>

          {/* Price × native quantity threshold; the stored key is historical. */}
          <div className="setting">
            <span className="setting__label">
              {t('settings.bigTradeLabel')}
              <span className="setting__value">
                {settings.bigTradeUsd > 0
                  ? `≥ $${Math.round(settings.bigTradeUsd).toLocaleString('en-US')}`
                  : t('settings.off')}
              </span>
            </span>
            <input
              type="number"
              className="setting__num"
              min={0}
              step={1000}
              value={settings.bigTradeUsd}
              aria-label={t('settings.bigTrade')}
              data-testid="setting-bigTradeUsd"
              onChange={(e) => {
                const n = Number(e.target.value);
                // Same ceiling normalizeSettings applies on load, so the live
                // value and the next load agree.
                onChange({
                  bigTradeUsd: Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0,
                });
              }}
            />
            <span className="setting__hint">{t('settings.bigTradeHint')}</span>
          </div>

          <span className="drawer__section" data-testid="section-view">
            {t('drawer.sectionView')}
          </span>

          {/* follow mode */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.follow}
            className={`check${settings.follow ? ' is-on' : ''}`}
            data-testid="toggle-follow"
            onClick={() => onChange({ follow: !settings.follow })}
          >
            {t('settings.followLive')}
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* price auto-follow */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.followPrice}
            className={`check${settings.followPrice ? ' is-on' : ''}`}
            data-testid="toggle-follow-price"
            onClick={() => onChange({ followPrice: !settings.followPrice })}
          >
            {t('settings.followPrice')}
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* server price band — changing it re-subscribes */}
          <div className="setting">
            <span className="setting__label">{t('settings.priceRange')}</span>
            <div className="segrow" role="group" aria-label="price range" data-testid="setting-priceBand">
              {PRICE_BANDS.map((b) => (
                <button
                  type="button"
                  key={b}
                  className={`segrow__btn${settings.priceBand === b ? ' is-on' : ''}`}
                  aria-pressed={settings.priceBand === b}
                  data-testid={`priceBand-${b}`}
                  onClick={() => onChange({ priceBand: b })}
                >
                  {t(BAND_LABEL_KEY[b])}
                </button>
              ))}
            </div>
            <span className="setting__hint">{t(BAND_HINT_KEY[settings.priceBand])}</span>
          </div>

          {/* first-launch history depth */}
          <div className="setting">
            <span className="setting__label">{t('settings.historyDepth')}</span>
            <div className="segrow" role="group" aria-label="history depth" data-testid="setting-historyDepth">
              {HISTORY_DEPTHS.map((d) => (
                <button
                  type="button"
                  key={d}
                  className={`segrow__btn${settings.historyDepth === d ? ' is-on' : ''}`}
                  aria-pressed={settings.historyDepth === d}
                  data-testid={`historyDepth-${d}`}
                  onClick={() => onChange({ historyDepth: d })}
                >
                  {t(HISTORY_LABEL_KEY[d])}
                </button>
              ))}
            </div>
            <span className="setting__hint">{t('settings.historyHint')}</span>
          </div>

          {/* right rail */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.railVisible}
            className={`check${settings.railVisible ? ' is-on' : ''}`}
            data-testid="toggle-rail"
            onClick={() => onChange({ railVisible: !settings.railVisible })}
          >
            {t('settings.rightRail')}
            <span className="check__box" aria-hidden="true" />
          </button>

          <span className="drawer__section" data-testid="section-overlays">
            {t('settings.overlays')}
          </span>

          {/* overlays */}
          <div className="setting">
            <OverlayToggles visibility={settings.overlays} onToggle={toggleOverlay} />
          </div>

          {/* alerts (P3): sound toggle for fired price alerts; lane C1 owns the playback */}
          <span className="drawer__section" data-testid="section-alerts">
            {t('drawer.sectionAlerts')}
          </span>
          <div className="setting">
            <button
              type="button"
              role="switch"
              aria-checked={alertSound}
              className={`check${alertSound ? ' is-on' : ''}`}
              data-testid="toggle-alert-sound"
              onClick={toggleAlertSound}
            >
              {t('settings.alertSound')}
              <span className="check__box" aria-hidden="true" />
            </button>
            <span className="setting__hint">{t('settings.alertSoundHint')}</span>
          </div>

          {/* keyboard reference — every binding verified against the code */}
          <span className="drawer__section" data-testid="section-keys">
            {t('drawer.sectionKeyboard')}
          </span>
          <div className="keysheet" data-testid="keysheet">
            {KEYSHEET.map((entry) => (
              <div key={entry.keys} className="keysheet__row">
                <kbd className="keysheet__keys">{entry.keys}</kbd>
                <span className="keysheet__action">{t(entry.actionKey)}</span>
              </div>
            ))}
          </div>

          {/* restore defaults */}
          <button
            type="button"
            className="drawer__restore"
            data-testid="settings-restore"
            onClick={restoreDefaults}
          >
            {t('settings.restoreDefaults')}
          </button>
        </div>
      </aside>
    </>
  );
}
