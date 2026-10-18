import { useEffect, useState, type RefObject } from 'react';
import { useT } from '../i18n/useT';
import { sessionResetKey, useFlowMapStore } from '../state/store';
import './ChartStartupGate.css';

interface ChartPresentation {
  readonly marketFrameReady: boolean;
  residentRange?: () => { readonly count: number } | null;
}

interface ChartStartupGateProps {
  rendererRef: RefObject<ChartPresentation | null>;
  disabled?: boolean;
}

/** Reveal an actual market after consecutive successful presentations.
 * Canvases continue drawing below this grid overlay throughout initialization.
 * A reconnect retains an already presented history view; a new source or a
 * lost graphics context waits for its own first successful market frame.
 */
export function ChartStartupGate({ rendererRef, disabled = false }: ChartStartupGateProps): JSX.Element | null {
  const t = useT();
  const sub = useFlowMapStore(s => s.subscription);
  const sessionId = useFlowMapStore(s => s.sessionId);
  const revision = useFlowMapStore(s => s.sessionRevision);
  const status = useFlowMapStore(s => s.status);
  const feedState = useFlowMapStore(s => s.feedState);
  const noFeed = useFlowMapStore(s => s.noFeed);
  const identity = `${sessionResetKey(sub)}:${sub?.mode ?? ''}:${sessionId ?? ''}:${revision}`;
  const [revealedIdentity, setRevealedIdentity] = useState<string | null>(null);
  const [emptyHistoryIdentity, setEmptyHistoryIdentity] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) return;
    setRevealedIdentity(null);
    setEmptyHistoryIdentity(null);
    let raf = 0;
    let presentedFrames = 0;
    let revealed = false;
    let hadResidentHistory = false;
    let emptyHistory = false;
    const frame = (): void => {
      const renderer = rendererRef.current;
      const state = useFlowMapStore.getState();
      const range = renderer?.residentRange?.();
      hadResidentHistory ||= (range?.count ?? 0) > 0;
      // An attached closed feed with no retained history is a result, not an
      // endless load. Unknown presentation APIs and a GPU rebuild after real
      // history was retained must not be mistaken for provider data absence.
      const empty = typeof renderer?.residentRange === 'function' && !hadResidentHistory
        && (range?.count ?? 0) === 0 && state.status === 'live'
        && state.feedState === 'closed' && state.sessionId !== null && !state.noFeed;
      if (empty !== emptyHistory) {
        emptyHistory = empty;
        setEmptyHistoryIdentity(empty ? identity : null);
      }
      const presented = renderer?.marketFrameReady === true;
      if (!presented) {
        presentedFrames = 0;
        if (revealed) {
          revealed = false;
          setRevealedIdentity(null);
        }
      } else if (!revealed) {
        // A closed market or reconnect can still present real recorded data.
        // The renderer verifies its source; transport badges remain visible.
        const connected = state.sessionId !== null && !state.noFeed;
        // Readiness is independent of refresh rate. Requiring a 40ms interval
        // leaves a correctly drawn chart covered forever on a slow display.
        presentedFrames = connected ? presentedFrames + 1 : 0;
        if (presentedFrames >= 4) {
          revealed = true;
          setRevealedIdentity(identity);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [disabled, identity, rendererRef]);

  if (disabled || revealedIdentity === identity) return null;
  const historyUnavailable = emptyHistoryIdentity === identity;
  const label = noFeed ? t('banner.noFeedDetail')
    : historyUnavailable ? t('chartStartup.historyUnavailable') : feedState === 'closed' ? t('banner.closed')
    : status === 'reconnecting' || feedState === 'reconnecting' ? t('banner.reconnecting')
    : status === 'closed' ? t('chartStartup.disconnected')
    : status !== 'live' ? t('chartStartup.connecting') : t('chartStartup.preparing');
  return (
    <div className="chart-startup" role="status" aria-live="polite" data-testid="chart-startup-gate">
      <div className="chart-startup__message">
        {!historyUnavailable && <span className="chart-startup__mark" aria-hidden="true" />}
        <strong>{label}</strong>
        {historyUnavailable && <span className="chart-startup__detail">{t('chartStartup.historyUnavailableDetail')}</span>}
        {sub && <span className="chart-startup__instrument">{sub.symbol} <span>{sub.market}</span></span>}
      </div>
    </div>
  );
}
