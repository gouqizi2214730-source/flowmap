import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PREVIEW_QUOTES_KEY, PreviewQuotes, type PreviewQuote } from './previewQuotes';
import { BUNDLED_DIRECTORY } from './bundledDirectory';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
const instances: PreviewQuotes[] = [];

function quote(symbol = 'AAPL', price = 120, asOf?: number): PreviewQuote {
  return { market: 'equity', symbol, price, changePct: 1.2, spark: [118, 119, price],
    ...(asOf === undefined ? {} : { asOf }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let n = 0; n < 6; n++) await Promise.resolve();
}

function make(fetchQuote = vi.fn<(_market: string, _symbol: string, _signal: AbortSignal) => Promise<PreviewQuote | null>>(
  async (_market, symbol) => quote(symbol)), storage: Storage | null = localStorage) {
  const onChange = vi.fn();
  const cache = new PreviewQuotes({ storage, fetchQuote, onChange });
  instances.push(cache);
  return { cache, fetchQuote, onChange };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.useRealTimers(); vi.restoreAllMocks();
});

it('hydrates real observations synchronously as stale without fetching or notifying', async () => {
  const asOf = 1_799_999_000_000_000_000;
  localStorage.setItem(PREVIEW_QUOTES_KEY, JSON.stringify({ version: 1,
    entries: [{ quote: quote('AAPL', 120, asOf), fetchedAt: NOW - 1_000, requestedAt: NOW - 1_100 }] }));
  const { cache, fetchQuote, onChange } = make();
  expect(cache.get('equity:AAPL')).toEqual({ ...quote('AAPL', 120, asOf), stale: true });
  expect(fetchQuote).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
  cache.request('equity', 'AAPL');
  await settle();
  expect(fetchQuote).toHaveBeenCalledOnce();
  expect(cache.get('equity:AAPL')?.stale).not.toBe(true);
});

it('ignores corrupt, expired, malformed and fake empty persisted entries', () => {
  localStorage.setItem(PREVIEW_QUOTES_KEY, '{broken');
  expect(make().cache.get('equity:AAPL')).toBeUndefined();
  localStorage.setItem(PREVIEW_QUOTES_KEY, JSON.stringify({ version: 1, entries: [
    { quote: quote('OLD'), fetchedAt: NOW - 7 * DAY - 1 },
    { quote: quote('FUTURE'), fetchedAt: NOW + DAY },
    { quote: { ...quote('ZERO'), price: 0 }, fetchedAt: NOW },
    { quote: { ...quote('EMPTY'), price: null, spark: [], reachable: false }, fetchedAt: NOW },
    { quote: quote('OK'), fetchedAt: NOW - DAY },
  ] }));
  const { cache } = make();
  for (const symbol of ['OLD', 'FUTURE', 'ZERO', 'EMPTY']) expect(cache.get(`equity:${symbol}`)).toBeUndefined();
  expect(cache.get('equity:OK')?.stale).toBe(true);
});

it('limits active fetches to three and coalesces repeated requests for each key', async () => {
  const waits = new Map<string, ReturnType<typeof deferred<PreviewQuote | null>>>();
  const fetchQuote = vi.fn((_market: string, symbol: string, _signal: AbortSignal) => {
    const wait = deferred<PreviewQuote | null>(); waits.set(symbol, wait); return wait.promise;
  });
  const { cache } = make(fetchQuote);
  for (const symbol of ['A', 'B', 'C', 'D', 'E', 'F']) cache.request('equity', symbol);
  for (let n = 0; n < 10; n++) cache.request('equity', 'A', true);
  await settle();
  expect(fetchQuote.mock.calls.map(call => call[1])).toEqual(['A', 'B', 'C']);
  waits.get('B')!.resolve(quote('B')); await settle();
  expect(fetchQuote.mock.calls.map(call => call[1])).toEqual(['A', 'B', 'C', 'D']);
  expect(cache.get('equity:B')?.price).toBe(120);
});

it('promotes a queued active-row request without starting duplicate work', async () => {
  const waits = new Map<string, ReturnType<typeof deferred<PreviewQuote | null>>>();
  const fetchQuote = vi.fn((_market: string, symbol: string, _signal: AbortSignal) => {
    const wait = deferred<PreviewQuote | null>(); waits.set(symbol, wait); return wait.promise;
  });
  const { cache } = make(fetchQuote);
  for (const symbol of ['A', 'B', 'C', 'D', 'E']) cache.request('equity', symbol);
  cache.request('equity', 'E', true); cache.request('equity', 'E', true);
  await settle(); waits.get('A')!.resolve(quote('A')); await settle();
  expect(fetchQuote.mock.calls.map(call => call[1])).toEqual(['A', 'B', 'C', 'E']);
});

