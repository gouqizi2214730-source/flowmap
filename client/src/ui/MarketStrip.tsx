import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Renderer } from '../gl/renderer';
import { getSnapshot, subscribe } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { priceDecimals, fmtSz } from './DomLadder';
import './MarketStrip.css';

const WINDOWS = [
  { label: '15s', ms: 15_000 }, { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 }, { label: '30m', ms: 1_800_000 }, { label: 'All', ms: null },
] as const;

export function quoteAgeText(receivedAt: number | undefined, now: number): string {
  if (receivedAt === undefined) return '—';
  const age = Math.max(0, now - receivedAt);
  return age < 1000 ? `${Math.round(age)} ms` : `${(age / 1000).toFixed(1)} s`;
}

/** Active instrument facts use the raw quote/tape, independent of depth grouping. */
export function MarketStrip({ rendererRef }: { rendererRef: RefObject<Renderer | null> }): JSX.Element {
  const [snap, setSnap] = useState(getSnapshot);
  const [now, setNow] = useState(() => performance.now());
  const [selected, setSelected] = useState<string | null>(null);
  const selectedWindow = useRef<number | null | undefined>(undefined);
  const epochs = useFlowMapStore(s => s.epochs);
  const gridEpoch = useFlowMapStore(s => s.gridEpoch);
  const sub = useFlowMapStore(s => s.subscription);
  const status = useFlowMapStore(s => s.status);
  const feedState = useFlowMapStore(s => s.feedState);
  useEffect(() => subscribe(setSnap), []);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(performance.now());
      if (selectedWindow.current !== undefined && rendererRef.current?.timeWindowMs !== selectedWindow.current) {
        selectedWindow.current = undefined;
        setSelected(null);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [rendererRef]);
  useEffect(() => { selectedWindow.current = undefined; setSelected(null); }, [sub?.market, sub?.symbol]);
  const params = epochs.get(snap.book?.epoch ?? gridEpoch ?? -1);
  const decimals = params ? priceDecimals(params.tick) : 2;
  const fmt = (n: number | undefined): string => n !== undefined && Number.isFinite(n) ? n.toFixed(decimals) : '—';
  const quote = snap.bbo;
  const last = snap.trades[0];
  const age = quote?.receivedAtMs === undefined ? null : Math.max(0, performance.now() - quote.receivedAtMs);
  const state = status !== 'live' ? status : feedState && feedState !== 'live' ? feedState
    : sub?.market === 'sim' ? 'Demo' : sub?.mode === 'replay' ? 'Replay'
    : !quote ? 'Awaiting quote' : age !== null && age > 45000 ? 'Stale quote'
    : age !== null && age > 3000 ? 'Quiet quote' : 'Live quote';
  const windowClick = (label: string, ms: number | null): void => {
    if (rendererRef.current?.setTimeWindowMs(ms)) {
      selectedWindow.current = ms;
      setSelected(label);
    }
  };
  return (
    <div className="market-strip" data-testid="market-strip">
      <dl className="market-strip__quotes">
        <div className="market-strip__last"><dt>Last trade</dt><dd data-testid="market-last">{fmt(last?.price)}</dd></div>
        <div className="market-strip__bid"><dt>Bid <span>{fmtSz(quote?.bidSz ?? 0)}</span></dt><dd data-testid="market-bid">{fmt(quote?.bidPx)}</dd></div>
        <div className="market-strip__ask"><dt>Ask <span>{fmtSz(quote?.askSz ?? 0)}</span></dt><dd data-testid="market-ask">{fmt(quote?.askPx)}</dd></div>
        <div><dt>Spread</dt><dd data-testid="market-spread">{fmt(quote ? quote.askPx - quote.bidPx : undefined)}</dd></div>
      </dl>
      <div className="market-strip__feed" data-quiet={age !== null && age > 3000} data-pending={status !== 'live'}
        title="Time since this app received a real inside quote. Quiet quotes are retained and labelled; generated chart frames do not reset this clock.">
        <span>{state}</span><span data-testid="market-quote-age">Quote age {quoteAgeText(quote?.receivedAtMs, Math.max(now, quote?.receivedAtMs ?? now))}</span>
      </div>
      <div className="market-strip__windows" role="group" aria-label="Chart time window">
        {WINDOWS.map(w => <button key={w.label} type="button" aria-pressed={selected === w.label}
          onClick={() => windowClick(w.label, w.ms)} title={w.ms === null ? 'Fit loaded history' : `Show up to ${w.label} of available history ending at the current chart position`}
          data-testid={`time-window-${w.label}`}>{w.label}</button>)}
      </div>
    </div>
  );
}
