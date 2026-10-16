"""Acquisition stalls, conservative interval joins and exact ETW cleanup."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from core import ownership_intervals, process_observation_bounds, resource_evidence, NATIVE_PRIVATE_WS_SOURCE
from observation import ProcessObserver, observe_processes
from run import cleanup_presentmon, presentmon_log_issues, presentation_collection_issue, write


def bounded(start, end, birth=10):
    return {'schema':4, 'unix_ms':end, 'qpc_ms':end,
            'observation_start_unix_ms':start, 'observation_end_unix_ms':end,
            'observation_start_qpc_ms':start, 'observation_end_qpc_ms':end,
            'observation_duration_ms':end-start, 'qpc_frequency':1000,
            'processes':[{'pid':1, 'creation_ticks':birth, 'private_commit_bytes':100, 'cpu_seconds':end/1000,
                          'private_working_set_bytes':20,'working_set_bytes_not_summed':80,'private_working_set_source':NATIVE_PRIVATE_WS_SOURCE}],
            'private_commit_bytes':100,'private_working_set_bytes':20,'private_working_set_source':NATIVE_PRIVATE_WS_SOURCE,
            'owned_tree_complete':True,'job_pids_start':[1],'job_pids_end':[1],'confirmed_exits':[],'acquisition_issues':[]}


def system_sample(start, end):
    return {'schema':3, 'unix_ms':end, 'sample_start_unix_ms':start, 'errors':[],
            'owned_gpu_candidates':[{'kind':'allocation','pid':1,'expected_creation_ticks':10,'creation_ticks':10,
                'identity_verified_at_start':True,'identity_verified_at_end':True,'dedicated_bytes':1,'shared_bytes':1,'committed_bytes':1},
                {'kind':'engine','pid':1,'expected_creation_ticks':10,'creation_ticks':10,
                'identity_verified_at_start':True,'identity_verified_at_end':True,'utilization_percent':0}],
            'private_working_sets':[{'pid':1, 'creation_ticks':10, 'private_working_set_bytes':20}],
            'system_memory':{k:100 for k in ('AvailableBytes','CommittedBytes','CommitLimit','PagesInputPersec','PagesOutputPersec','PageReadsPersec','PageWritesPersec')},
            'per_core_cpu':[{'Name':'0,0','PercentProcessorTime':20}], 'paging_file':[{'PercentUsage':0}],
            'gpu_process_allocations_unsummed':[{'pid':1,'creation_ticks':10,'luid':'0,1','dedicated_bytes':1,'shared_bytes':1,'committed_bytes':1}],
            'gpu_adapter_host_totals':[{'luid':'0,1','dedicated_bytes':1,'shared_bytes':1,'committed_bytes':1}],
            'owned_gpu_engines':[{'pid':1,'creation_ticks':10,'utilization_percent':0}]}


class ObservationTests(unittest.TestCase):
    def test_new_or_unproved_disappearing_job_member_is_explicitly_incomplete(self):
        class Job:
            def __init__(self,start,end):self.values=iter((start,end))
            def pids(self):return next(self.values)
            def peak_commit(self):return 100
        def sample(pid,**kwargs):return bounded(0,0)['processes'][0]|{'pid':pid}
        def qpc():return time.perf_counter_ns(),1_000_000_000
        for first,last in (([1],[1,2]),([1,2],[1])):
            row=observe_processes(Job(first,last),sample,qpc)
            self.assertFalse(row['owned_tree_complete'])
            self.assertTrue(row['acquisition_issues'])
            self.assertEqual(row['job_pids_start'],first);self.assertEqual(row['job_pids_end'],last)
            self.assertEqual(len(row['process_attempts']),len(first))

    def test_multisecond_blocked_production_snapshot_publication_does_not_stop_acquisition(self):
        class Job:
            closed = False
            def pids(self):
                if self.closed: raise AssertionError('Observer raced job teardown')
                return [1]
            def peak_commit(self): return 100
        job = Job()
        def process(pid,**kwargs): return {'pid':pid,'creation_ticks':10,'private_commit_bytes':100,'cpu_seconds':0}
        def qpc(): return time.perf_counter_ns(), 1_000_000_000
        collector = ProcessObserver(lambda:observe_processes(job,process,qpc), interval=.05).start()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            published = []
            blocked_at = []
            def publisher(row):
                if not blocked_at:
                    blocked_at.append(time.time()*1000)
                    # Block the real writer before it touches the identity file.
                    import run
                    original = run._replace_snapshot
                    def stalled(*args):
                        time.sleep(2.6)
                        return original(*args)
                    with patch('run._replace_snapshot', side_effect=stalled):
                        write(root/'identities.json',[{'pid':1,'creation_ticks':10}])
                    blocked_at.append(time.time()*1000)
                with (root/'process.ndjson').open('a',encoding='utf-8') as stream:
                    stream.write(json.dumps(row)+'\n')
                published.append(row)
            try:
                collector.publish(publisher,wait=True)
            finally:
                self.assertTrue(collector.stop())
                collector.publish(publisher)
                job.closed = True
            raw = [json.loads(line) for line in (root/'process.ndjson').read_text().splitlines()]
            self.assertEqual(raw,published)
            self.assertEqual(collector.observed,collector.published)
            self.assertEqual(collector.status()['lost'],0)
            during = [r for r in raw if blocked_at[0]<r['observation_start_unix_ms']<blocked_at[1]]
            self.assertGreater(len(during),20)
            self.assertLess(max(b['unix_ms']-a['unix_ms'] for a,b in zip(raw,raw[1:])),500)
            for row in raw:
                process_observation_bounds(row)
                self.assertLess(row['observation_duration_ms'],100)
            count = collector.observed
            time.sleep(.1)
            self.assertEqual(collector.observed,count)

    def test_collector_error_is_propagated_and_queued_raw_can_be_flushed_after_join(self):
        calls = []
        def collect():
            calls.append(1)
            if len(calls)==4: raise OSError('native acquisition failed')
            return bounded(len(calls),len(calls))
        collector = ProcessObserver(collect,interval=.001).start()
        self.assertTrue(collector.stop_requested.wait(2))
        self.assertTrue(collector.stop())
        with self.assertRaisesRegex(RuntimeError,'native acquisition failed'): collector.check()
        rows = []
        collector.publish(rows.append,check=False)
        self.assertEqual(len(rows),3)
        self.assertEqual(collector.published,collector.observed)
        self.assertTrue(collector.status()['errors'])

    def test_queue_overflow_is_bounded_and_invalidates_even_after_flush(self):
        collector = ProcessObserver(lambda:bounded(0,0),interval=.001,capacity=2).start()
        self.assertTrue(collector.stop_requested.wait(2))
        self.assertTrue(collector.stop())
        rows = []
        collector.publish(rows.append,check=False)
        self.assertEqual(len(rows),2)
        self.assertEqual(collector.lost,1)
        with self.assertRaisesRegex(RuntimeError,'overflow'): collector.check()

    def test_publication_error_stops_collector_and_reports_unpersisted_raw(self):
        collector = ProcessObserver(lambda:bounded(0,0),interval=.001).start()
        def fail(row): raise OSError('disk write failed')
        try:
            with self.assertRaisesRegex(OSError,'disk write failed'): collector.publish(fail,wait=True)
        finally:
            self.assertTrue(collector.stop())
        self.assertGreater(collector.lost,0)
        with self.assertRaisesRegex(RuntimeError,'not fully persisted'): collector.check()

    def test_stop_timeout_is_explicit_and_never_authorizes_job_teardown(self):
        entered, release = threading.Event(), threading.Event()
        def collect():
            entered.set()
            release.wait(2)
            return bounded(0,0)
        collector = ProcessObserver(collect).start()
        self.assertTrue(entered.wait(2))
        try:
            self.assertFalse(collector.stop(timeout=.01))
            self.assertFalse(collector.status()['stopped'])
        finally:
            release.set()
            self.assertTrue(collector.stop())
        with self.assertRaisesRegex(RuntimeError,'teardown deferred'): collector.check()

    def test_actual_slow_acquisition_is_recorded_not_backdated_or_hidden(self):
        class Job:
            def pids(self): time.sleep(.1); return []
            def peak_commit(self): return 0
        row = observe_processes(Job(),lambda pid,**kwargs:None,lambda:(time.perf_counter_ns(),1_000_000_000))
        process_observation_bounds(row)
        self.assertGreaterEqual(row['observation_duration_ms'],90)


class ConservativeIntervalTests(unittest.TestCase):
    def resource(self, rows, sample=None):
        sample=sample or system_sample(500,1500)
        second=copy.deepcopy(sample); second['unix_ms']+=1
        return resource_evidence(rows,[sample,second],0,2500,1,'0,1')

    def test_full_cim_interval_requires_outside_acquisition_brackets(self):
        rows = [bounded(0,100),bounded(250,750),bounded(1250,1750),bounded(1900,2000)]
        self.assertTrue(self.resource(rows)['available'])
        # Acquisition crossing a query boundary cannot be used as that endpoint.
        self.assertFalse(self.resource(rows[1:3])['available'])
        self.assertFalse(self.resource(rows,system_sample(500,2100))['available'])
        # Endpoint-to-endpoint span is 3000ms, but the outside span is 4000ms.
        self.assertFalse(self.resource([bounded(-1000,0),bounded(2000,3000)])['available'])
        self.assertFalse(self.resource([bounded(0,0),bounded(2000,2000,11)])['available'])

    def test_new_lifetime_begins_at_end_and_extends_only_to_next_start(self):
        self.assertEqual(ownership_intervals([bounded(0,100),bounded(1000,1100)]),{1:[(100,1000)]})
        self.assertEqual(ownership_intervals([bounded(0,100),bounded(1000,3600)]),{1:[(100,100),(3600,3600)]})

    def test_gpu_identity_stays_required_while_native_ram_tracks_actual_utility_churn(self):
        for interval in ((650,700),(1400,1700)):
            for change in ('additional','missing','replaced'):
                with self.subTest(interval=interval,change=change):
                    middle=bounded(*interval)
                    if change=='additional':
                        middle['processes'].append(middle['processes'][0]|{'pid':2,'creation_ticks':20})
                        middle['private_commit_bytes']=200
                        middle['private_working_set_bytes']=40
                        middle['job_pids_start']=middle['job_pids_end']=[1,2]
                    elif change=='missing':
                        middle['processes']=[middle['processes'][0]|{'pid':2,'creation_ticks':20}]
                        middle['job_pids_start']=middle['job_pids_end']=[2]
                    else:
                        middle['processes'][0]['creation_ticks']=11
                    rows=[bounded(0,100),middle,bounded(1800,1850),bounded(1900,2000)]
                    result=self.resource(rows)
                    self.assertFalse(result['private_ws_joined'])
                    self.assertIn('CIM private working set ownership changed within its full process bracket.',result['cim_private_ws_diagnostics']['missing'])
                    if change=='additional':
                        self.assertTrue(result['available'],result['missing'])
                        self.assertEqual(result['peak_private_working_set_bytes'],40)
                    else:
                        self.assertFalse(result['available'])
                        self.assertIn('GPU allocation/engine identity is not continuously owned over its full query bracket.',result['missing'])
        # Repeated unchanged observations inside/outside the CIM interval remain valid.
        self.assertTrue(self.resource([bounded(0,100),bounded(650,700),bounded(1600,1700),bounded(1900,2000)])['available'])

    def test_native_ram_cannot_fallback_to_good_cim_or_commit_when_missing_incomplete_or_old(self):
        for key,value in (('schema',3),('private_working_set_bytes',None),('private_working_set_bytes',100),
                          ('owned_tree_complete',False),('private_working_set_source','total WS')):
            rows=[bounded(0,100),bounded(1900,2000)];rows[0][key]=value
            result=self.resource(rows)
            self.assertFalse(result['available'],(key,value))
        rows=[bounded(0,100),bounded(1900,2000)]
        rows[0]['processes'][0].pop('private_working_set_bytes')
        self.assertFalse(self.resource(rows)['available'])
        rows=[bounded(0,100),bounded(1900,2000)]
        sample=system_sample(500,1500);sample['private_working_sets']=None
        result=self.resource(rows,sample)
        self.assertTrue(result['available'],result['missing'])
        self.assertFalse(result['cim_private_ws_diagnostics']['available'])

    def test_legacy_and_inconsistent_timing_cannot_supply_resource_pass(self):
        rows = [bounded(0,0),bounded(2000,2000)]
        legacy = [{k:v for k,v in row.items() if not k.startswith('observation_') and k!='schema'} for row in rows]
        self.assertFalse(self.resource(legacy)['available'])
        for key,value in (('unix_ms',99),('observation_start_unix_ms',3000),
                          ('observation_duration_ms',100),('observation_end_qpc_ms',None)):
            bad = copy.deepcopy(rows); bad[1][key] = value
            self.assertFalse(self.resource(bad)['available'],key)
        for value in (None,1600):
            sample = system_sample(500,1500); sample['sample_start_unix_ms'] = value
            self.assertFalse(self.resource(rows,sample)['available'])


class PresentMonCollectionTests(unittest.TestCase):
    session = 'FlowMapBenchmark-'+'a'*32

    def test_any_positive_etw_loss_is_failure_even_with_exit_zero_or_usable_csv(self):
        for line in ('warning: 466565 ETW events were lost.',
                     'warning: 1 ETW buffer was lost.', 'warning: 1,234 ETW events were lost.',
                     'warning: present event overflow detected.', 'warning: 5 present events overflowed.'):
            self.assertTrue(presentmon_log_issues(line),line)
        self.assertFalse(presentmon_log_issues('warning: 0 ETW events were lost.\nStopped recording.'))
        self.assertFalse(presentmon_log_issues('warning: PresentMon requires elevated privilege in order to query processes'))

    def test_missing_csv_and_empty_owned_stream_are_specific_collection_failures(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'present.csv'
            self.assertIn('CSV is missing',presentation_collection_issue(path,{}))
            for raw in ('','ProcessID,SwapChainAddress,CPUStartQPC,DisplayLatency,DisplayedTime\n'):
                path.write_text(raw,encoding='utf-8')
                self.assertIn('no usable owned displayed target stream',presentation_collection_issue(path,{}))
            self.assertIsNone(presentation_collection_issue(path,{'1:a':20}))

    def test_exact_session_cleanup_preserves_capture_status_and_verifies_absence(self):
        calls = []
        def execute(command,**kwargs):
            calls.append((command,kwargs))
            return subprocess.CompletedProcess(command,0 if len(calls)==1 else 7,
                '' if len(calls)==1 else 'error: no existing sessions found: '+self.session,'')
        for status in (0,None,1):
            calls.clear()
            record = cleanup_presentmon('owned/PresentMon.exe',self.session,status,execute=execute)
            self.assertTrue(record['verified_absent'])
            self.assertEqual(record['capture_status_before_cleanup'],status)
            self.assertEqual(len(calls),2)
            self.assertEqual(calls[0][0],['owned/PresentMon.exe','--session_name',self.session,'--terminate_existing_session'])
            self.assertEqual(calls[0][1]['timeout'],10)

    def test_absent_crashed_session_and_failed_cleanup_are_distinct(self):
        def absent(command,**kwargs):
            return subprocess.CompletedProcess(command,7,'error: no existing sessions found: '+self.session,'')
        self.assertTrue(cleanup_presentmon('PresentMon.exe',self.session,1,execute=absent)['verified_absent'])
        def denied(command,**kwargs): return subprocess.CompletedProcess(command,5,'access denied','')
        self.assertFalse(cleanup_presentmon('PresentMon.exe',self.session,None,execute=denied)['verified_absent'])
        def timeout(command,**kwargs): raise subprocess.TimeoutExpired(command,10)
        self.assertFalse(cleanup_presentmon('PresentMon.exe',self.session,None,execute=timeout)['verified_absent'])
        for invalid in ('PresentMon','FlowMapBenchmark-*','FlowMapBenchmark-'+32*'a'+' --restart_as_admin'):
            with self.assertRaises(ValueError): cleanup_presentmon('PresentMon.exe',invalid,None,execute=absent)


if __name__ == '__main__': unittest.main()
