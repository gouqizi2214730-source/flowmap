"""Actual Windows PDH and owned D3D11 lifetime tests plus adversarial proof tests."""
import copy
import ctypes as C
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import pdh
from core import resource_evidence
from sample_pdh import sample, process_identity, read_identities
from test_observation import bounded

ENGINE=r'\GPU Engine(*)\Utilization Percentage'
ALLOC='pid_1_luid_0x00000000_0x00000001_phys_0'
ENGINE_NAME=ALLOC+'_eng_0_engtype_3D'

def fixture():
    result={}
    for path in pdh.PATHS:
        name=('' if path.startswith('\\Memory\\') else '0,0' if path.startswith('\\Processor') else
              '_Total' if path.startswith('\\Paging') else 'luid_0x00000000_0x00000001_phys_0' if path.startswith('\\GPU Adapter') else
              ENGINE_NAME if path==ENGINE else ALLOC)
        raw={'status':0,'items':[{'name':name,'status':0,'timestamp_filetime':1}],'attempts':[]}
        formatted={'status':0,'items':[{'name':name,'status':0,'value':10.25}],'attempts':[]}
        result[path]={'kind':'rate' if path in pdh.RATE_PATHS else 'gauge','first_raw':copy.deepcopy(raw),'current_raw':raw,
                      'formatted':formatted,'warmup_formatted':{'status':0xc0000bba,'items':[],'attempts':[]}}
    return result

class FakeQuery:
    def __init__(self,evidence):self.evidence=evidence;self.stages=[]
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def acquire(self,**kwargs):
        for _ in range(2):
            self.stages.append({'start_unix_ms':pdh.unix_ms(),'end_unix_ms':pdh.unix_ms(),'status':0,'elapsed_ms':0.0})
            time.sleep(.001)
        return self.evidence

def controlled(evidence=None,snapshot=None,identity=None):
    with patch('sample_pdh.os.cpu_count',return_value=1):
        return sample(None,query_factory=lambda:FakeQuery(copy.deepcopy(evidence if evidence is not None else fixture())),
                      snapshot_reader=snapshot or (lambda _: {1:10}),identity_reader=identity or (lambda _:10),interval=0)

def assess(row,process=None):
    lo,hi=row['sample_start_unix_ms'],row['unix_ms']
    observations=process or [bounded(t,t) for t in (lo-100,lo-50,hi+50,hi+100)]
    duplicate=copy.deepcopy(row);duplicate['unix_ms']+=.01
    return resource_evidence(observations,[row,duplicate],lo-50,hi+50,1,'0,1')