it('bounds pending work at 32 and gives a new active row room ahead of background work', async () => {
  const waits = new Map<string, ReturnType<typeof deferred<PreviewQuote | null>>>();
  const fetchQuote = vi.fn((_market: string, symbol: string, _signal: AbortSignal) => {
    const wait = deferred<PreviewQuote | null>(); waits.set(symbol, wait); return wait.promise;
  });
  const { cache } = make(fetchQuote);
  for (let n = 0; n < 100; n++) cache.request('equity', `S${n}`);
  cache.request('equity', 'HOVER', true);
  await settle();
  waits.get('S0')!.resolve(quote('S0')); await settle();
  expect(fetchQuote.mock.calls[3][1]).toBe('HOVER');
  const done = new Set<string>(['S0']);
  for (let n = 0; n < 40; n++) {
    for (const [symbol, wait] of waits) if (!done.has(symbol)) {
      done.add(symbol); wait.resolve(quote(symbol));
    }
    await settle();
  }
  expect(fetchQuote).toHaveBeenCalledTimes(35); // three active + 32 queued
  expect(fetchQuote.mock.calls.some(call => call[1] === 'S34')).toBe(false);
});

it('serves a usable quote immediately and refreshes only after 15 seconds', async () => {
  const { cache, fetchQuote } = make();
  cache.put({ ...quote(), stale: true }); // a freshly polled closed-market quote
  cache.request('equity', 'AAPL'); await settle();
  expect(fetchQuote).not.toHaveBeenCalled(); expect(cache.get('equity:AAPL')?.price).toBe(120);
  vi.advanceTimersByTime(15_000);
  expect(cache.get('equity:AAPL')?.stale).toBe(true);
  cache.request('equity', 'AAPL'); await settle();
  expect(fetchQuote).toHaveBeenCalledOnce();
});

it('retains good history on failure, marks it stale and applies a five-second cooldown', async () => {
  const fetchQuote = vi.fn<(_market: string, _symbol: string, _signal: AbortSignal) => Promise<PreviewQuote | null>>()
    .mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue(quote('AAPL', 122));
  const { cache } = make(fetchQuote);
  cache.put(quote('AAPL', 120, 100));
  vi.advanceTimersByTime(15_000); cache.request('equity', 'AAPL'); await settle();
  expect(cache.get('equity:AAPL')).toEqual({ ...quote('AAPL', 120, 100), stale: true });
  cache.request('equity', 'AAPL'); vi.advanceTimersByTime(4_999); cache.request('equity', 'AAPL'); await settle();
  expect(fetchQuote).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1); cache.request('equity', 'AAPL'); await settle();
  expect(fetchQuote).toHaveBeenCalledTimes(2); expect(cache.get('equity:AAPL')?.price).toBe(122);
});

it('returns a short-lived unavailable result without persisting fake empty prices', async () => {
  const { cache, fetchQuote } = make(vi.fn(async () => null));
  cache.request('equity', 'AAPL'); await settle();
  expect(cache.get('equity:AAPL')).toEqual({ market: 'equity', symbol: 'AAPL', price: null,
    changePct: null, spark: [], stale: true, reachable: false });
  cache.request('equity', 'AAPL'); await settle(); expect(fetchQuote).toHaveBeenCalledOnce();
  cache.dispose(); expect(localStorage.getItem(PREVIEW_QUOTES_KEY)).toBeNull();
  cache.resume(); vi.advanceTimersByTime(5_000); cache.request('equity', 'AAPL'); await settle();
  expect(fetchQuote).toHaveBeenCalledTimes(2);
});

it('retains real server fallback prices when refresh is unreachable, including the first client fetch', async () => {
  const lastGood = { ...quote('AAPL', 120, 400), reachable: false, stale: true };
  const { cache, fetchQuote } = make(vi.fn(async () => lastGood));
  cache.request('equity', 'AAPL'); await settle();
  expect(cache.get('equity:AAPL')).toEqual(lastGood);
  cache.request('equity', 'AAPL'); await settle(); expect(fetchQuote).toHaveBeenCalledOnce();
  cache.dispose();
  const restored = make().cache;
  expect(restored.get('equity:AAPL')).toEqual(lastGood);
  cache.resume(); vi.advanceTimersByTime(5_000); cache.request('equity', 'AAPL'); await settle();
  expect(fetchQuote).toHaveBeenCalledTimes(2);
});

