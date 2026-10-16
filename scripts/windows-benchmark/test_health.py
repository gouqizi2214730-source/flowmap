import copy
import contextlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

from core import assess
from health import HEALTH_CONTRACT
import test_core


CID = '12345678-1234-1234-1234-123456789abc'
URL = 'http://127.0.0.1:12345/api/health'


class IndependentHealthTests(unittest.TestCase):
    def evidence(self, intervals=None):
        e = test_core.MeasurementTests().evidence()
        # Fewer actual health observations than client snapshots, including one
        # genuine 3.4s query. No structurally paired/cached health is needed.
        intervals = intervals or [(-250,-200),(10,20),(250,3650),(4000,4010),(6000,6010),(8000,8010),(9750,9760),(10010,10020)]
        body = copy.deepcopy(e['health'][0])
        rows = []
        for i,(lo,hi) in enumerate(intervals,1):
            h = copy.deepcopy(body)
            flush = 100000+lo-500 if lo < 0 else 100000+min(hi-1,5000)
            h['stats']['recording'].update(last_flush_ts=int(flush*1e6),last_flush_age_s=round((100000+hi-flush)/1000,1))
            rows.append({'schema':1,'contract':HEALTH_CONTRACT,'collectionId':CID,'observationId':f'{CID}:{i}',
                'requestSequence':i,'url':URL,'method':'GET','collectorTimeOriginMs':100000,
                'requestStartMonoMs':10000+lo,'requestEndMonoMs':10000+hi,
                'requestStartUnixMs':100000+lo,'requestEndUnixMs':100000+hi,
                'requestDurationMs':hi-lo,'statusCode':200,'timedOut':False,'error':None,'responseBody':json.dumps(h)})
        # Keep the actual Node origin identical to the source RPC origin while
        # allowing the page's independently stamped client clock.
        for s in e['client']:
            s['sourceObservation']['collectorTimeOriginMs']=90000
            s['sourceObservation']['collectorStartMs']+=10000
            s['sourceObservation']['collectorEndMs']+=10000
        for row in rows:row['collectorTimeOriginMs']=90000
        e['health']=rows
        e['driver']['healthCollection']={'schema':1,'contract':HEALTH_CONTRACT,'collectionId':CID,'url':URL,
            'collectorTimeOriginMs':90000,'collectionStartMonoMs':9000,'collectionEndMonoMs':max(r['requestEndMonoMs'] for r in rows)+1,
            'timeoutMs':10000,'coverageLimitMs':5000,'drained':True,'errors':[],
            'stats':{'started':len(rows),'completed':len(rows),'failed':0,'skipped':13}}
        e.update(require_independent_health=True,health_target=URL)
        return e

    def mutate_body(self,e,index,action):
        body=json.loads(e['health'][index]['responseBody']);action(body)
        e['health'][index]['responseBody']=json.dumps(body)

    def test_independent_health_can_pass_with_3400ms_query_and_full_client_coverage(self):
        e=self.evidence();original=copy.deepcopy(e);r=assess(**e)
        self.assertEqual(r['status'],'PASS',r['missing']);self.assertEqual(e,original)
        self.assertEqual(r['health_coverage']['max_query_latency_ms'],3400)
        self.assertEqual(r['health_coverage']['permitted_gap_ms'],5000)
        self.assertEqual(r['client_coverage']['permitted_gap_ms'],3000)
        self.assertEqual(r['health_coverage']['measured_observations'],6)
        self.assertNotEqual(len(e['health']),len(e['client']))

    def test_missing_independent_contract_cannot_fallback_to_paired_or_cleared_errors(self):
        for key in ('healthCollection','errors'):
            e=self.evidence();del e['driver'][key]
            self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['health']=[];self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=test_core.MeasurementTests().evidence();e['require_independent_health']=True
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for key in ('contract','drained','errors','stats','collectorTimeOriginMs','collectionStartMonoMs','collectionEndMonoMs','timeoutMs','coverageLimitMs','url','collectionId'):
            e=self.evidence();del e['driver']['healthCollection'][key]
            self.assertEqual(assess(**e)['status'],'INCOMPLETE',key)

    def test_absent_end_bracket_is_incomplete_despite_short_covered_tail_and_recovery_preserves_fail(self):
        from run import guarded_main
        for known_failure in (False, True):
            e=self.evidence()
            e['health'].pop()
            collection=e['driver']['healthCollection']
            collection['stats'].update(started=len(e['health']),completed=len(e['health']))
            collection['collectionEndMonoMs']=e['end']-collection['collectorTimeOriginMs']+1
            e['presentation']['pass']=not known_failure
            r=assess(**e)
            self.assertEqual(r['status'],'FAIL' if known_failure else 'INCOMPLETE')
            self.assertLess(r['health_coverage']['max_gap_ms'],5000)
            self.assertIsNone(r['health_coverage']['end_bracketing_observation_id'])
            self.assertTrue(any('end-bracketing health observation absent' in m for m in r['missing']))
            with tempfile.TemporaryDirectory() as d:
                def abort(): raise RuntimeError('forced missing-bracket report recovery')
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(guarded_main(abort,dict(e,output=Path(d),scope='diagnostic-live-only')),2)
                result=json.loads((Path(d)/'result.json').read_text(encoding='utf-8'))
                self.assertEqual(result['acceptance']['status'],'FAIL' if known_failure else 'INCOMPLETE')
                self.assertTrue(result['report_recovered'])

    def test_duplicate_replayed_out_of_order_missing_future_nonfinite_bounds_rejected(self):
        cases=[('observationId',f'{CID}:2'),('requestSequence',2),('collectionId','old'),('collectorTimeOriginMs',89999),
            ('requestStartMonoMs',float('nan')),('requestEndMonoMs',float('inf')),('requestDurationMs',0),
            ('requestEndUnixMs',120000),('requestStartUnixMs',99999),('url','http://127.0.0.1:1/api/health'),
            ('statusCode',302),('error','cached error'),('timedOut',True),('responseBody','{"bad":NaN}')]
        cases.extend([('responseBody','[]'),('responseBody','null'),('responseBody','7'),('schema',True)])
        for key,value in cases:
            with self.subTest(key=key):
                e=self.evidence();e['health'][3][key]=value
                self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        for key in self.evidence()['health'][3]:
            e=self.evidence();del e['health'][3][key]
            self.assertEqual(assess(**e)['status'],'INCOMPLETE',key)
        e=self.evidence();e['health'][2],e['health'][3]=e['health'][3],e['health'][2]
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['health'].pop(3);e['driver']['healthCollection']['stats'].update(started=7,completed=7)
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_early_warmup_loss_history_lag_and_reset_do_not_become_measured_loss(self):
        e=self.evidence([(-1000,-950),(-500,-450),(-250,-200),(10,20),(250,3650),(4000,4010),(6000,6010),(8000,8010),(9750,9760),(10010,10020)])
        self.mutate_body(e,0,lambda h:h['stats']['drops'].update(tx_lag=99))
        self.mutate_body(e,1,lambda h:h['stats']['drops'].update(tx_lag=100))
        r=assess(**e);self.assertEqual(r['status'],'PASS',r['missing'])
        self.assertEqual(r['health_coverage']['baseline_observation_id'],f'{CID}:3')

    def test_late_response_cannot_fill_health_gap_or_invent_fresh_flush(self):
        e=self.evidence([(-250,-200),(10,20),(2000,2010),(4000,4010),(4250,10500)])
        r=assess(**e);self.assertEqual(r['status'],'INCOMPLETE');self.assertGreater(r['health_coverage']['max_gap_ms'],5000)
        e=self.evidence()
        for i in range(len(e['health'])-1):
            self.mutate_body(e,i,lambda h:h['stats']['recording'].update(last_flush_ts=99000000000,last_flush_age_s=None))
        self.mutate_body(e,-1,lambda h:h['stats']['recording'].update(last_flush_ts=109990000000,last_flush_age_s=0))
        r=assess(**e);self.assertEqual(r['status'],'INCOMPLETE')
        self.assertIn('No fresh successful recording flush within measured live trial.',r['missing'])
        self.assertIn(f'{CID}:8',r['health_coverage']['excluded_observation_ids'])

    def test_stale_replayed_body_future_flush_and_uncertain_start_are_incomplete(self):
        e=self.evidence();e['health'][4]['responseBody']=e['health'][1]['responseBody']
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();self.mutate_body(e,3,lambda h:h['stats']['recording'].update(last_flush_ts=109000000000,last_flush_age_s=0))
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['health'][0]['requestEndMonoMs']=10001;e['health'][0]['requestEndUnixMs']=100001;e['health'][0]['requestDurationMs']=251
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['health'][0]['requestStartMonoMs']=4000;e['health'][0]['requestStartUnixMs']=94000
        e['health'][0]['requestDurationMs']=5800;e['driver']['healthCollection']['collectionStartMonoMs']=3000
        e['health'][0]['requestEndMonoMs']=5000;e['health'][0]['requestEndUnixMs']=95000;e['health'][0]['requestDurationMs']=1000
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')

    def test_all_old_server_loss_recording_and_client_gates_remain_mandatory(self):
        for area,key in [('drops','feed'),('drops','tx_lag'),('drops','snapshot'),('recording','flush_failures'),('recording','flush_stalls')]:
            e=self.evidence();self.mutate_body(e,4,lambda h:h['stats'][area].update({key:1}))
            self.assertEqual(assess(**e)['status'],'FAIL',key)
        for key,value in [('enabled',False),('stalled',True)]:
            e=self.evidence();self.mutate_body(e,4,lambda h:h['stats']['recording'].update({key:value}))
            self.assertEqual(assess(**e)['status'],'FAIL')
        e=self.evidence();self.mutate_body(e,0,lambda h:h['stats']['drops'].update(feed=1))
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();self.mutate_body(e,4,lambda h:h['stats']['recording'].pop('last_flush_ts'))
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['client']=e['client'][:1]+e['client'][5:]
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['client'][5]['counters']['frameErrors']=1
        self.assertEqual(assess(**e)['status'],'FAIL')

    def test_observed_errors_and_failed_drain_even_outside_window_disqualify(self):
        for index in (0,3,-1):
            e=self.evidence();e['health'][index].update(error='HTTP timeout',timedOut=True,statusCode=None)
            self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['driver']['healthCollection']['errors']=['write failed']
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')
        e=self.evidence();e['presentation']['pass']=False;e['health'][3]=None
        self.assertEqual(assess(**e)['status'],'FAIL')

    def test_changed_counter_or_recorder_in_request_crossing_end_stays_uncertain(self):
        for area,key,value in [('drops','feed',1),('recording','stalled',True),('recording','enabled',False)]:
            e=self.evidence([(-250,-200),(10,20),(250,3650),(4000,4010),(6000,6010),(8000,8010),(9750,10200)])
            self.mutate_body(e,-1,lambda h:h['stats'][area].update({key:value}))
            r=assess(**e);self.assertEqual(r['status'],'INCOMPLETE')
            self.assertTrue(any('end-bracketing' in m for m in r['missing']))

    def test_idle_final_request_at_or_after_end_keeps_changed_state_uncertain(self):
        changes=[('drops','feed',1),('drops','tx_lag',1),('drops','snapshot',1),
                 ('recording','flush_failures',1),('recording','flush_stalls',1),
                 ('recording','enabled',False),('recording','stalled',True)]
        for lo in (9750,10000,10010):
            intervals=[(-250,-200),(10,20),(250,3650),(4000,4010),(6000,6010),(8000,8010),(9500,9510),(lo,10200)]
            unchanged=self.evidence(intervals)
            r=assess(**unchanged)
            self.assertEqual(r['status'],'PASS',r['missing'])
            self.assertEqual(r['health_coverage']['end_bracketing_observation_id'],f'{CID}:8')
            self.assertIn(f'{CID}:8',r['health_coverage']['excluded_observation_ids'])
            self.assertNotIn(f'{CID}:8',r['health_coverage']['used_observation_ids'])
            for area,key,value in changes:
                with self.subTest(start=lo,field=key):
                    e=copy.deepcopy(unchanged)
                    self.mutate_body(e,-1,lambda h:h['stats'][area].update({key:value}))
                    r=assess(**e)
                    self.assertEqual(r['status'],'INCOMPLETE');self.assertEqual(r['failures'],[])
                    self.assertTrue(any('end-bracketing' in m for m in r['missing']))
            e=copy.deepcopy(unchanged);self.mutate_body(e,-1,lambda h:h.update(recording_enabled=False))
            r=assess(**e);self.assertEqual(r['status'],'INCOMPLETE');self.assertEqual(r['failures'],[])

    def test_first_end_bracketing_counter_reset_is_uncertain_not_definite_failure(self):
        for area,key in [('drops','feed'),('drops','tx_lag'),('drops','snapshot'),
                         ('recording','flush_failures'),('recording','flush_stalls')]:
            for lo in (10000,10010):
                e=self.evidence([(-250,-200),(10,20),(250,3650),(4000,4010),(6000,6010),(8000,8010),(9750,9760),(lo,10200)])
                for i in range(len(e['health'])):
                    self.mutate_body(e,i,lambda h:h['stats'][area].update({key:2}))
                self.mutate_body(e,-1,lambda h:h['stats'][area].update({key:1}))
                r=assess(**e);self.assertEqual(r['status'],'INCOMPLETE');self.assertEqual(r['failures'],[])
                self.assertTrue(any('end-bracketing' in m for m in r['missing']))

    def test_post_end_bracket_supplies_neither_measured_coverage_nor_fresh_flush(self):
        e=self.evidence([(-250,-200),(10,20),(2000,2010),(4000,4010),(10010,10200)])
        for i,row in enumerate(e['health']):
            self.mutate_body(e,i,lambda h:h['stats']['recording'].update(
                last_flush_ts=99000000000,last_flush_age_s=round((row['requestEndUnixMs']-99000)/1000,1)))
        self.mutate_body(e,-1,lambda h:h['stats']['recording'].update(last_flush_ts=109990000000,last_flush_age_s=.2))
        r=assess(**e);self.assertEqual(r['status'],'INCOMPLETE');self.assertEqual(r['failures'],[])
        self.assertGreater(r['health_coverage']['max_gap_ms'],5000)
        self.assertIn(f'{CID}:5',r['health_coverage']['excluded_observation_ids'])
        self.assertIn('No fresh successful recording flush within measured live trial.',r['missing'])

    def oversized_mutations(self, huge=None):
        # Round-trip legal JSON rather than relying on a non-JSON Python type.
        if huge is None:huge=json.loads('1'+'0'*400)
        for key in ('requestSequence','collectorTimeOriginMs','requestStartMonoMs','requestEndMonoMs',
                    'requestStartUnixMs','requestEndUnixMs','requestDurationMs'):
            yield 'row.'+key,lambda e,k=key:e['health'][3].update({k:huge})
        for key in ('collectorTimeOriginMs','collectionStartMonoMs','collectionEndMonoMs'):
            yield 'collection.'+key,lambda e,k=key:e['driver']['healthCollection'].update({k:huge})
        for key in ('started','completed','failed','skipped'):
            yield 'stats.'+key,lambda e,k=key:e['driver']['healthCollection']['stats'].update({k:huge})
        for area,keys in [('drops',('feed','tx_lag','snapshot')),
                          ('recording',('flush_failures','flush_stalls','last_flush_ts','last_flush_age_s'))]:
            for key in keys:
                yield area+'.'+key,lambda e,a=area,k=key:self.mutate_body(e,3,lambda h:h['stats'][a].update({k:huge}))

    def test_oversized_legal_json_numbers_rejected_without_hiding_known_failure(self):
        for label,mutate in self.oversized_mutations():
            for known_failure in (False,True):
                with self.subTest(field=label,known_failure=known_failure):
                    e=self.evidence();mutate(e);e['presentation']['pass']=not known_failure
                    r=assess(**e)
                    self.assertEqual(r['status'],'FAIL' if known_failure else 'INCOMPLETE')
                    self.assertTrue(r['missing'])
                    if known_failure:self.assertIn('Presented FPS or display gap gate failed.',r['failures'])

    def test_guarded_recovery_writes_verdict_for_oversized_numbers_and_retains_known_failure(self):
        from run import guarded_main
        for label,mutate in self.oversized_mutations():
            for known_failure in (False,True):
                with self.subTest(field=label,known_failure=known_failure),tempfile.TemporaryDirectory() as d:
                    e=self.evidence();mutate(e);e['presentation']['pass']=not known_failure
                    state=dict(e,output=Path(d),scope='diagnostic-live-only')
                    def abort():raise RuntimeError('forced report failure')
                    with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(guarded_main(abort,state),2)
                    result=json.loads((Path(d)/'result.json').read_text(encoding='utf-8'))
                    self.assertEqual(result['acceptance']['status'],'FAIL' if known_failure else 'INCOMPLETE')
                    self.assertTrue(result['report_recovered']);self.assertTrue((Path(d)/'summary.md').exists())
                    self.assertTrue(any('forced report failure' in m for m in result['acceptance']['missing']))
                    if known_failure:self.assertIn('Presented FPS or display gap gate failed.',result['acceptance']['failures'])

    def finite_range_values(self):
        # Both sides of the age*1000 overflow boundary, plus the largest
        # finite float/int conversion. Round-trip to actual JSON number types.
        values=[10**power for power in (300,305,306,307,308)]
        boundary=sys.float_info.max/1000
        values += [1e300,1e305,1e306,1e307,1e308,
                   math.nextafter(boundary,0),boundary,math.nextafter(boundary,math.inf),
                   sys.float_info.max,int(sys.float_info.max)]
        return [json.loads(json.dumps(value,allow_nan=False)) for value in values]

    def test_finite_numeric_range_assessment_and_guarded_recovery_never_throw(self):
        from run import guarded_main
        for value in self.finite_range_values():
            self.assertTrue(math.isfinite(value))
            for label,mutate in self.oversized_mutations(value):
                for known_failure in (False,True):
                    with self.subTest(value=value,type=type(value).__name__,field=label,known_failure=known_failure):
                        e=self.evidence();mutate(e);e['presentation']['pass']=not known_failure
                        r=assess(**e)
                        # Finite cumulative counters retain their loss/reset gates;
                        # a large skipped count alone is valid diagnostic metadata.
                        if label=='stats.skipped':expected='FAIL' if known_failure else 'PASS'
                        elif label in ('drops.feed','drops.tx_lag','drops.snapshot',
                                       'recording.flush_failures','recording.flush_stalls'):expected='FAIL'
                        else:expected='FAIL' if known_failure else 'INCOMPLETE'
                        self.assertEqual(r['status'],expected)
                        if expected=='INCOMPLETE':self.assertTrue(r['missing'])
                        if known_failure:self.assertIn('Presented FPS or display gap gate failed.',r['failures'])
                        with tempfile.TemporaryDirectory() as d:
                            state=dict(e,output=Path(d),scope='diagnostic-live-only')
                            def abort():raise RuntimeError('forced finite-range report failure')
                            with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(guarded_main(abort,state),2)
                            result=json.loads((Path(d)/'result.json').read_text(encoding='utf-8'))
                            self.assertEqual(result['acceptance']['status'],'INCOMPLETE' if expected=='PASS' else expected)
                            self.assertTrue(result['report_recovered'])
                            self.assertTrue((Path(d)/'summary.md').exists())
                            self.assertTrue(any('forced finite-range report failure' in m for m in result['acceptance']['missing']))
                            if known_failure:self.assertIn('Presented FPS or display gap gate failed.',result['acceptance']['failures'])

    def test_recorder_age_interval_tolerance_is_unchanged(self):
        # Request is [104000,104010]ms, flush is 103000ms: inclusive
        # age bounds remain [.949,1.061] seconds (original +/-51ms).
        for age,expected in [(.949,'PASS'),(1.061,'PASS'),(.948999,'INCOMPLETE'),(1.061001,'INCOMPLETE')]:
            with self.subTest(age=age):
                e=self.evidence()
                self.mutate_body(e,3,lambda h:h['stats']['recording'].update(last_flush_ts=103000000000,last_flush_age_s=age))
                self.assertEqual(assess(**e)['status'],expected)

    def test_health_workload_is_verified_in_its_own_actual_observations(self):
        e=self.evidence();e['manifest']={'market':'binance-spot','symbol':'BTCUSDT','mode':'live'}
        for s in e['client']:s['session']='owned'
        for i in range(len(e['health'])):
            self.mutate_body(e,i,lambda h:h.update(feeds=[dict(e['manifest'],session_id='owned',state='live')]))
        self.assertEqual(assess(**e)['status'],'PASS')
        self.mutate_body(e,4,lambda h:h['feeds'][0].update(session_id='stale'))
        self.assertEqual(assess(**e)['status'],'INCOMPLETE')


if __name__=='__main__':unittest.main()
