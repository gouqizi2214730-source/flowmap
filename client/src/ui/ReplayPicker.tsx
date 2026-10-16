import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiBase } from '../net/serverBase';
import { useT } from '../i18n/useT';
import { isTopOverlay, pushOverlay } from './overlayStack';
import './ReplayPicker.css';

interface Availability {
  hours: string[];
  latest_column_ns: string | null;
  max_columns: number;
}
interface WindowPreview {
  start_ns: string;
  end_ns: string;
  columns: number;
}

export function localDateTime(ns: bigint): string {
  const date = new Date(Number(ns / 1_000_000n));
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 23);
}

export function utcDateTime(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 23);
}

export function utcDateTimeNs(value: string): bigint | null {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value);
  if (!match || Number(match[1]) < 1) return null;
  const ms = new Date(value + 'Z').getTime();
  if (!Number.isFinite(ms)) return null;
  const ns = BigInt(ms) * 1_000_000n;
  const normalized = value.length === 16 ? value + ':00.000' :
    value.length === 19 ? value + '.000' : value.padEnd(23, '0');
  return utcDateTime(ns) === normalized ? ns : null;
}

// Keep API-selected nanoseconds exact; manual UTC edits have millisecond precision.
const rangeInput = (ns: bigint): { value: string; ns: bigint } => ({ value: utcDateTime(ns), ns });
const manualInput = (value: string): { value: string; ns: bigint | null } => ({ value, ns: utcDateTimeNs(value) });
function localReadout(ns: bigint | null): string {
  return ns === null ? '—' : new Date(Number(ns / 1_000_000n)).toLocaleString(undefined, { timeZoneName: 'short' });
}

function utc(ns: bigint | null): string {
  return ns === null ? '—' : new Date(Number(ns / 1_000_000n)).toISOString();
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { signal });
  const data = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(data.detail ?? `${response.status}`);
  return data;
}

export function ReplayPicker({ market, symbol, onClose, onConfirm }: {
  market: string; symbol: string; onClose: () => void;
  onConfirm: (startNs: bigint, endNs: bigint) => void;
}): JSX.Element {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [start, setStart] = useState(manualInput(''));
  const [end, setEnd] = useState(manualInput(''));
  const [minutes, setMinutes] = useState(5);
  const [preview, setPreview] = useState<WindowPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const startNs = start.ns, endNs = end.ns;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const query = `market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`;
  useEffect(() => pushOverlay('replay-picker'), []);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && isTopOverlay('replay-picker')) {
        e.preventDefault(); onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { request.current?.abort(); opener?.focus(); };
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    request.current?.abort();
    request.current = ctrl;
    setBusy(true); setError(''); setPreview(null);
    void readJson<Availability>(`/api/recordings/availability?${query}`, ctrl.signal).then((a) => {
      if (ctrl.signal.aborted) return;
      setAvailability(a);
      if (a.latest_column_ns !== null) {
        const latest = BigInt(a.latest_column_ns);
        setEnd(rangeInput(latest + 1_000_000_000n));
        setStart(rangeInput(latest - 300_000_000_000n));
      }
    }).catch((e: unknown) => {
      if (!ctrl.signal.aborted) setError(String(e instanceof Error ? e.message : e));
    }).finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
    return () => ctrl.abort();
  }, [query, refresh]);

  const changeRange = (nextStart: typeof start, nextEnd: typeof end): void => {
    request.current?.abort(); setBusy(false); setStart(nextStart); setEnd(nextEnd); setPreview(null); setError('');
  };
  const preset = (duration: number, anchor = endNs): void => {
    setMinutes(duration);
    if (anchor !== null) changeRange(rangeInput(anchor - BigInt(duration) * 60_000_000_000n), rangeInput(anchor));
  };
  const checkWindow = async (): Promise<void> => {
    if (startNs === null || endNs === null || endNs <= startNs) { setError(t('replayPicker.invalid')); return; }
    const ctrl = new AbortController(); request.current?.abort(); request.current = ctrl;
    setBusy(true); setError('');
    try {
      const p = await readJson<WindowPreview>(`/api/recordings/window?${query}&start_ns=${startNs}&end_ns=${endNs}`, ctrl.signal);
      if (!ctrl.signal.aborted) setPreview(p);
    } catch (e) { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (!ctrl.signal.aborted) setBusy(false); }
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!isTopOverlay('replay-picker')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    if (e.key !== 'Tab') return;
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return createPortal(<div className="replay-picker__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} className="replay-picker" role="dialog" aria-modal="true" aria-labelledby="replay-picker-title" onKeyDown={onKeyDown}>
      <header><h2 id="replay-picker-title">{t('replayPicker.title')} · {market} / {symbol}</h2>
        <button ref={close} type="button" onClick={onClose} aria-label={t('replayPicker.cancel')}>×</button></header>
      <p>{t('replayPicker.zone')} <strong>{zone}</strong> · {t('replayPicker.buckets')}</p>
      {busy && <p role="status">{t('replayPicker.loading')}</p>}
      {availability && availability.hours.length === 0 && <p role="status">{t('replayPicker.empty')}</p>}
      {availability && availability.hours.length > 0 && <>
        <label>{t('replayPicker.hours')}<select aria-label={t('replayPicker.hours')} value="" onChange={(e) => {
          if (!e.target.value) return;
          const hour = BigInt(e.target.value);
          changeRange(rangeInput(hour), rangeInput(hour + BigInt(minutes) * 60_000_000_000n));
        }}><option value="">{t('replayPicker.chooseHour')}</option>
          {availability.hours.map((h) => <option key={h} value={h}>{localDateTime(BigInt(h)).slice(0, 16).replace('T', ' ')} ({utc(BigInt(h))})</option>)}
        </select></label>
        <div className="replay-picker__presets">{[1, 5, 15].map((m) => <button type="button" key={m} aria-pressed={minutes === m} onClick={() => preset(m)}>{m} min</button>)}</div>
        <label>{t('replayPicker.start')} (UTC)<input type="datetime-local" step="0.001" value={start.value} onChange={(e) => changeRange(manualInput(e.target.value), end)} /></label>
        <small>{zone}: {localReadout(startNs)}</small>
        <label>{t('replayPicker.end')} (UTC)<input type="datetime-local" step="0.001" value={end.value} onChange={(e) => changeRange(start, manualInput(e.target.value))} /></label>
        <small>{zone}: {localReadout(endNs)} · [start, end)</small>
        <p>{t('replayPicker.limit')} {availability.max_columns.toLocaleString()} {t('replayPicker.columns')}</p>
      </>}
      {error && <p className="replay-picker__error" role="alert">{error}</p>}
      {preview && <p role="status">{t('replayPicker.effective')} {utc(BigInt(preview.start_ns))} → {utc(BigInt(preview.end_ns))} · {preview.columns} {t('replayPicker.columns')}<br />{t('replayPicker.provenance')}</p>}
      <footer><button type="button" onClick={onClose}>{t('replayPicker.cancel')}</button>
        <button type="button" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>{t('replayPicker.refresh')}</button>
        {preview ? <button type="button" disabled={busy || startNs === null || endNs === null} onClick={() => {
          if (startNs !== null && endNs !== null) onConfirm(startNs, endNs);
        }}>{t('replayPicker.open')}</button> : <button type="button" disabled={busy || !availability?.hours.length} onClick={() => { void checkWindow(); }}>{t('replayPicker.check')}</button>}
      </footer>
    </div>
  </div>, document.body);
}
