import { useEffect, useRef, useState } from 'react';
import { MsgType, MODE_L2 } from '../proto/types';
import { TradeFlowAccumulator, type TradeFlowSummary } from '../state/tradeFlow';
import { getSnapshot, type BookSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { priceToRow, rowToPrice, scaleFromEpoch } from '../gl/priceScale';
import { fmtSz, priceDecimals } from './DomLadder';
import type { EpochParams } from '../proto/types';
import { useT } from '../i18n/useT';

export function nearbyDepth(snap: BookSnapshot, params: EpochParams | undefined): { bid: number; ask: number; low: number; high: number } | null {
  if (!params || !snap.book?.instant || snap.book.mode !== MODE_L2 || !snap.book.ask || !snap.bbo) return null;
  const scale = scaleFromEpoch(params);
  const center = Math.floor(priceToRow(scale, (snap.bbo.bidPx + snap.bbo.askPx) / 2));
  const lo = Math.max(0, center - 8), hi = Math.min(snap.book.bid.length - 1, center + 8);
  if (hi < lo) return null;
  let bid = 0, ask = 0;
  for (let row = lo; row <= hi; row++) { bid += snap.book.bid[row]; ask += snap.book.ask[row]; }
  return { bid, ask, low: rowToPrice(scale, lo - .5), high: rowToPrice(scale, hi + .5) };
}

export function OrderFlowPanel(): JSX.Element {
  const t = useT();
  const [seconds, setSeconds] = useState(30);
  const [flow, setFlow] = useState<TradeFlowSummary | null>(null);
  const [snap, setSnap] = useState(getSnapshot);
  const accumulator = useRef(new TradeFlowAccumulator());
  const sub = useFlowMapStore(s => s.subscription);
  const scope = `${sub?.market}:${sub?.symbol}:${sub?.mode}`;
  const mode = sub?.mode ?? 'live';
  const epochs = useFlowMapStore(s => s.epochs);
  const capability = useFlowMapStore(s => s.capability);
  const status = useFlowMapStore(s => s.status);
  useEffect(() => {
    const a = accumulator.current;
    a.reset(); setFlow(null);
    let lastSession = useFlowMapStore.getState().sessionId;
    let lastEpoch = useFlowMapStore.getState().gridEpoch;
    let lastStatus = useFlowMapStore.getState().status;
    const stateOff = useFlowMapStore.subscribe(s => {
      if (s.sessionId !== lastSession || s.gridEpoch !== lastEpoch ||
        (s.status === 'reconnecting' && lastStatus !== s.status)) { a.reset(); setFlow(null); }
      lastSession = s.sessionId; lastEpoch = s.gridEpoch; lastStatus = s.status;
    });
    const streamOff = useFlowMapStore.getState().onStream(msg => {
      // Replay seek changes the epoch without changing the subscription.
      if (msg.type === MsgType.MARKER && msg.kind === 'gap' && /seek/i.test(msg.text)) a.reset();
      a.ingest(msg, performance.now());
    });
    return () => { streamOff(); stateOff(); };
  }, [scope]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const a = accumulator.current;
      setFlow(a.summary(seconds * 1000, performance.now(), mode === 'replay'));
      setSnap(getSnapshot());
    }, 250);
    return () => window.clearInterval(id);
  }, [mode, seconds]);
  const params = epochs.get(snap.book?.epoch ?? -1);
  const depth = flow ? nearbyDepth(snap, params) : null;
  const known = flow ? flow.buy + flow.sell : 0;
  const buyShare = known > 0 && flow ? flow.buy / known * 100 : 50;
  const totalDepth = depth ? depth.bid + depth.ask : 0;
  const depthShare = depth && totalDepth > 0 ? depth.bid / totalDepth * 100 : 50;
  const warming = !flow || flow.coverageMs < seconds * 1000;
  const source = flow?.inferred ? t('desk.inferredSide') : flow?.exchange ? t('desk.exchangeSide') : t('desk.sideUnavailable');
  return <section className="panel flow-panel" data-testid="orderflow-panel">
    <header className="panel__header"><span className="panel__title">{t('desk.flow')}</span>
      <div className="desk-window" role="group" aria-label={t('desk.flowWindow')}>
        {[5, 30, 60].map(n => <button type="button" key={n} aria-pressed={seconds === n} onClick={() => {
          setSeconds(n); setFlow(accumulator.current.summary(n * 1000, performance.now(), mode === 'replay'));
        }}>{n}s</button>)}
      </div>
    </header>
    <div className="flow-panel__body">
      <div className="flow-panel__context"><span>{mode === 'replay' ? t('desk.replayFlow') : t('desk.receivedFlow')}</span><span>{status === 'live' ? source : t('desk.flowOffline')}</span></div>
      <div className="flow-panel__delta"><span>{t('desk.delta')}</span><strong data-testid="flow-delta" data-side={flow && flow.delta < 0 ? 'sell' : 'buy'}>{flow && known > 0 ? `${flow.delta < 0 ? '−' : flow.delta > 0 ? '+' : ''}${fmtSz(Math.abs(flow.delta))}` : '—'}</strong>
        <span>{warming ? `${t('desk.collecting')} ${((flow?.coverageMs ?? 0) / 1000).toFixed(0)}/${seconds}s` : `${flow?.count ?? 0} ${t('desk.prints')}`}</span></div>
      <div className="flow-panel__balance" role="img" aria-label={`${t('desk.buyShare')} ${buyShare.toFixed(0)}%`}><span style={{ width: `${buyShare}%` }} /></div>
      <dl className="flow-panel__facts">
        <div><dt>{t('desk.buyVolume')}</dt><dd className="is-buy" data-testid="flow-buy">{flow ? fmtSz(flow.buy) : '—'}</dd></div>
        <div><dt>{t('desk.sellVolume')}</dt><dd className="is-sell" data-testid="flow-sell">{flow ? fmtSz(flow.sell) : '—'}</dd></div>
        <div><dt>{t('desk.prints')}</dt><dd data-testid="flow-count">{flow?.count.toLocaleString() ?? '—'}</dd></div>
        <div><dt>{t('desk.printRate')}</dt><dd>{flow && !warming ? (flow.count / seconds).toFixed(1) : '—'}</dd></div>
        {flow && flow.unknown > 0 && <div className="flow-panel__unknown"><dt>{t('desk.unknownVolume')}</dt><dd>{fmtSz(flow.unknown)}</dd></div>}
      </dl>
      <div className="flow-panel__depth"><span>{t('desk.nearbyDepth')}</span><span>{depth && params ? `${depth.low.toFixed(priceDecimals(params.tick))}–${depth.high.toFixed(priceDecimals(params.tick))}` : t('desk.depthUnavailable')}</span></div>
      {depth && <><div className="flow-panel__balance flow-panel__balance--depth"><span style={{ width: `${depthShare}%` }} /></div>
        <div className="flow-panel__depth-values"><span className="is-buy">{fmtSz(depth.bid)}</span><span>{depthShare.toFixed(0)}% {t('desk.bidShare')}</span><span className="is-sell">{fmtSz(depth.ask)}</span></div></>}
      {capability?.tape !== 'tick' && <div className="flow-panel__note">{t('desk.sampledTape')}</div>}
    </div>
  </section>;
}
