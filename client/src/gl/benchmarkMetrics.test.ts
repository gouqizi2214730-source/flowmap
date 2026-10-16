import { describe, expect, it } from 'vitest';
import { BENCHMARK_COUNTERS, BenchmarkMetrics } from './benchmarkMetrics';

describe('benchmark raw diagnostics', () => {
  it('retains long callback and rAF gaps without EMA filtering', () => {
    const m = new BenchmarkMetrics();
    m.frame(10, 11, 18, true); m.frame(2010, 2011, 2050, true);
    const s = m.drain([]);
    expect(s.frames.map(f => f.rafMs)).toEqual([10, 2010]);
    expect(s.frames[1].endMs - s.frames[1].startMs).toBe(39);
    expect(m.drain([]).frames).toEqual([]);
  });
  it('waits for an actual chart draw and counts replacement independently', () => {
    const m = new BenchmarkMetrics();
    m.input('wheel', 100); m.frame(105, 105, 110, false);
    expect(m.drain([]).pendingInputs).toBe(1);
    m.count('partialReplaced'); m.count('finalizedDiscarded:queueOverflow');
    m.frame(115, 115, 125, true);
    const s = m.drain([]);
    expect(s.inputs[0].latencyMs).toBe(25);
    expect(s.counters.partialReplaced).toBe(1);
    expect(s.counters['finalizedDiscarded:queueOverflow']).toBe(1);
    expect(s.schema).toBe(2);
    expect(s.requiredCounters).toEqual([...BENCHMARK_COUNTERS]);
    for (const key of BENCHMARK_COUNTERS) expect(Number.isFinite(s.counters[key])).toBe(true);
    expect(s.counters.historyReceived).toBe(0);
  });
});