class PdhContractTests(unittest.TestCase):
    def test_valid_new_data_and_fractional_pagefile_are_preserved(self):
        evidence=fixture()
        for data in evidence.values():
            for key in ('first_raw','current_raw','formatted'):
                for item in data[key]['items']:item['status']=1
        row=controlled(evidence)
        self.assertEqual(row['errors'],[]);self.assertEqual(pdh.validate_row(row),[])
        self.assertEqual(row['paging_file'][0]['PercentUsage'],10.25)
        result=assess(row);self.assertTrue(result['available'],result['missing'])
        self.assertFalse(result['cim_private_ws_diagnostics']['available'])

    def test_rate_cannot_claim_only_current_collection_or_omit_proof(self):
        good=controlled()
        for key,value in (('rate_interval_start_unix_ms',good['provider_stages'][1]['start_unix_ms']),
                          ('counter_extraction_end_unix_ms',good['unix_ms']+1),('counter_provider','unknown'),
                          ('provider_stages',[]),('counter_evidence',{}),('schema',3),('identity_start',[])):
            with self.subTest(key=key):
                bad=copy.deepcopy(good);bad[key]=value;bad['errors']=[]
                self.assertFalse(assess(bad)['available'])

    def test_actual_rate_interval_requires_continuous_native_membership(self):
        row=controlled();lo=row['sample_start_unix_ms'];hi=row['unix_ms']
        process=[bounded(lo-100,lo-100),bounded(lo-50,lo-50),bounded((lo+hi)/2,(lo+hi)/2,999),bounded(hi+50,hi+50),bounded(hi+100,hi+100)]
        self.assertFalse(assess(row,process)['available'])

    def test_api_success_does_not_validate_invalid_counter_payload(self):
        for key in ('first_raw','current_raw','formatted'):
            with self.subTest(key=key):
                evidence=fixture();evidence[ENGINE][key]['items'][0]['status']=0xc0000bba
                row=controlled(evidence)
                self.assertIsNone(row['owned_gpu_candidates'][-1]['utilization_percent'])
                self.assertTrue(row['errors']);row['errors']=[]
                self.assertFalse(assess(row)['available'])

    def test_no_missing_instance_property_or_api_status_defaults_to_zero(self):
        for path in (ENGINE,r'\Memory\Available Bytes',r'\Processor Information(*)\% Processor Time',r'\Paging File(*)\% Usage',r'\GPU Adapter Memory(*)\Shared Usage'):
            for change in ('missing','api-error','invalid-status','nan','missing-value'):
                with self.subTest(path=path,change=change):
                    evidence=fixture();array=evidence[path]['formatted']
                    if change=='missing':array['items']=[]
                    elif change=='api-error':array['status']=0xc0000bb9
                    elif change=='invalid-status':array['items'][0]['status']=0x800007d1
                    elif change=='nan':array['items'][0]['value']=float('nan')
                    else:array['items'][0].pop('value')
                    row=controlled(evidence);row['errors']=[]
                    self.assertFalse(assess(row)['available'])

    def test_new_owned_instance_after_first_collect_is_retained_and_invalid(self):
        evidence=fixture();evidence[ENGINE]['first_raw']['items']=[]
        row=controlled(evidence);self.assertEqual(len(row['owned_gpu_candidates']),2)
        self.assertIsNone(next(c for c in row['owned_gpu_candidates'] if c['kind']=='engine')['utilization_percent'])
        row['errors']=[];self.assertFalse(assess(row)['available'])

    def test_new_snapshot_pid_and_denied_or_reused_identity_survive_filtering(self):
        for mode in ('new','denied','reused','end-denied','exited'):
            with self.subTest(mode=mode):
                snapshots=iter(({} if mode=='new' else {1:10},{1:10}))
                calls=[]
                def identity(pid):
                    calls.append(pid)
                    if mode=='denied' or (mode=='end-denied' and len(calls)>1):raise PermissionError('test denial')
                    if mode=='exited' and len(calls)>1:raise ProcessLookupError('test exit')
                    return 11 if mode=='reused' else 10
                row=controlled(snapshot=lambda _:next(snapshots),identity=identity)
                self.assertEqual(len(row['owned_gpu_candidates']),2)
                self.assertTrue(row['errors']);row['errors']=[]
                self.assertFalse(assess(row)['available'])

    def test_removed_instance_does_not_silently_vanish(self):
        evidence=fixture()
        for field in ('current_raw','formatted'):evidence[ENGINE][field]['items']=[]
        row=controlled(evidence)
        self.assertEqual(len(row['owned_gpu_candidates']),2)
        row['errors']=[];self.assertFalse(assess(row)['available'])

    def test_unrequested_summary_preserves_all_requested_uncertainty(self):
        evidence=fixture()
        for field in ('first_raw','current_raw','formatted'):
            item=copy.deepcopy(evidence[ENGINE][field]['items'][0]);item['name']=item['name'].replace('pid_1_','pid_999_');item['status']=0xc0000bba
            evidence[ENGINE][field]['items'].append(item)
        row=controlled(evidence)
        self.assertEqual(pdh.validate_row(row),[])
        for field in ('first_raw','current_raw','formatted'):
            array=row['counter_evidence'][ENGINE][field]
            self.assertEqual((array['captured_count'],len(array['items']),array['omitted_unrequested_count']),(2,1,1))
        bad=copy.deepcopy(row);bad['counter_evidence'][ENGINE]['formatted']['omitted_unrequested_count']=0
        self.assertTrue(pdh.validate_row(bad))

    def test_positive_candidate_removal_pid_luid_and_value_tampering_rejected(self):
        good=controlled()
        mutations=[lambda r:r['owned_gpu_candidates'].pop(),lambda r:r['owned_gpu_engines'].clear(),
                   lambda r:r['owned_gpu_candidates'][0].update(luid='0,99'),
                   lambda r:r['owned_gpu_candidates'][0].update(pid=9),
                   lambda r:r['gpu_adapter_host_totals'][0].update(luid='0,99'),
                   lambda r:r['system_memory'].update(CommittedBytes=0),
                   lambda r:r['counter_evidence'][ENGINE].update(kind='gauge')]
        for change in mutations:
            bad=copy.deepcopy(good);change(bad);bad['errors']=[]
            self.assertFalse(assess(bad)['available'])

    def test_counter_acquisition_failure_retains_completed_stages(self):
        class Failing(FakeQuery):
            def acquire(self,**kwargs):
                self.stages.append({'status':0xc0000bb9,'start_unix_ms':pdh.unix_ms(),'end_unix_ms':pdh.unix_ms(),'elapsed_ms':0})
                raise OSError('provider unavailable')
        row=sample(None,query_factory=lambda:Failing({}),snapshot_reader=lambda _: {},identity_reader=lambda _:10)
        self.assertTrue(row['errors']);self.assertEqual(len(row['provider_stages']),1)

    def test_zero_gpu_and_unrelated_utility_identity_denial_are_not_positive_candidates(self):
        evidence=fixture()
        for path,record in evidence.items():
            if not path.startswith(('\\GPU Process Memory(', '\\GPU Engine(')):continue
            for field in ('first_raw','current_raw','formatted'):
                item=copy.deepcopy(record[field]['items'][0]);item['name']=item['name'].replace('pid_1_','pid_2_')
                if field=='formatted':item['value']=0.0
                record[field]['items'].append(item)
        def identity(pid):
            if pid!=1:raise PermissionError('diagnostic utility denial')
            return 10
        row=controlled(evidence,snapshot=lambda _: {1:10,2:20,3:30},identity=identity)
        self.assertEqual(row['errors'],[]);self.assertTrue(row['identity_diagnostic_errors'])
        self.assertEqual({c['pid'] for c in row['owned_gpu_candidates']},{1,2})
        self.assertTrue(assess(row)['available'])


