import { useEffect, useState, type RefObject } from 'react';
import type { Renderer } from '../gl/renderer';
import type { OverlayVisibility } from '../gl/overlays/frame';
import { useT } from '../i18n/useT';
import { useFlowMapStore } from '../state/store';
import type { DeskLayout } from './deskPreferences';
import { DEPTH_CHANNELS, type FlowMapSettings } from './settings';

interface Props { rendererRef: RefObject<Renderer | null>; settings: FlowMapSettings; layout: DeskLayout;
  onLayout: (layout: DeskLayout) => void; onChange: (patch: Partial<FlowMapSettings>) => void;
  onTrack: () => void; onFit: () => void }
export function DeskToolbar({ rendererRef, settings, layout, onLayout, onChange, onTrack, onFit }: Props): JSX.Element {
  const t = useT();
  const [following, setFollowing] = useState(true);
  const [tracking, setTracking] = useState(true);
  const [fps, setFps] = useState<number | null>(null);
  const [history, setHistory] = useState('');
  const mode = useFlowMapStore(s => s.subscription?.mode ?? 'live');
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      setFollowing(r.following); setTracking(r.priceFollow !== 'off');
      const rate = r.stats().fps; setFps(Number.isFinite(rate) && rate > 0 ? Math.round(rate) : null);
      const overview = r.overviewStats?.();
      setHistory(overview?.error ? t('desk.historyRetry') : overview && overview.progress.loaded < overview.progress.total
        ? `${t('desk.historyLoading')} ${overview.progress.loaded}/${overview.progress.total}` : '');
    }, 500);
    return () => window.clearInterval(id);
  }, [rendererRef, t]);
  const overlays: [keyof OverlayVisibility, string][] = [['bubbles', 'desk.bubbles'], ['volume', 'desk.volume'], ['cvd', 'desk.cvd'], ['profile', 'desk.liquidityProfile']];
  return <div className="desk-toolbar" data-testid="desk-toolbar">
    <div className="desk-toolbar__group desk-toolbar__layout" role="group" aria-label={t('desk.layout')}>
      {(['orderflow', 'analysis', 'focus'] as const).map(k => <button type="button" key={k} aria-pressed={layout === k}
        onClick={() => onLayout(k)} data-testid={`desk-layout-${k}`}>{t(`desk.${k}`)}</button>)}
    </div>
    <label className="desk-channel"><span>{t('desk.liquidity')}</span><select value={settings.depthChannel} aria-label={t('desk.channel')}
      onChange={e => onChange({ depthChannel: e.target.value as FlowMapSettings['depthChannel'] })}>
      {DEPTH_CHANNELS.map(k => <option key={k} value={k}>{t(`desk.channel.${k}`)}</option>)}
    </select></label>
    <div className="desk-toolbar__group" role="group" aria-label={t('desk.layers')}>
      {overlays.map(([k, name]) => <button type="button" key={k} aria-pressed={Boolean(settings.overlays[k])}
        title={k === 'profile' ? t('desk.profileHint') : undefined}
        onClick={() => onChange({ overlays: { ...settings.overlays, [k]: !settings.overlays[k] } })}
        data-testid={`desk-layer-${k}`}>{t(name)}</button>)}
    </div>
    <div className="desk-toolbar__group desk-toolbar__navigation">
      <button type="button" aria-pressed={following} onClick={() => onChange({ follow: !following })} data-testid="desk-follow">{t('desk.follow')}</button>
      <button type="button" aria-pressed={tracking} onClick={() => tracking ? onChange({ followPrice: false }) : onTrack()} data-testid="desk-track">{t('desk.track')}</button>
      <button type="button" onClick={onFit} data-testid="desk-fit">{t('desk.fit')}</button>
    </div>
    {history && <span className="desk-toolbar__history" role="status" data-testid="history-loading">{history}</span>}
    <span className="desk-toolbar__performance" data-mode={mode} title={t('desk.fpsHint')}>{fps === null ? '—' : fps} FPS</span>
  </div>;
}
