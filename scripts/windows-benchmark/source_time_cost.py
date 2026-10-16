"""Synthetic 1800s/4Hz source assessment cost; no native/FPS qualification."""
import json
import time
import tracemalloc

from core import source_time_gate
from test_source_windows import long_live_fixture


def main():
    rows,start,end=long_live_fixture()
    tracemalloc.start()
    clock=time.perf_counter()
    result=source_time_gate(rows,start,end,'live-recording')
    elapsed=time.perf_counter()-clock
    current,peak=tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(json.dumps({'fixture':'synthetic 1800 seconds, 4Hz, stable 2000ms source-column delay',
        'samples':len(rows),'raw_samples_retained':len(result['samples']),'assessment_seconds_with_tracemalloc':elapsed,
        'assessment_traced_current_bytes':current,'assessment_traced_peak_bytes':peak,
        'input_json_bytes':len(json.dumps(rows)),'result_json_bytes':len(json.dumps(result)),
        'available':result['available'],'pass':result['pass'],'window_evaluation':result['window_evaluation'],
        'limitation':'Assessment cost only; synthetic input is neither displayed FPS nor native qualification.'},indent=2))


if __name__=='__main__':main()
