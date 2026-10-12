/**
 * Watchlist panel (campaign 4, lane C2) — the right rail's favorites surface.
 *
 * Rows come from the module-scoped `watchlist/store` (persisted favorites,
 * `flowmap.watchlist.v1`); their live prices come from lane C1's shared
 * `state/quoteFeed` poll loop (frozen P2) — this panel never talks to the
 * network itself, so N watched symbols share ONE poller and one TTL server-side.
 *
 * Honesty rules (§7):
 *   - a quote that never arrived renders em-dashes, never a made-up price;
 *   - `reachable === false` renders em-dashes + a `no data` chip;
 *   - `stale === true` dims the row and shows a `stale` chip while keeping the
 *     LAST KNOWN price visible (dimmed data is labelled, not hidden);
 *   - the sparkline is an inline SVG path (`ui/spark.ts`) — no canvas element,
 *     so the global `canvas { position: absolute }` rule is a non-issue.
 *
 * The panel is self-contained: it imports its own CSS and takes only
 * `{ activeKey, onSelect }` (contract P5). INT mounts it above DomLadder.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { subscribeQuotes } from '../state/quoteFeed';
import { bookSessionKey, getSnapshot, subscribe, type BookSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import {
  WATCHLIST_CAP,
  addToWatchlist,
  isValidWatchKey,
  isWatchlisted,
  removeFromWatchlist,
  toggleWatchlist,
  useWatchlist,
} from '../watchlist/store';
import { loadRecents } from './recents';
import { fmtPct, fmtPrice, sparkDirection, sparkPath } from './spark';
import { useIntelligenceStore } from '../state/intelligenceStore';
import '../watchlist/watchlist.css';
import './TradingPanels.css';

/**
 * Structural view of the frozen P2 quote payload (C1's `Quote`). Kept locally
 * so this file compiles before/independently of the quoteFeed module's own
 * type exports; every field is widened so C1's exact nullability choices stay
 * assignable.
 */
export interface WatchQuote {
  price?: number | null;
  changePct?: number | null;
  spark?: readonly number[] | null;
  stale?: boolean;
  reachable?: boolean;
}

export interface WatchlistProps {
  /** Subscription key (`market:symbol`) of the symbol on screen. */
  activeKey: string;
  /** Switch the chart to `key` — the panel never switches symbols itself. */
  onSelect: (key: string) => void;
}

const SPARK_W = 64;
const SPARK_H = 16;
const LIVE_QUOTE_INTERVAL_MS = 100;
export const LIVE_QUOTE_STALE_MS = 5_000;

interface ActiveWatchQuote {
  sessionKey: string;
  price: number;
  source: 'live-mid' | 'live-last';
  receivedAtMs: number;
  stale: boolean;
}

/** Raw BBO midpoint; grouped book rungs are deliberately never a quote source. */
export function activeWatchQuote(snap: BookSnapshot, sessionKey: string): ActiveWatchQuote | null {
  if (snap.sessionKey !== sessionKey) return null;
  const bbo = snap.bbo;
  if (bbo && bbo.bidPx > 0 && bbo.askPx >= bbo.bidPx
    && Number.isFinite(bbo.askPx) && typeof bbo.receivedAtMs === 'number') {
    return { sessionKey, price: bbo.bidPx + (bbo.askPx - bbo.bidPx) / 2,
      source: 'live-mid', receivedAtMs: bbo.receivedAtMs, stale: false };
  }
  const last = snap.trades[0];
  if (!last || last.venue === 'sim' || !(last.price > 0) || !Number.isFinite(last.price)
    || typeof last.receivedAtMs !== 'number') return null;
  return { sessionKey, price: last.price, source: 'live-last', receivedAtMs: last.receivedAtMs, stale: false };
}

/** `crypto:BTCUSDT` → `BTCUSDT` (labels are the symbol half). */
export function symbolOf(key: string): string {
  const i = key.indexOf(':');
  return i >= 0 && i < key.length - 1 ? key.slice(i + 1) : key;
}

/**
 * Row direction for colour: the spark's net direction decides first (spec),
 * then the signed `changePct` when the spark is flat/missing — the colour then
 * still agrees with the number printed next to it.
 */
export function quoteDirection(q: WatchQuote | undefined): 'up' | 'down' | 'flat' {
  if (!q) return 'flat';
  const dir = sparkDirection(q.spark ?? []);
  if (dir > 0) return 'up';
  if (dir < 0) return 'down';
  const chg = q.changePct;
  if (typeof chg === 'number' && Number.isFinite(chg) && chg !== 0) {
    return chg > 0 ? 'up' : 'down';
  }
  return 'flat';
}

/** Price text: em-dash when absent OR unreachable — never a fabricated number. */
export function quotePriceText(q: WatchQuote | undefined): string {
  if (!q || q.reachable === false || typeof q.price !== 'number' || !Number.isFinite(q.price) || q.price <= 0) return '—';
  return fmtPrice(q.price);
}

