/** The schema lists observed zeros as well as nonzero events. Absent is unavailable. */
export const BENCHMARK_COUNTERS = [
  'finalizedReceived', 'partialReceived', 'finalizedApplied', 'partialApplied',
  'partialReplaced', 'finalizedHistoryOmitted', 'partialHistoryOmitted',
  'telemetryOverflow', 'streamIngestErrors', 'frameErrors',
  ...['sessionReset', 'contextLost', 'unattributed', 'row-mismatch', 'queueOverflow']
    .flatMap(reason => [`finalizedDiscarded:${reason}`, `partialDiscarded:${reason}`]),
  'historyReceived', 'historyApplied', 'historyOmitted:staleSession',
  ...['contextLost', 'noRing', 'rowMismatch', 'writeError'].map(reason => `historyDiscarded:${reason}`),
] as const;

/** Opt-in CPU-side diagnostics. None of these timestamps measure display presentation. */
export class BenchmarkMetrics {
  readonly counters: Record<string, number> = Object.fromEntries(BENCHMARK_COUNTERS.map(key => [key, 0]));
  private frames: { rafMs: number; startMs: number; endMs: number; drew: boolean }[] = [];
  private inputs: { eventMs: number; drawMs: number; latencyMs: number; kind: string }[] = [];
  private pendingInputs: { eventMs: number; kind: string }[] = [];
  private oldest = new WeakMap<object, number>();
  private readonly limit = 20_000;

  count(reason: string, amount = 1): void {
    this.counters[reason] = (this.counters[reason] ?? 0) + amount;
  }
  arrived(column: object): void { this.oldest.set(column, performance.now()); }
  queuedAge(column: object | undefined): number {
    return column ? Math.max(0, performance.now() - (this.oldest.get(column) ?? performance.now())) : 0;
  }
  input(kind: string, eventMs = performance.now()): void {
    if (this.pendingInputs.length >= this.limit) this.count('telemetryOverflow');
    else this.pendingInputs.push({ eventMs, kind });
  }
  frame(rafMs: number, startMs: number, endMs: number, drew: boolean): void {
    if (this.frames.length >= this.limit) this.count('telemetryOverflow');
    else this.frames.push({ rafMs, startMs, endMs, drew });
    if (!drew) return;
    for (const input of this.pendingInputs) {
      if (this.inputs.length >= this.limit) this.count('telemetryOverflow');
      else this.inputs.push({ ...input, drawMs: endMs, latencyMs: endMs - input.eventMs });
    }
    this.pendingInputs.length = 0;
  }
  drain(queue: readonly object[]) {
    const result = {
      schema: 2, capabilities: ['stream-discard-v1', 'history-discard-v1', 'queue-age-v1', 'input-draw-v1'],
      requiredCounters: [...BENCHMARK_COUNTERS],
      nowMs: performance.now(), timeOriginMs: performance.timeOrigin,
      frames: this.frames, inputs: this.inputs, counters: { ...this.counters },
      queueLength: queue.length, oldestQueuedAgeMs: this.queuedAge(queue[0]),
      pendingInputs: this.pendingInputs.length,
      meaning: 'CPU callback duration and input event dispatch to completed chart draw; not presented FPS or display latency',
    };
    this.frames = []; this.inputs = [];
    return result;
  }
}
