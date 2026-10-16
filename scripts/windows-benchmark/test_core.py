import csv
import copy
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from core import *

class MeasurementTests(unittest.TestCase):
    def evidence(self):
        client=[]
        for i in range(11):
            client.append({'schema':2,'capabilities':list(CAPABILITIES),'requiredCounters':list(COUNTERS),
                'counters':{k:0 for k in COUNTERS},'nowMs':i*1000,'timeOriginMs':100000,
                'queueLength':0,'oldestQueuedAgeMs':0,'pendingInputs':0,'pageVisibility':'visible',
                'sourceTimeline':{'newestSeq':i*4,'newestT0Ns':str((100000+i*1000)*1_000_000),'dtNs':250_000_000,'edgeEndNs':str((100250+i*1000)*1_000_000)},
                'sourceObservation':{'collectorTimeOriginMs':100000,'collectorStartMs':i*1000,'collectorEndMs':i*1000},
                'inputs':[{'eventMs':i*1000,'drawMs':i*1000+1,'latencyMs':1}],
                'frames':[{'rafMs':i*1000+j*1000/60,'startMs':i*1000+j*1000/60,
                           'endMs':i*1000+j*1000/60+1,'drew':True} for j in range(60)]})
        health=[{'stats_available':True,'recording_enabled':True,'stats':{'drops':{'feed':0,'tx_lag':0,'snapshot':0},
            'recording':{'enabled':True,'flush_failures':0,'flush_stalls':0,'stalled':False,
                         'last_flush_ts':105000000000,'last_flush_age_s':0}}} for _ in client]
        verified={k:True for k in ('profile','hardware_adapter','display_stream','geometry','workload','display_refresh','stable_window','runtime_provenance','interaction','history')}
        return {'presentation':{'available':True,'pass':True},'client':client,'health':health,'complete':True,
                'verified':verified,'start':100000,'end':110000,'resources':{'available':True},
                'driver':{'complete':True,'errors':[]},'driver_exit':0}

    def test_strict_observed_zeros_can_pass_diagnostic_only(self):
        result=assess(**self.evidence())
        self.assertEqual(result['status'],'PASS'); self.assertFalse(result['minimum_certified'])

    def phase_evidence(self,slow_count=0):
        e=self.evidence()
        for s in e['client']:
            s['timeOriginMs']=90000;s['nowMs']+=10000;s['inputs']=[]
            for f in s['frames']:
                for k in ('rafMs','startMs','endMs'):f[k]+=10000
        for i in range(600):
            event=10000+i*10000/600;latency=150 if i<slow_count else 1
            index=min(10,int((event+latency-10000)//1000)+1)
            e['client'][index]['inputs'].append({'eventMs':event,'drawMs':event+latency,'latencyMs':latency})
        return e

    def test_warmup_inputs_cannot_dilute_measured_p95(self):
        e=self.phase_evidence(36)
        result=assess(**e)
        self.assertEqual(result['status'],'FAIL');self.assertEqual(result['input_to_draw_p95_ms'],150)
        warmup=[{'eventMs':7000+i*1000/60,'drawMs':7001+i*1000/60,'latencyMs':1} for i in range(180)]
        e['client'][0]['inputs'].extend(warmup)
        original=copy.deepcopy(e)
        result=assess(**e)
        self.assertEqual(result['status'],'FAIL');self.assertEqual(result['input_to_draw_p95_ms'],150)
        self.assertEqual(e,original);self.assertEqual(sum(len(s['inputs']) for s in e['client']),780)

    def test_post_end_inputs_are_excluded_from_p95(self):
        for measured_slow,post_latency,expected in ((36,1,'FAIL'),(0,150,'PASS')):
            e=self.phase_evidence(measured_slow)
            post=copy.deepcopy(e['client'][-1]);post['nowMs']=23000
            post['inputs']=[{'eventMs':20000+i*1000/60,'drawMs':20000+i*1000/60+post_latency,
                             'latencyMs':post_latency} for i in range(180)]
            post['frames']=[];e['client'].append(post);e['health'].append(copy.deepcopy(e['health'][-1]))
            result=assess(**e)
            self.assertEqual(result['status'],expected,result['missing'])
            self.assertEqual(result['input_to_draw_p95_ms'],150 if measured_slow else 1)

    def test_only_out_of_phase_inputs_do_not_supply_interaction_coverage(self):
        e=self.phase_evidence()
        for s in e['client']:s['inputs']=[]
        e['client'][0]['inputs']=[{'eventMs':9999,'drawMs':10000,'latencyMs':1}]
        e['client'][-1]['inputs']=[{'eventMs':20000,'drawMs':20001,'latencyMs':1}]
        result=assess(**e)
        self.assertEqual(result['status'],'INCOMPLETE')
        self.assertIsNone(result['input_to_draw_p95_ms']);self.assertFalse(result['interaction_coverage']['available'])

    def test_measured_input_keeps_full_latency_for_completion_after_end(self):
        e=self.evidence()
        e['client'][-1]['inputs'].append({'eventMs':9990,'drawMs':10170,'latencyMs':180})
        result=assess(**e)
        self.assertEqual(result['status'],'FAIL');self.assertEqual(result['input_to_draw_p95_ms'],180)
        self.assertTrue(result['interaction_coverage']['available'])

    def test_absent_invalid_visibility_is_incomplete_and_observed_hidden_fails(self):
        for invalid in (None,7,{},[],True,'unknown',''):
            e=self.evidence();e['client'][4]['pageVisibility']=invalid
            result=assess(**e)
            self.assertEqual(result['status'],'INCOMPLETE',invalid)
            self.assertNotIn('Native page not visible throughout measurement.',result['failures'])
        e=self.evidence();del e['client'][4]['pageVisibility']
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for invalid in (None,'wrong',7):
            e=self.evidence();e['client'][4]=invalid
            self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['client'][4]=None;e['client'][7]['pageVisibility']='hidden'
        result=assess(**e)
        self.assertEqual(result['status'],'FAIL')
        self.assertIn('Native page not visible throughout measurement.',result['failures'])
        e=self.evidence();e['client'][4]=None;e['presentation']['pass']=False
        self.assertEqual(assess(**e)['status'],'FAIL')

    def test_each_missing_counter_or_queue_field_is_incomplete(self):
        for key in COUNTERS:
            with self.subTest(key=key):
                e=self.evidence(); del e['client'][4]['counters'][key]
                self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for key in ('schema','capabilities','requiredCounters','queueLength','oldestQueuedAgeMs','pendingInputs','timeOriginMs','frames','inputs'):
            with self.subTest(key=key):
                e=self.evidence(); del e['client'][4][key]
                self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_nonfinite_counter_queue_latency_and_reset_are_incomplete(self):
        for number in (float('nan'),float('inf'),-1):
            for key in ('queueLength','oldestQueuedAgeMs'):
                e=self.evidence();e['client'][2][key]=number
                self.assertEqual(assess(**e)['status'],'INCOMPLETE')
            e=self.evidence();e['client'][2]['inputs'][0]['latencyMs']=number
            self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['client'][0]['counters']['partialApplied']=1
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_missing_server_fields_never_become_zero(self):
        for area,keys in [('drops',('feed','tx_lag','snapshot')),('recording',('enabled','flush_failures','flush_stalls','last_flush_ts','last_flush_age_s','stalled'))]:
            for key in keys:
                e=self.evidence();del e['health'][3]['stats'][area][key]
                self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['health'][-1]['stats']['drops']['tx_lag']=1
        self.assertEqual(assess(**e)['status'],'FAIL')

    def test_driver_errors_and_exit_code_are_not_hidden_by_complete(self):
        for driver,code in [({'complete':True,'errors':['React error']},0),({'complete':True,'errors':[]},1)]:
            e=self.evidence();e.update(driver=driver,driver_exit=code)
            self.assertEqual(assess(**e)['status'],'FAIL')
        self.assertTrue(driver_issues({'complete':False,'errors':[]},0)[1])

    def test_whole_window_presentations_cannot_hide_frozen_heatmap(self):
        e=self.evidence()
        for sample in e['client']:
            for frame in sample['frames']:
                if 5000<=frame['endMs']<5350: frame['drew']=False
        r=assess(**e)
        self.assertEqual(r['status'],'FAIL');self.assertTrue(r['presentation']['pass'])
        self.assertGreater(r['chart_draw_continuity']['max_chart_draw_gap_ms'],250)
        e=self.evidence();del e['client'][4]['frames'][0]['drew']
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_plateau_and_sawtooth_growth_fail_stable_or_draining_pass(self):
        for lengths in ([i//2 for i in range(60)],[i//3*3-(i%3==1) for i in range(60)]):
            samples=[{'nowMs':i*1000,'queueLength':max(0,q),'oldestQueuedAgeMs':i*100} for i,q in enumerate(lengths)]
            self.assertFalse(backlog_gate(samples)['pass'])
        for lengths in ([3]*20,list(reversed(range(20)))):
            samples=[{'nowMs':i*1000,'queueLength':q,'oldestQueuedAgeMs':0} for i,q in enumerate(lengths)]
            self.assertTrue(backlog_gate(samples)['pass'])
        e=self.evidence();e['client']=e['client'][:1]+e['client'][8:];e['health']=e['health'][:len(e['client'])]
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_dead_pid_and_uncertain_gap_close_ownership(self):
        rows=[{'qpc_ms':0,'processes':[{'pid':1,'creation_ticks':10}]},
              {'qpc_ms':1000,'processes':[{'pid':1,'creation_ticks':10}]},
              {'qpc_ms':2000,'processes':[]},
              {'qpc_ms':8000,'processes':[{'pid':1,'creation_ticks':20}]}]
        self.assertEqual(ownership_intervals(rows),{1:[(0,1000),(8000,8000)]})
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'p.csv'
            path.write_text('ProcessID,SwapChainAddress,CPUStartQPC,DisplayLatency,DisplayedTime,VidPnSourceId,LayerIndex,PresentId\n1,a,900,2,16,0,0,1\n1,a,3000,2,16,0,0,2\n')
            events,_,rejected=presented_events(path,1000,ownership_intervals(rows))
            self.assertEqual(len(events),1);self.assertEqual(rejected['notOwnedAtEventTime'],1)
            self.assertEqual(events[0]['metadata']['PresentId'],'1')

    def test_replay_recording_is_explicitly_outside_scope(self):
        e=self.evidence();e['scope']='normalized-history-replay'
        for h in e['health']: h['stats']['recording']['enabled']=False;h['stats']['recording']['last_flush_ts']=None
        self.assertEqual(assess(**e)['status'],'PASS')
        e['verified']['history']=False
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e['scope']='live-recording'
        self.assertEqual(assess(**e)['status'],'FAIL')

    def test_campaign_requires_distinct_linked_history_and_live(self):
        common={'runtime_sha256':'runtime','provenance':{k:True for k in ('origin_verified','package_parity_verified','source_match_verified','unchanged_verified','identity_verified')},'source_fingerprint':'source','exe_sha256':'exe','resource_limits':{'cpu':1},'gpu_luid':'0,51707','gpu_identity':{'vendorId':4098,'deviceId':26131,'subSysId':76222531},
            'baseline':{'physical_content':[1920,1080]},'workload':{'market':'binance-spot','symbol':'BTCUSDT','band':'deep'}}
        history=common|{'evidence_id':'h','acceptance':{'status':'PASS','scope':'normalized-history-replay'},
            'verified':{'history':True},'history_evidence':{'span_seconds':3600}}
        live=common|{'evidence_id':'l','acceptance':{'status':'PASS','scope':'live-recording'}}
        soak=history|{'evidence_id':'soak','driver':{'measurementStartUnixMs':0,'measurementEndUnixMs':1800000}}
        boundary=[live|{'evidence_id':str(i),'driver':{'measurementStartUnixMs':0,'measurementEndUnixMs':600000}} for i in range(3)]
        live_soak=live|{'evidence_id':'live-soak','driver':{'measurementStartUnixMs':0,'measurementEndUnixMs':1800000}}
        self.assertEqual(campaign_assess(history,live)['coverage_status'],'PASS')
        self.assertFalse(campaign_assess(history,live)['minimum_certified'])
        self.assertFalse(campaign_assess(history,live,boundary,soak)['minimum_certified'])
        self.assertTrue(campaign_assess(history,live,boundary,soak,live_soak)['minimum_certified'])
        for target in ('history','live','boundary','soak','live_soak'):
            for mutation in ('missing','different','unverified'):
                hh,ll,bb,ss,ls=copy.deepcopy((history,live,boundary,soak,live_soak))
                victim={'history':hh,'live':ll,'boundary':bb[1],'soak':ss,'live_soak':ls}[target]
                if mutation=='missing': victim.pop('runtime_sha256')
                elif mutation=='different': victim['runtime_sha256']='other'
                else: victim['provenance']['origin_verified']=False
                self.assertFalse(campaign_assess(hh,ll,bb,ss,ls)['minimum_certified'])
        replay_boundary=[history|{'evidence_id':str(i),'driver':{'measurementStartUnixMs':0,'measurementEndUnixMs':600000}} for i in range(3)]
        short_live=live|{'driver':{'measurementStartUnixMs':0,'measurementEndUnixMs':5000}}
        self.assertFalse(campaign_assess(history,short_live,replay_boundary,soak)['minimum_certified'])
        short_soak=live_soak|{'driver':{'measurementStartUnixMs':0,'measurementEndUnixMs':1799999}}
        self.assertFalse(campaign_assess(history,live,boundary,soak,short_soak)['minimum_certified'])
        reused=live_soak|{'evidence_id':boundary[0]['evidence_id']}
        self.assertFalse(campaign_assess(history,live,boundary,soak,reused)['minimum_certified'])
        wrong_gpu=live_soak|{'gpu_identity':{'deviceId':99}}
        self.assertFalse(campaign_assess(history,live,boundary,soak,wrong_gpu)['minimum_certified'])
        live['acceptance']['scope']='diagnostic-live-only'
        self.assertEqual(campaign_assess(history,live)['status'],'INCOMPLETE')
        live['exe_sha256']='other';self.assertIn('Trial exe_sha256 linkage differs/absent.',campaign_assess(history,live)['missing'])

    def test_nested_client_and_server_types_are_incomplete_without_throwing(self):
        for key in ('inputs','frames','capabilities','requiredCounters','counters','geometry','subscription','overlays','overlayData','book','view','panels','health'):
            for bad in (None,'wrong',7):
                with self.subTest(key=key,bad=bad):
                    e=self.evidence();e['client'][4][key]=bad
                    self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for key in ('inputs','frames','panels'):
            e=self.evidence();e['client'][4][key]=[None,'wrong',7]
            self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for key in ('capabilities','requiredCounters'):
            e=self.evidence();e['client'][4][key]=[{}]
            self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for key in ('drops','recording'):
            for bad in (None,[],[{}],'wrong'):
                e=self.evidence();e['health'][4]['stats'][key]=bad
                self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_malformed_data_does_not_hide_known_failures(self):
        e=self.evidence();e['client'][4]['inputs']=None;e['presentation']['pass']=False
        self.assertEqual(assess(**e)['status'],'FAIL')
        e=self.evidence();e['client'][4]['counters']=None;e['client'][-1]['counters']['frameErrors']=1
        self.assertIn('frameErrors: 1',assess(**e)['failures'])
        e=self.evidence();e['health'][4]['stats']['recording']=None;e['health'][4]['stats']['drops']['feed']=1
        self.assertTrue(any('Server feed increased' in f for f in assess(**e)['failures']))
        e=self.evidence();e['health'][4]['stats']['drops']=None;e['health'][5]['stats']['drops']['feed']=1
        self.assertTrue(any('Server feed increased' in f for f in assess(**e)['failures']))
        e=self.evidence();e['client'][4]['counters']=None;e['client'][5]['counters']['frameErrors']=1
        self.assertIn('frameErrors: 1',assess(**e)['failures'])

    def test_guarded_reporting_writes_verdict_after_nested_or_unexpected_error(self):
        from run import guarded_main
        for known_failure in (False,True):
            with tempfile.TemporaryDirectory() as d:
                e=self.evidence();e['client'][4]['inputs']=None;e['presentation']['pass']=not known_failure
                state={'output':Path(d),'client':e['client'],'health':e['health'],'presentation':e['presentation'],
                       'start':e['start'],'end':e['end'],'scope':'diagnostic-live-only','driver':e['driver'],'driver_exit':0}
                def abort(): raise TypeError('nested object report path')
                with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(guarded_main(abort,state),2)
                result=json.loads((Path(d)/'result.json').read_text())
                self.assertEqual(result['acceptance']['status'],'FAIL' if known_failure else 'INCOMPLETE')
                self.assertTrue(result['report_recovered']);self.assertTrue((Path(d)/'summary.md').exists())

    def test_presentmon_drain_keeps_sampling_past_measurement_end(self):
        from run import drain_presentmon
        now=[0];rows=[]
        class FakePresentMon:
            def poll(self):return None if now[0]<11 else 0
        def sample():rows.append({'qpc_ms':now[0]*1000,'processes':[{'pid':1,'creation_ticks':10}]})
        def sleep(seconds):now[0]+=seconds
        drain_presentmon(FakePresentMon(),sample,20,clock=lambda:now[0],sleep=sleep)
        self.assertGreater(len(rows),3)
        self.assertLessEqual(max(b['qpc_ms']-a['qpc_ms'] for a,b in zip(rows,rows[1:])),1000)
        self.assertEqual(ownership_intervals(rows),{1:[(0,11000)]})
        self.assertTrue(any(lo<=0 and hi>=10475 for lo,hi in ownership_intervals(rows)[1]))

    def test_resource_schema_identity_coverage_and_no_shared_double_count(self):
        p=[{'schema':4,'unix_ms':i*1000,'qpc_ms':i*1000,
            'observation_start_unix_ms':i*1000,'observation_end_unix_ms':i*1000,
            'observation_start_qpc_ms':i*1000,'observation_end_qpc_ms':i*1000,'observation_duration_ms':0,
            'processes':[{'pid':1,'creation_ticks':10,'private_commit_bytes':100,'cpu_seconds':i,
                          'private_working_set_bytes':20,'working_set_bytes_not_summed':80,'private_working_set_source':NATIVE_PRIVATE_WS_SOURCE}],
            'private_commit_bytes':100,'private_working_set_bytes':20,'private_working_set_source':NATIVE_PRIVATE_WS_SOURCE,
            'owned_tree_complete':True,'job_pids_start':[1],'job_pids_end':[1],'confirmed_exits':[],'acquisition_issues':[]} for i in range(11)]
        system=[{'schema':3,'unix_ms':i*1000,'sample_start_unix_ms':i*1000,'errors':[],
            'owned_gpu_candidates':[{'kind':'allocation','pid':1,'expected_creation_ticks':10,'creation_ticks':10,
                'identity_verified_at_start':True,'identity_verified_at_end':True,'dedicated_bytes':999,'shared_bytes':999,'committed_bytes':999},
                {'kind':'engine','pid':1,'expected_creation_ticks':10,'creation_ticks':10,
                'identity_verified_at_start':True,'identity_verified_at_end':True,'utilization_percent':0}],
            'private_working_sets':[{'pid':1,'creation_ticks':10,'private_working_set_bytes':20}],
            'system_memory':{k:100 for k in ('AvailableBytes','CommittedBytes','CommitLimit','PagesInputPersec','PagesOutputPersec','PageReadsPersec','PageWritesPersec')},
            'per_core_cpu':[{'Name':f'0,{n}','PercentProcessorTime':20} for n in range(16)],'paging_file':[{'PercentUsage':0}],
            'gpu_process_allocations_unsummed':[{'pid':1,'creation_ticks':10,'luid':'0,51707','dedicated_bytes':999,'shared_bytes':999,'committed_bytes':999}],
            'gpu_adapter_host_totals':[{'luid':'0,51707','dedicated_bytes':999,'shared_bytes':999,'committed_bytes':999}],
            'owned_gpu_engines':[{'pid':1,'creation_ticks':10,'utilization_percent':0}]} for i in range(11)]
        r=resource_evidence(p,system,0,10000,16,'0,51707')
        self.assertTrue(r['available'],r['missing']);self.assertEqual(r['peak_private_working_set_bytes'],20)
        self.assertEqual(r['peak_private_commit_bytes'],100)
        for key in ('per_core_cpu','paging_file','gpu_process_allocations_unsummed','gpu_adapter_host_totals','owned_gpu_engines','system_memory','errors'):
            for bad_value in (None,'wrong',{},[None],[7]):
                bad=copy.deepcopy(system);bad[4][key]=bad_value
                self.assertFalse(resource_evidence(p,bad,0,10000,16,'0,51707')['available'],(key,bad_value))
        for bad_value in (None,'wrong',{},[None],[7]):
            bad=copy.deepcopy(p);bad[4]['processes']=bad_value
            self.assertFalse(resource_evidence(bad,system,0,10000,16,'0,51707')['available'])
        for key in ('per_core_cpu','paging_file','gpu_process_allocations_unsummed','system_memory'):
            bad=copy.deepcopy(system);del bad[4][key]
            self.assertFalse(resource_evidence(p,bad,0,10000,16,'0,51707')['available'])
        system[4]['private_working_sets'][0]['creation_ticks']=11
        result=resource_evidence(p,system,0,10000,16,'0,51707')
        self.assertTrue(result['available']);self.assertFalse(result['cim_private_ws_diagnostics']['available'])
        self.assertFalse(resource_evidence(p,[],0,10000,16,'0,51707')['available'])

    def test_native_benchmark_guard_and_normal_defaults_remain(self):
        source=(Path(__file__).resolve().parents[2]/'app/src-tauri/src/main.rs').read_text(encoding='utf-8')
        guard=source.index('benchmark environment requires the isolated benchmark build identity')
        self.assertLess(guard,source.index('app.path().app_data_dir()'))
        self.assertIn('.env("FLOWMAP_RECORDING_ENABLED", "1")',source)
        self.assertIn('let benchmark = handle.config().identifier == BENCHMARK_IDENTIFIER;',source)
        self.assertIn('if benchmark {\n',source)

    def test_fixture_production_writer_determinism_and_short_span_rejection(self):
        from create_fixture import generate
        from fixture import verify_fixture
        with tempfile.TemporaryDirectory() as d:
            a=generate(Path(d)/'a',1,4096);b=generate(Path(d)/'b',1,4096)
            self.assertEqual(a['content_sha256'],b['content_sha256']);self.assertEqual(a['history']['files'],b['history']['files'])
            self.assertEqual(a['columns'],4);self.assertEqual(a['timeWindowMs'],1000)
            with self.assertRaisesRegex(ValueError,'less than one hour'):verify_fixture(Path(d)/'a/recordings',a)
    def test_long_gap_fails_even_when_mean_fps_passes(self):
        times=[i*1000/60 for i in range(600) if not 3000<i*1000/60<3400]
        self.assertGreater(len(times)/10,30)
        self.assertFalse(presentation_gate(times,0,10000)['pass'])
        self.assertGreater(presentation_gate(times,0,10000)['max_display_gap_ms'],250)

    def test_any_five_second_window_matters(self):
        times=[i*1000/60 for i in range(300)]+[5000+i*1000/25 for i in range(125)]
        result=presentation_gate(times,0,10000)
        self.assertFalse(result['pass']); self.assertLess(result['worst_5s_fps'],30)

    def test_drop_and_unowned_rows_do_not_count(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'p.csv'
            fields=['ProcessID','SwapChainAddress','CPUStartQPC','DisplayLatency','DisplayedTime']
            with path.open('w',newline='') as f:
                w=csv.writer(f); w.writerow(fields)
                w.writerows([[1,'a',1000,2,16],[1,'a',1000,2,16],[1,'a',1100,2,'NA'],[2,'a',1000,2,16]])
            events,candidates,rejected=presented_events(path,1000,{1:[(0,2000)]})
            self.assertEqual(len(events),1); self.assertEqual(candidates,{'1:a':1})
            self.assertEqual(rejected,{'duplicateDisplayRow':1,'notDisplayed':1,'notOwnedAtEventTime':1})

    def test_no_evidence_never_passes(self):
        self.assertEqual(assess({},[],[],False,{})['status'],'INCOMPLETE')

    def test_identity_and_private_memory(self):
        self.assertFalse(identity_matches({'pid':1,'creation_ticks':1},{'pid':1,'creation_ticks':2}))
        rows=[{'pid':1,'creation_ticks':1,'private_commit_bytes':100,'working_set_bytes_not_summed':999},
              {'pid':2,'creation_ticks':2,'private_commit_bytes':200,'working_set_bytes_not_summed':999}]
        self.assertEqual(private_memory_totals(rows),{'private_commit_bytes':300,'private_working_set_bytes':None})
        with self.assertRaises(ValueError): private_memory_totals(rows+rows)

    def test_limits_are_budgets_and_validate(self):
        self.assertEqual(validate_limits(3,1250,1024,16)['cpu_percent_of_system'],12.5)
        for args in [(0,None,None,16),(65536,None,None,16),(None,0,None,16),(None,None,64,16)]:
            with self.assertRaises(ValueError): validate_limits(*args)

if __name__=='__main__': unittest.main()