/** Change text, same honesty rule as {@link quotePriceText}. */
export function quoteChangeText(q: WatchQuote | undefined): string {
  if (quotePriceText(q) === '—') return '—';
  if (!q) return '—';
  return fmtPct(q.changePct);
}

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function Watchlist({ activeKey, onSelect }: WatchlistProps): JSX.Element {
  const watchKeys = useWatchlist();
  const [quotes, setQuotes] = useState<Record<string, WatchQuote>>({});
  const [activeQuote, setActiveQuote] = useState<ActiveWatchQuote | null>(null);
  const subscription = useFlowMapStore((s) => s.subscription);
  const sessionKey = useFlowMapStore(bookSessionKey);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const liveEligible = activeKey === `${subscription?.market}:${subscription?.symbol}`
    && subscription?.market !== 'sim' && subscription?.mode === 'live'
    && status === 'live' && feedState !== 'closed' && watchKeys.includes(activeKey);

  // Local display bridge only. The shared HTTP cache/alert monitor never sees it.
  // Coalesce the <=60Hz book notifications into at most ten price updates/sec.
  useEffect(() => {
    setActiveQuote(null);
    if (!liveEligible) return undefined;
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPublished = -Infinity;
    let sessionVersion = getSnapshot().sessionVersion;
    const publish = (): void => {
      updateTimer = null;
      lastPublished = performance.now();
      const quote = activeWatchQuote(getSnapshot(), sessionKey);
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = null;
      if (quote) {
        quote.stale = performance.now() - quote.receivedAtMs >= LIVE_QUOTE_STALE_MS;
        if (!quote.stale) {
          staleTimer = setTimeout(() => {
            setActiveQuote((prev) => prev ? { ...prev, stale: true } : null);
          }, Math.max(0, LIVE_QUOTE_STALE_MS - (performance.now() - quote.receivedAtMs)));
        }
      }
      setActiveQuote((prev) => prev?.price === quote?.price && prev?.source === quote?.source
        && prev?.receivedAtMs === quote?.receivedAtMs && prev?.stale === quote?.stale ? prev : quote);
    };
    const off = subscribe((snap) => {
      if (snap.sessionVersion !== sessionVersion) {
        sessionVersion = snap.sessionVersion;
        // A reset is safety metadata, not a price update; clear immediately.
        setActiveQuote(null);
      }
      if (updateTimer !== null) return;
      const wait = LIVE_QUOTE_INTERVAL_MS - (performance.now() - lastPublished);
      if (wait <= 0) publish();
      else updateTimer = setTimeout(publish, wait);
    });
    publish();
    return () => {
      off();
      if (updateTimer !== null) clearTimeout(updateTimer);
      if (staleTimer !== null) clearTimeout(staleTimer);
    };
  }, [liveEligible, sessionKey]);

  const empty = watchKeys.length === 0;
  const full = watchKeys.length >= WATCHLIST_CAP;
  const activeValid = isValidWatchKey(activeKey);
  const activePresent = activeValid && isWatchlisted(activeKey);

  // Quote wiring (P2): one subscription for the whole list; empty list → no
  // subscription at all. `watchKeys` identity is stable between mutations, so
  // this effect re-runs exactly on add/remove and cleans up on unmount.
  useEffect(() => {
    setQuotes((prev) => {
      // Drop quotes for removed symbols: a re-add must not flash the old price.
      const next: Record<string, WatchQuote> = {};
      for (const k of watchKeys) {
        const q = prev[k];
        if (q !== undefined) next[k] = q;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    if (watchKeys.length === 0) return undefined;
    return subscribeQuotes([...watchKeys], (key: string, quote: WatchQuote) => {
      setQuotes((prev) => ({ ...prev, [key]: quote }));
    });
  }, [watchKeys]);

  // Empty state suggestions: recents are a shortcut, NOT auto-favorites.
  const recents = useMemo(() => (empty ? loadRecents(browserStorage()) : []), [empty]);

  const talentMap = useIntelligenceStore((s) => s.talent);
  const corporateJets = useIntelligenceStore((s) => s.corporateJets);

  const addActive = useCallback(() => {
    addToWatchlist(activeKey);
  }, [activeKey]);

  return (
    <section className="panel watchlist" data-testid="watchlist" aria-label="Watchlist">
      <header className="panel__header watchlist__header">
        <span className="panel__title">Watchlist</span>
        <span className="panel__badge watchlist__count" data-testid="watchlist-count">
          {watchKeys.length}
        </span>
        <button
          type="button"
          className="watchlist__add"
          onClick={addActive}
          disabled={activePresent || full || !activeValid}
          title={
            full
              ? `Watchlist full (${WATCHLIST_CAP})`
              : !activeValid
                ? 'No active symbol to add'
                : activePresent
                  ? `${symbolOf(activeKey)} is already on the watchlist`
                  : `Add ${symbolOf(activeKey)} to the watchlist`
          }
          data-testid="watchlist-add"
        >
          + Add current
        </button>
      </header>

      {empty ? (
        <div className="watchlist__empty" data-testid="watchlist-empty">
          <p className="watchlist__empty-copy">
            No symbols yet — add the active symbol, or jump to a recent one.
          </p>
          {recents.length > 0 && (
            <>
              <span className="watchlist__empty-label">Recent symbols</span>
              <div className="watchlist__suggestions">
                {recents.map((r) => {
                  const key = `${r.market}:${r.symbol}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="watchlist__suggestion"
                      onClick={() => onSelect(key)}
                      data-testid={`watchlist-recent-${key}`}
                    >
                      {r.symbol}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : (
        <ul className="watchlist__body">
          {watchKeys.map((key) => {
            const live = key === activeKey && liveEligible && activeQuote?.sessionKey === sessionKey ? activeQuote : null;
            const network = quotes[key];
            const q = live ? { ...network, price: live.price, stale: live.stale, reachable: true,
              changePct: network?.reachable === false ? null : network?.changePct } : network;
            const source = live?.source ?? (q ? 'snapshot' : 'none');
            const dir = quoteDirection(q);
            const stale = q?.stale === true;
            const unreachable = q?.reachable === false;
            const available = quotePriceText(q) !== '—';
            const d =
              q && available && q.spark && q.spark.length > 1
                ? sparkPath(q.spark, SPARK_W, SPARK_H)
                : '';
            return (
              <li
                key={key}
                className={`watchlist__row${key === activeKey ? ' is-active' : ''}${
                  stale ? ' is-stale' : ''
                }${unreachable ? ' is-unreachable' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={key === activeKey ? 'true' : undefined}
                onClick={() => onSelect(key)}
                onKeyDown={(e) => {
                  // Nested star/remove buttons bubble; their native Enter/Space
                  // activation must win (R2-M2). Only the row itself selects.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(key);
                  }
                }}
                title={key}
                data-testid={`watchlist-row-${key}`}
                data-key={key}
                data-source={source}
              >
                <button
                  type="button"
                  className="watchlist__star"
                  aria-pressed="true"
                  aria-label={`Remove ${symbolOf(key)} from watchlist`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleWatchlist(key);
                  }}
                  data-testid={`watchlist-star-${key}`}
                >
                  ★
                </button>
                <span className="watchlist__identity">
                  <span className="watchlist__sym">{symbolOf(key)}</span>
                  <span className="watchlist__source" data-testid={`watchlist-source-${key}`}
                    title={live ? 'Active stream quote; daily change and sparkline remain HTTP snapshots'
                      : 'Shared HTTP quote snapshot, refreshed every 10 seconds'}>
                    {source === 'live-mid' ? 'LIVE MID' : source === 'live-last' ? 'LIVE LAST' : 'SNAPSHOT'}
                  </span>
                </span>
                <svg
                  className="watchlist__spark"
                  width={SPARK_W}
                  height={SPARK_H}
                  viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                  aria-hidden="true"
                >
                  {d && <path className={`watchlist__spark-path is-${dir}`} d={d} />}
                </svg>
                <span
                  className={`watchlist__px${unreachable ? ' is-empty' : ''}`}
                  data-testid={`watchlist-price-${key}`}
                  data-raw-price={quotePriceText(q) === '—' ? undefined : q?.price ?? undefined}
                >
                  {quotePriceText(q)}
                </span>
                <span
                  className={`watchlist__chg is-${dir}`}
                  data-testid={`watchlist-change-${key}`}
                  title="Daily change from the shared quote snapshot"
                >
                  {quoteChangeText(q)}
                </span>
                {(() => {
                  const s = symbolOf(key).toUpperCase();
                  const t = talentMap[s];
                  const jet = corporateJets.some((j) => j.symbol === s && j.isMaHub);
                  return (
                    <>
                      {t && Number.isFinite(t.talentDeltaPct) && Number.isFinite(t.rdOpenings) && (
                        <span
                          className={`watchlist__chip watchlist__talent is-${t.talentDeltaPct >= 0 ? 'pos' : 'neg'}`}
                          title={`Talent Velocity: ${t.talentDeltaPct >= 0 ? '+' : ''}${t.talentDeltaPct.toFixed(1)}% R&D Openings (${t.rdOpenings} listings)`}
                          data-testid={`watchlist-talent-${key}`}
                        >
                          {t.talentDeltaPct >= 0 ? '+' : ''}{t.talentDeltaPct.toFixed(0)}%
                        </span>
                      )}
                      {jet && (
                        <span
                          className="watchlist__chip watchlist__jet"
                          title="Executive Jet Transit Alert: Corporate jet telemetry active in M&A/Finance Hub"
                          data-testid={`watchlist-jet-${key}`}
                        >
                          ✈️
                        </span>
                      )}
                    </>
                  );
                })()}
                {unreachable ? (
                  <span
                    className="watchlist__chip watchlist__chip--na"
                    data-testid={`watchlist-nodata-${key}`}
                  >
                    no data
                  </span>
                ) : stale ? (
                  <span
                    className="watchlist__chip watchlist__chip--stale"
                    data-testid={`watchlist-stale-${key}`}
                  >
                    stale
                  </span>
                ) : null}
                <button
                  type="button"
                  className="watchlist__remove"
                  aria-label={`Remove ${symbolOf(key)} from watchlist`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromWatchlist(key);
                  }}
                  data-testid={`watchlist-remove-${key}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default Watchlist;
