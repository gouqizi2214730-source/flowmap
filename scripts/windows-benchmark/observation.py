"""Fast acquisition only; the caller publishes evidence and inspects windows.

One bounded queue separates native observations from all filesystem work. No
publisher worker uses the job, so joining this one observer precedes teardown.
"""
from __future__ import annotations
import queue
import threading
import time
import traceback

from core import private_memory_totals
from win32 import ConfirmedProcessExit, PRIVATE_WS_SOURCE


def observe_processes(job, process_sample, qpc):
    # Bound the actual native calls, never snapshot publication or disk writes.
    start_unix = time.time() * 1000
    start_ticks, frequency = qpc()
    current,exits,issues,attempts,acquired = [],[],[],[],[]
    requested,final_pids = [],[]
    stage,pid='job PID list',None
    try:
        requested=job.pids()
        for pid in requested:
            stage='process_sample'
            attempt={'pid':pid,'start_unix_ms':time.time()*1000};attempts.append(attempt)
            try:
                row = process_sample(pid,retain_handle=True)
                if row:
                    current.append(row);acquired.append(row)
                    attempt.update(status='observed',creation_ticks=row['creation_ticks'],
                                   image_query_attempts=row.get('image_query_attempts',[]))
                else:
                    attempt['status']='unavailable'
                    issues.append(f'Owned PID {pid} has no process evidence or held-handle exit proof.')
            except ConfirmedProcessExit as error:
                exits.append({'pid':error.pid,'creation_ticks':error.creation_ticks,'call':error.call,
                              'winerror':error.winerror,'exit_proof':error.exit_proof,
                              'image_query_attempts':getattr(error,'image_query_attempts',[])})
                attempt.update(status='confirmed_exited',creation_ticks=error.creation_ticks,call=error.call,
                               winerror=error.winerror,exit_proof=error.exit_proof,
                               image_query_attempts=getattr(error,'image_query_attempts',[]))
                if not error.creation_ticks: issues.append(f'Exited PID {pid} has no proven creation identity.')
            except BaseException as error:
                attempt.update(status='error',call=getattr(error,'call',None),winerror=getattr(error,'winerror',None),
                               creation_ticks=getattr(error,'creation_ticks',None),
                               image_query_attempts=getattr(error,'image_query_attempts',[]))
                raise
            finally: attempt['end_unix_ms']=time.time()*1000
        stage,pid='job PID reconciliation',None
        final_pids=job.pids()
        for row in list(current):
            if not hasattr(row,'check_live'): continue  # injected pure collector fixtures
            try: row.check_live()
            except ConfirmedProcessExit as error:
                current.remove(row)
                proof={'pid':error.pid,'creation_ticks':error.creation_ticks,'call':error.call,
                       'winerror':error.winerror,'exit_proof':error.exit_proof}
                exits.append(proof)
                next(a for a in attempts if a['pid']==error.pid).update(status='confirmed_exited',last_sample_before_exit=dict(row),**proof)
        if sorted(p['pid'] for p in current)!=sorted(final_pids):
            issues.append('Owned tree changed without complete final member evidence during acquisition.')
        if any(e['pid'] in final_pids for e in exits):
            issues.append('Exited held identity still appears in final job PID list; replacement/unsettled exit uncertain.')
        stage='job peak commit'
        peak = job.peak_commit()
    except BaseException as error:
        error.acquisition_evidence={'job_pids_start':requested,'job_pids_end':final_pids,
                                    'process_attempts':attempts,'confirmed_exits':exits,'partial_processes':current}
        error.add_note(f'Owned process acquisition stage={stage}, PID={pid}, job_handle={getattr(job,"handle",None)}')
        raise
    finally:
        for row in acquired:
            if hasattr(row,'close'): row.close()
    end_ticks, end_frequency = qpc()
    end_unix = time.time() * 1000
    if frequency != end_frequency:
        raise RuntimeError('Process observation QPC frequency changed')
    start_qpc, end_qpc = start_ticks * 1000 / frequency, end_ticks * 1000 / frequency
    return {'schema': 4, 'unix_ms': end_unix, 'qpc_ms': end_qpc,
            'observation_start_unix_ms': start_unix, 'observation_end_unix_ms': end_unix,
            'observation_start_qpc_ms': start_qpc, 'observation_end_qpc_ms': end_qpc,
            'observation_duration_ms': end_qpc - start_qpc, 'qpc_frequency': frequency,
            'processes': current, **private_memory_totals(current), 'peak_job_commit_bytes': peak,
            'private_working_set_source':PRIVATE_WS_SOURCE,'owned_tree_complete':not issues,
            'job_pids_start':requested,'job_pids_end':final_pids,'confirmed_exits':exits,'acquisition_issues':issues,
            'process_attempts':attempts}