@unittest.skipUnless(os.name=='nt','Windows ctypes ABI and actual PDH')
class PdhWindowsTests(unittest.TestCase):
    def test_array_growth_reprobes_zero_size_and_unicode_exact_name(self):
        class Api:
            calls=[]
            name=C.create_unicode_buffer('Türkçe-測試')
            def PdhGetFormattedCounterArrayW(self,handle,fmt,size,count,buffer):
                self.calls.append(size._obj.value)
                if buffer is None:size._obj.value=4096;return pdh.MORE_DATA
                if len(self.calls)==2:size._obj.value=0xffffffff;return pdh.MORE_DATA
                item=pdh.FormattedItem(C.cast(self.name,pdh.W.LPWSTR),pdh.Formatted(1,1.25));C.memmove(buffer,C.byref(item),C.sizeof(item));count._obj.value=1;return 0
        query=object.__new__(pdh.Query);query.api=Api()
        result=query.array(None)
        self.assertEqual(query.api.calls,[0,4096,0,4096]);self.assertEqual(result['items'][0],{'name':'Türkçe-測試','status':1,'value':1.25})

    def test_array_growth_is_bounded_and_never_returns_a_stale_value(self):
        class Api:
            calls=0
            def PdhGetFormattedCounterArrayW(self,handle,fmt,size,count,buffer):self.calls+=1;size._obj.value=4096;return pdh.MORE_DATA
        query=object.__new__(pdh.Query);query.api=Api();result=query.array(None)
        self.assertEqual(query.api.calls,6);self.assertEqual(result['items'],[]);self.assertEqual(result['status'],pdh.MORE_DATA)

    def test_real_missing_counter_and_first_sample_never_become_valid_zero(self):
        with self.assertRaises(OSError):pdh.Query([r'\Memory\Definitely Missing Task14 Counter'])
        with pdh.Query([ENGINE,r'\Memory\Pages Input/sec']) as query:
            evidence=query.acquire(interval=1)
        self.assertNotEqual(evidence[r'\Memory\Pages Input/sec']['warmup_formatted']['status'],0)
        self.assertEqual(evidence[r'\Memory\Pages Input/sec']['formatted']['status'],0)

    def test_real_snapshot_unicode_path_and_exact_process_creation(self):
        birth=process_identity(os.getpid())
        with tempfile.TemporaryDirectory(prefix='pdh-ölçüm-') as directory:
            path=Path(directory)/'kimlik-測試.json';path.write_text(json.dumps([{'pid':os.getpid(),'creation_ticks':birth}]),encoding='utf-8')
            self.assertEqual(read_identities(path),{os.getpid():birth})
            path.write_text('null',encoding='utf-8')
            with self.assertRaises(ValueError):read_identities(path)

    def test_real_worker_cli_runs_at_held_pid_and_stops_without_redirector(self):
        with tempfile.TemporaryDirectory(prefix='pdh-worker-ölçüm-') as directory:
            root=Path(directory);identity=root/'identity.json';output=root/'system.ndjson';stop=root/'stop'
            identity.write_text('[]',encoding='utf-8')
            worker=subprocess.Popen([sys._base_executable,'-B',str(Path(__file__).with_name('sample_pdh.py')),
                '--identity-file',str(identity),'--output-file',str(output),'--stop-file',str(stop)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                deadline=time.monotonic()+6;rows=[]
                while time.monotonic()<deadline:
                    if output.exists():
                        complete=output.read_text(encoding='utf-8').splitlines()
                        try:rows=[json.loads(line) for line in complete]
                        except json.JSONDecodeError:rows=[]
                        if rows:break
                    time.sleep(.05)
                self.assertTrue(rows,'Actual worker produced no complete row')
                self.assertEqual(rows[0]['sampler_pid'],worker.pid)
                self.assertEqual(Path(rows[0]['sampler_interpreter']).resolve(),Path(sys._base_executable).resolve())
                self.assertEqual(rows[0]['errors'],[]);self.assertEqual(pdh.validate_row(rows[0]),[])
                stop.write_text('stop');stdout,stderr=worker.communicate(timeout=5)
                self.assertEqual(worker.returncode,0,stderr)
            finally:
                if worker.poll() is None:worker.terminate();worker.wait(timeout=5)
                worker.stdout.close();worker.stderr.close()

    def test_real_dynamic_gpu_lifetime_and_full_native_resource_contract(self):
        from observation import ProcessObserver, observe_processes
        from win32 import Job, kernel, checked, process_sample, qpc
        child=None;observer=None;job=Job({'affinity_mask':None,'app_job_commit_limit_bytes':None,'cpu_hard_rate':None})
        try:
            def start_child():
                nonlocal child
                child=subprocess.Popen([sys._base_executable,'-c',D3D_CHILD],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
                ready=json.loads(child.stdout.readline());self.assertEqual(ready['status'],0,ready)
                self.assertEqual(ready['pid'],child.pid,'Fixture must execute in the exact held child PID')
                checked(kernel.AssignProcessToJobObject(job.handle,int(child._handle)))
                # Device creation returns before performance-provider publication.
                # Establish actual instance publication on a separate diagnostic
                # query; the tested query's first sample still predates birth.
                deadline=time.monotonic()+3
                while True:
                    with pdh.Query([ENGINE]) as probe:
                        probe.collect();raw=probe.array(probe.handles[ENGINE],raw=True)
                    if any(i['name'].startswith(f'pid_{child.pid}_') for i in raw['items']):break
                    if time.monotonic()>=deadline:self.fail('Owned D3D11 counter instance not published within three seconds')
                    time.sleep(.05)
            with pdh.Query([ENGINE]) as query: evidence=query.acquire(interval=1,between=start_child)
            prefix=f'pid_{child.pid}_'
            new=[i for i in evidence[ENGINE]['formatted']['items'] if i['name'].startswith(prefix)]
            self.assertTrue(new);self.assertTrue(all(i['status'] not in pdh.VALID and i['value'] is None for i in new))
            birth=process_identity(child.pid);rows=[]
            observer=ProcessObserver(lambda:observe_processes(job,process_sample,qpc),interval=.05).start()
            time.sleep(.1)
            samples=[sample(None,snapshot_reader=lambda _: {child.pid:birth}) for _ in range(2)]
            time.sleep(.1);observer.stop();observer.publish(rows.append)
            self.assertEqual(observer.status()['errors'],[])
            for row in samples:
                self.assertEqual(row['errors'],[]);self.assertEqual(pdh.validate_row(row),[])
                self.assertEqual(len(row['per_core_cpu']),os.cpu_count())
            target=samples[0]['gpu_process_allocations_unsummed'][0]['luid']
            result=resource_evidence(rows,samples,samples[0]['sample_start_unix_ms'],samples[-1]['unix_ms'],os.cpu_count(),target)
            self.assertTrue(result['available'],result['missing'])
            child.stdin.write('exit\n');child.stdin.flush();child.wait(timeout=5)
            with pdh.Query([ENGINE]) as query:after=query.acquire(interval=1)
            self.assertFalse(any(i['name'].startswith(prefix) for i in after[ENGINE]['current_raw']['items']))
        finally:
            if observer:observer.stop()
            job.close()
            if child:
                if child.poll() is None:child.terminate();child.wait(timeout=5)
                child.stdin.close();child.stdout.close()

D3D_CHILD=r'''
import ctypes as C,json,sys,os
dll=C.WinDLL('d3d11');f=dll.D3D11CreateDevice;f.restype=C.c_long
f.argtypes=[C.c_void_p,C.c_uint,C.c_void_p,C.c_uint,C.c_void_p,C.c_uint,C.c_uint,C.POINTER(C.c_void_p),C.POINTER(C.c_uint),C.POINTER(C.c_void_p)]
device=C.c_void_p();context=C.c_void_p();level=C.c_uint()
status=f(None,1,None,0,None,0,7,C.byref(device),C.byref(level),C.byref(context))
print(json.dumps({'status':status,'feature_level':level.value,'pid':os.getpid()}),flush=True)
sys.stdin.readline()
'''

if __name__=='__main__':unittest.main()
