/** Bounded quote enrichment for the symbol picker. Cached observations are
 * available synchronously; network latency never owns symbol selection. */
export interface PreviewQuote {
  market: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  spark: number[];
  asOf?: number;
  stale?: boolean;
  reachable?: boolean;
}

export const PREVIEW_QUOTES_KEY = 'flowmap.preview-quotes.v1';
const CAPACITY = 128;
const MAX_SPARK = 64;
const FRESH_MS = 15_000;
const FAILURE_MS = 5_000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1_000;
const TIMEOUT_MS = 6_000;
const MAX_ACTIVE = 3;
const MAX_PENDING = 32;

interface Options {
  storage: Storage | null;
  fetchQuote: (market: string, symbol: string, signal: AbortSignal) => Promise<PreviewQuote | null>;
  onChange: () => void;
  now?: () => number;
}

interface Entry {
  quote: PreviewQuote;
  fetchedAt: number;
  requestedAt: number;
  restored: boolean;
  failed: boolean;
  retryAt: number;
}

interface Task { key: string; market: string; symbol: string; priority: boolean }
interface Active {
  task: Task;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  requestedAt: number;
}

function identity(market: unknown, symbol: unknown): string | null {
  return typeof market === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(market)
    && typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 128 && !/[\x00-\x1f\x7f]/.test(symbol)
    ? `${market}:${symbol}` : null;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Keep only real finite observations, and bound provider/persisted payloads. */
function clean(value: unknown): PreviewQuote | null {
  if (!value || typeof value !== 'object') return null;
  const q = value as PreviewQuote;
  if (identity(q.market, q.symbol) === null || !Array.isArray(q.spark)) return null;
  if (q.price !== null && (typeof q.price !== 'number' || !Number.isFinite(q.price) || q.price <= 0)) return null;
  const spark = q.spark.filter(point => typeof point === 'number' && Number.isFinite(point) && point > 0).slice(-MAX_SPARK);
  return { market: q.market, symbol: q.symbol, price: q.price,
    changePct: typeof q.changePct === 'number' && Number.isFinite(q.changePct) ? q.changePct : null,
    spark, ...(validTime(q.asOf) && q.asOf > 0 ? { asOf: q.asOf } : {}),
    ...(q.reachable === false ? { stale: true } : typeof q.stale === 'boolean' ? { stale: q.stale } : {}),
    ...(typeof q.reachable === 'boolean' ? { reachable: q.reachable } : {}) };
}

function usable(quote: PreviewQuote): boolean {
  // A provider refresh can fail while returning its genuine last-good chart.
  // Reachability describes the refresh, not whether those observations exist.
  return quote.price !== null || quote.spark.length > 0;
}

function newer(quote: PreviewQuote, requestedAt: number, previous: Entry): boolean {
  const oldSource = previous.quote.asOf, source = quote.asOf;
  if (source !== undefined && oldSource !== undefined && source !== oldSource) return source > oldSource;
  return requestedAt >= previous.requestedAt;
}

export class PreviewQuotes {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, Active>();
  private readonly pending: Task[] = [];
  private readonly now: () => number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistNeeded = false;
  private paused = false;
  private changePending = false;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.hydrate(); // no fetch, timers, writes or callbacks during construction
  }

  get(key: string): PreviewQuote | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = this.now() - entry.fetchedAt;
    if (age > RETAIN_MS) {
      this.entries.delete(key);
      this.schedulePersist();
      return undefined;
    }
    if ((entry.restored || entry.failed || age >= FRESH_MS) && !entry.quote.stale) {
      entry.quote = { ...entry.quote, stale: true };
    }
    return entry.quote;
  }

  put(value: PreviewQuote, requestedAt = this.now()): void {
    const quote = clean(value);
    if (!quote || !validTime(requestedAt)) return;
    const key = identity(quote.market, quote.symbol)!;
    const previous = this.entries.get(key);
    if (previous && !newer(quote, requestedAt, previous)) return;
    if (!usable(quote)) {
      this.failure(key, quote.market, quote.symbol, requestedAt);
      return;
    }
    const failed = quote.reachable === false;
    this.setEntry(key, { quote, fetchedAt: this.now(), requestedAt,
      restored: false, failed, retryAt: failed ? this.now() + FAILURE_MS : 0 });
    this.schedulePersist();
    this.changed();
  }

  request(market: string, symbol: string, priority = false): void {
    const key = identity(market, symbol);
    if (key === null) return;
    const existing = this.entries.get(key);
    // Explicit interest owns retention. Rendering every directory row calls
    // get(), which must not turn list order into a false usage/LRU signal.
    if (existing) { this.entries.delete(key); this.entries.set(key, existing); }
    if (this.active.has(key)) return;
    if (existing && this.now() < existing.retryAt) return;
    // Source-stale observations can still be a freshly polled closed market.
    // Refresh cadence follows successful receipt, not the market-open clock.
    if (existing && !existing.restored && !existing.failed
      && this.now() - existing.fetchedAt < FRESH_MS) return;
    const queued = this.pending.findIndex(task => task.key === key);
    if (queued >= 0) {
      if (priority) {
        const [task] = this.pending.splice(queued, 1);
        task.priority = true; this.pending.unshift(task);
      }
    } else {
      if (this.pending.length >= MAX_PENDING) {
        if (!priority) return;
        this.pending.pop();
      }
      const task = { key, market, symbol, priority };
      if (priority) this.pending.unshift(task); else this.pending.push(task);
    }
    this.drain();
  }

  /** Reusable after React StrictMode's effect cleanup/setup cycle. */
  resume(): void {
    this.paused = false;
    if (this.changePending) this.changed();
    if (this.persistNeeded) this.schedulePersist();
    this.drain();
  }

  dispose(): void {
    this.paused = true;
    const restart = [...this.active.values()].map(work => work.task);
    for (const work of this.active.values()) {
      clearTimeout(work.timer);
      work.controller.abort();
    }
    // Remove ownership before an aborted promise can settle. Useful requests
    // restart on resume, and late responses from this generation are ignored.
    this.active.clear();
    this.pending.unshift(...restart);
    this.pending.splice(MAX_PENDING);
    this.flushPersist();
  }

  private drain(): void {
    while (!this.paused && this.active.size < MAX_ACTIVE && this.pending.length > 0) {
      const task = this.pending.shift()!;
      const entry = this.entries.get(task.key);
      if (entry && (this.now() < entry.retryAt || (!entry.restored && !entry.failed
        && this.now() - entry.fetchedAt < FRESH_MS))) continue;
      const controller = new AbortController();
      const work: Active = { task, controller, requestedAt: this.now(),
        timer: setTimeout(() => {
          if (this.active.get(task.key) !== work) return;
          controller.abort();
          this.complete(work, null);
        }, TIMEOUT_MS) };
      this.active.set(task.key, work);
      void Promise.resolve().then(() => {
        if (this.active.get(task.key) !== work) return null;
        return this.options.fetchQuote(task.market, task.symbol, controller.signal);
      }).then(quote => this.complete(work, quote), () => this.complete(work, null));
    }
  }

  private complete(work: Active, value: PreviewQuote | null): void {
    const { key, market, symbol } = work.task;
    if (this.active.get(key) !== work) return;
    clearTimeout(work.timer);
    this.active.delete(key);
    const quote = clean(value);
    if (quote && identity(quote.market, quote.symbol) === key && usable(quote)) this.put(quote, work.requestedAt);
    else this.failure(key, market, symbol, work.requestedAt);
    this.drain();
  }

  private failure(key: string, market: string, symbol: string, requestedAt: number): void {
    const previous = this.entries.get(key);
    // An old in-flight failure must not dirty a later successful observation.
    if (previous && requestedAt < previous.requestedAt) return;
    const now = this.now();
    if (previous && usable(previous.quote)) {
      previous.quote = { ...previous.quote, stale: true };
      previous.failed = true; previous.retryAt = now + FAILURE_MS;
      previous.requestedAt = requestedAt;
    } else {
      this.setEntry(key, { quote: { market, symbol, price: null, changePct: null,
        spark: [], stale: true, reachable: false }, fetchedAt: now, requestedAt,
      restored: false, failed: true, retryAt: now + FAILURE_MS });
    }
    this.changed(); // empty failures are session-only; never persist fake data
  }

  private setEntry(key: string, entry: Entry): void {
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > CAPACITY) this.entries.delete(this.entries.keys().next().value!);
  }

  private changed(): void {
    this.changePending = this.paused;
    if (!this.paused) this.options.onChange();
  }

  private hydrate(): void {
    try {
      const raw = this.options.storage?.getItem(PREVIEW_QUOTES_KEY);
      if (!raw || raw.length > 1_000_000) return;
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      for (const value of parsed.entries.slice(-CAPACITY)) {
        if (!value || typeof value !== 'object') continue;
        const saved = value as { quote?: unknown; fetchedAt?: unknown; requestedAt?: unknown };
        const quote = clean(saved.quote), fetchedAt = saved.fetchedAt;
        if (!quote || !usable(quote) || !validTime(fetchedAt)
          || this.now() - fetchedAt > RETAIN_MS || fetchedAt > this.now() + FRESH_MS) continue;
        const requestedAt = validTime(saved.requestedAt) ? saved.requestedAt : fetchedAt;
        const key = identity(quote.market, quote.symbol)!;
        const previous = this.entries.get(key);
        if (previous && !newer(quote, requestedAt, previous)) continue;
        this.setEntry(key, { quote: { ...quote, stale: true }, fetchedAt, requestedAt,
          restored: true, failed: false, retryAt: 0 });
      }
    } catch { /* private storage, quota and corrupt cache never block the picker */ }
  }

  private schedulePersist(): void {
    this.persistNeeded = true;
    if (this.paused || this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => this.flushPersist(), 100);
  }

  private flushPersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.persistNeeded) return;
    this.persistNeeded = false;
    try {
      const now = this.now();
      const entries = [...this.entries.values()].filter(entry => usable(entry.quote)
        && now - entry.fetchedAt <= RETAIN_MS).map(({ quote, fetchedAt, requestedAt }) => ({ quote, fetchedAt, requestedAt }));
      this.options.storage?.setItem(PREVIEW_QUOTES_KEY, JSON.stringify({ version: 1, entries }));
    } catch { /* cache is optional and bounded; failed persistence is not a UI error */ }
  }
}