class ProcessObserver:
    def __init__(self, collect, *, interval=.25, capacity=256):
        self.collect, self.interval = collect, interval
        self.queue = queue.Queue(maxsize=capacity)
        self.stop_requested = threading.Event()
        self.thread = threading.Thread(target=self._run, name='benchmark-process-observer', daemon=True)
        self.failures = []
        self.error_details = []
        self.observed = self.published = self.lost = 0
        self.started = False

    def start(self):
        self.started = True
        self.thread.start()
        return self

    def _fail(self, message):
        self.failures.append(message)
        self.stop_requested.set()

    def _run(self):
        try:
            while not self.stop_requested.is_set():
                started = time.monotonic()
                row = self.collect()
                self.observed += 1
                try:
                    self.queue.put_nowait(row)
                except queue.Full:
                    self.lost += 1
                    self._fail('Process observation queue overflow; raw evidence lost.')
                    break
                # A delayed native call never creates catch-up or backdated rows.
                self.stop_requested.wait(max(0, self.interval - (time.monotonic() - started)))
        except BaseException as error:
            self.error_details.append({'unix_ms':time.time()*1000,'monotonic_ms':time.monotonic()*1000,
                'thread':threading.current_thread().name,'type':type(error).__name__,
                'call':getattr(error,'call',None),'pid':getattr(error,'pid',None),'winerror':getattr(error,'winerror',None),
                'acquisition_evidence':getattr(error,'acquisition_evidence',None),
                'traceback':traceback.format_exc()})
            self._fail(f'Process observer: {type(error).__name__}: {error}')

    def check(self):
        if self.failures:
            raise RuntimeError('; '.join(self.failures))

    def publish(self, publisher, *, wait=False, check=True):
        # Bound each drain to the queue contents at entry; acquisition may continue.
        batch = []
        if wait:
            try:
                batch.append(self.queue.get(timeout=2))
            except queue.Empty:
                self.check()
                raise RuntimeError('Process observer produced no observation within 2 seconds')
        for _ in range(self.queue.qsize()):
            try:
                batch.append(self.queue.get_nowait())
            except queue.Empty:
                break
        for index, row in enumerate(batch):
            try:
                publisher(row)
                self.published += 1
            except BaseException as error:
                self.lost += len(batch) - index
                self._fail(f'Process publication: {type(error).__name__}: {error}; raw evidence not fully persisted.')
                raise
        if check:
            self.check()
        return batch[-1] if batch else None

    def stop(self, timeout=5):
        self.stop_requested.set()
        if self.started:
            self.thread.join(timeout)
            if self.thread.is_alive():
                self._fail(f'Process observer did not stop within {timeout:g} seconds; job teardown deferred to runner exit.')
        return not self.thread.is_alive() if self.started else True

    def status(self):
        return {'observed': self.observed, 'published': self.published, 'lost': self.lost,
                'pending': self.queue.qsize(), 'stopped': not self.thread.is_alive(),
                'queue_capacity': self.queue.maxsize, 'interval_seconds': self.interval,
                'errors': list(self.failures),'error_details':list(self.error_details)}