it('requires exact response identity and rejects invalid prices while filtering invalid spark points', async () => {
  const fetchQuote = vi.fn<(_market: string, _symbol: string, _signal: AbortSignal) => Promise<PreviewQuote | null>>()
    .mockResolvedValueOnce(quote('MSFT'))
    .mockResolvedValueOnce({ ...quote('BAD'), price: Number.NaN });
  const { cache } = make(fetchQuote);
  cache.request('equity', 'AAPL'); cache.request('equity', 'BAD'); await settle();
  expect(cache.get('equity:AAPL')?.reachable).toBe(false);
  expect(cache.get('equity:MSFT')).toBeUndefined(); expect(cache.get('equity:BAD')?.reachable).toBe(false);
  cache.put({ ...quote('GOOD'), spark: [-1, NaN, Infinity, 0, 1, 2], changePct: Infinity });
  expect(cache.get('equity:GOOD')).toMatchObject({ price: 120, spark: [1, 2], changePct: null });
  cache.put({ ...quote('GOOD'), price: 0 });
  expect(cache.get('equity:GOOD')?.price).toBe(120);
});

it('uses source time first and request start second to reject older late answers', () => {
  const { cache } = make();
  cache.put(quote('AAPL', 125, 300), NOW - 100);
  cache.put(quote('AAPL', 120, 200), NOW); // late mover with an older source
  expect(cache.get('equity:AAPL')?.price).toBe(125);
  cache.put(quote('AAPL', 121, 300), NOW - 200); // same source, older request
  expect(cache.get('equity:AAPL')?.price).toBe(125);
  cache.put(quote('AAPL', 126, 400), NOW - 200); // genuinely newer source wins
  expect(cache.get('equity:AAPL')).toMatchObject({ price: 126, asOf: 400 });
  cache.put(quote('MSFT', 200), NOW);
  cache.put(quote('MSFT', 190), NOW - 1);
  expect(cache.get('equity:MSFT')?.price).toBe(200);
});

it('does not let an old in-flight failure dirty a later successful quote', async () => {
  const wait = deferred<PreviewQuote | null>();
  const { cache } = make(vi.fn(() => wait.promise));
  cache.request('equity', 'AAPL'); await settle();
  vi.advanceTimersByTime(10); cache.put(quote('AAPL', 130));
  wait.reject(new Error('old failure')); await settle();
  expect(cache.get('equity:AAPL')).toEqual(quote('AAPL', 130));
});

it('times out stalled work after six seconds, drains the queue and ignores its late result', async () => {
  const waits = new Map<string, ReturnType<typeof deferred<PreviewQuote | null>>>();
  const signals = new Map<string, AbortSignal>();
  const fetchQuote = vi.fn((_market: string, symbol: string, signal: AbortSignal) => {
    const wait = deferred<PreviewQuote | null>(); waits.set(symbol, wait); signals.set(symbol, signal); return wait.promise;
  });
  const { cache } = make(fetchQuote);
  for (const symbol of ['A', 'B', 'C', 'D']) cache.request('equity', symbol);
  await settle(); vi.advanceTimersByTime(6_000); await settle();
  expect(signals.get('A')?.aborted).toBe(true); expect(signals.get('D')?.aborted).toBe(false);
  expect(fetchQuote).toHaveBeenCalledTimes(4);
  waits.get('A')!.resolve(quote('A', 999)); await settle();
  expect(cache.get('equity:A')?.reachable).toBe(false);
});

it('aborts on disposal without failure notifications and resumes useful work after StrictMode cleanup', async () => {
  const first = deferred<PreviewQuote | null>(), second = deferred<PreviewQuote | null>();
  const signals: AbortSignal[] = [];
  const fetchQuote = vi.fn((_market: string, _symbol: string, signal: AbortSignal) => {
    signals.push(signal); return signals.length === 1 ? first.promise : second.promise;
  });
  const { cache, onChange } = make(fetchQuote);
  cache.request('equity', 'AAPL'); await settle(); cache.dispose();
  expect(signals[0].aborted).toBe(true); expect(onChange).not.toHaveBeenCalled();
  first.resolve(quote('AAPL', 999)); await settle(); expect(cache.get('equity:AAPL')).toBeUndefined();
  cache.resume(); await settle(); expect(fetchQuote).toHaveBeenCalledTimes(2);
  second.resolve(quote('AAPL', 125)); await settle();
  expect(cache.get('equity:AAPL')?.price).toBe(125); expect(onChange).toHaveBeenCalledOnce();
});

it('caps cache entries at 512, spark history at 64, and removes seven-day-old observations', () => {
  const { cache } = make();
  for (let n = 0; n < 514; n++) cache.put({ ...quote(`S${n}`), spark: Array.from({ length: 100 }, (_, k) => k + 1) });
  expect(cache.get('equity:S0')).toBeUndefined(); expect(cache.get('equity:S1')).toBeUndefined();
  expect(cache.get('equity:S513')?.spark).toEqual(Array.from({ length: 64 }, (_, k) => k + 37));
  cache.dispose();
  expect(JSON.parse(localStorage.getItem(PREVIEW_QUOTES_KEY)!).entries).toHaveLength(512);
  vi.setSystemTime(NOW + 7 * DAY + 1);
  expect(cache.get('equity:S513')).toBeUndefined();
});

it('uses explicit requests for retention while directory-render reads stay passive', () => {
  const { cache } = make();
  for (let n = 0; n < 512; n++) cache.put(quote(`S${n}`));
  cache.request('equity', 'S0'); // actively selected fresh quote; no network
  for (let n = 0; n < 512; n++) cache.get(`equity:S${n}`); // render all rows
  cache.put(quote('NEW'));
  expect(cache.get('equity:S0')?.price).toBe(120);
  expect(cache.get('equity:S1')).toBeUndefined();
});

it('restores real charts for the entire 260-symbol directory before any HTTP request', () => {
  expect(BUNDLED_DIRECTORY).toHaveLength(260);
  const observations = BUNDLED_DIRECTORY.map((entry, index) => ({
    market: entry.market, symbol: entry.symbol, price: index + 1, changePct: index / 10,
    spark: [index + .5, index + 1, index + 1.5], asOf: NOW * 1e6,
  }));
  const { cache } = make();
  for (const observation of observations) cache.put(observation);
  cache.put(quote('CUSTOM')); // custom picks must not evict the start of the catalogue
  cache.dispose();
  const restored = make();
  for (const observation of observations) {
    expect(restored.cache.get(`${observation.market}:${observation.symbol}`))
      .toEqual({ ...observation, stale: true });
  }
  expect(restored.cache.get('binance-spot:BTCUSDT')?.spark).toEqual(observations[0].spark);
  expect(restored.cache.get('equity:GLD')?.spark).toEqual(observations.at(-1)!.spark);
  expect(restored.cache.get('equity:CUSTOM')?.price).toBe(120);
  expect(restored.fetchQuote).not.toHaveBeenCalled();
  expect(restored.onChange).not.toHaveBeenCalled();
});

it('round-trips all 512 entries even when valid float precision and escaped symbols exceed one MB', () => {
  const { cache } = make();
  const decimal = .0000010000000000000002;
  const keys: string[] = [];
  for (let n = 0; n < 512; n++) {
    const symbol = String(n).padEnd(128, '"');
    const market = 'm'.repeat(64);
    keys.push(`${market}:${symbol}`);
    cache.put({ market, symbol, price: decimal, changePct: -decimal,
      spark: Array(64).fill(decimal), asOf: Number.MAX_VALUE, stale: true, reachable: false }, Number.MAX_VALUE);
  }
  cache.dispose();
  const raw = localStorage.getItem(PREVIEW_QUOTES_KEY)!;
  expect(raw.length).toBeGreaterThan(1_000_000);
  expect(raw.length).toBeLessThan(2_000_000);
  const restored = make();
  for (const key of keys) expect(restored.cache.get(key)?.spark).toEqual(Array(64).fill(decimal));
  expect(restored.fetchQuote).not.toHaveBeenCalled();
});

it('coalesces persistence for 100 ms and flushes useful observations on dispose', () => {
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  const { cache } = make();
  cache.put(quote('A')); cache.put(quote('B')); cache.put(quote('C'));
  expect(writes).not.toHaveBeenCalled(); vi.advanceTimersByTime(99); expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(writes).toHaveBeenCalledOnce();
  cache.put(quote('D')); cache.dispose(); expect(writes).toHaveBeenCalledTimes(2);
  expect(JSON.parse(localStorage.getItem(PREVIEW_QUOTES_KEY)!).entries).toHaveLength(4);
});

it('never throws when optional storage cannot be read or written', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } } as unknown as Storage;
  const { cache } = make(undefined, broken);
  expect(() => { cache.put(quote()); cache.dispose(); }).not.toThrow();
  expect(cache.get('equity:AAPL')?.price).toBe(120);
});
