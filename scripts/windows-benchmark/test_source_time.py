import copy
import unittest

from core import assess, source_time_gate, source_book_cadence
import test_core


def samples(advance=lambda t:t, delay=0):
    rows=[]
    for i in range(21):
        now=i*1000
        source=int(advance(now)-delay)
        t0=(1_700_000_000_000+source)*1_000_000
        rows.append({'timeOriginMs':1_700_000_000_000,'nowMs':now,'session':'owned',
                     'capability':{'source_book_events':100+i},
                     'sourceTimeline':{'newestSeq':(source+60_000)//250,'newestT0Ns':str(t0),'dtNs':250_000_000,'edgeEndNs':str(t0+250_000_000)},
                     'sourceObservation':{'collectorTimeOriginMs':1_700_000_000_000,'collectorStartMs':now,'collectorEndMs':now},
                     'timeline':{'viewStartCol':10000-i*100,'viewEndCol':20000-i*100}})
    return rows


class SourceTimeTests(unittest.TestCase):
    def gate(self, rows,scope='live-recording'):
        return source_time_gate(rows,1_700_000_000_000,1_700_000_020_000,scope)

    def test_advancing_source_passes_while_camera_pans_independently(self):
        result=self.gate(samples())
        self.assertTrue(result['available'],result)
        self.assertTrue(result['pass'])
        self.assertEqual(result['samples'][-1]['source_debt_growth_ms'],0)

    def test_constant_delayed_source_and_short_plateau_catchup_pass(self):
        self.assertTrue(self.gate(samples(delay=2000))['pass'])
        self.assertTrue(self.gate(samples(lambda t:0 if t<2000 else t))['pass'])

    def test_stable_stale_live_fails_freshness_while_modest_delay_and_catchup_pass(self):
        stale=self.gate(samples(delay=20_000))
        self.assertTrue(stale['available'],stale)
        self.assertFalse(stale['pass'])
        self.assertIsNone(stale['failed_window'])  # No debt growth is needed for an already stale feed.
        self.assertGreater(stale['age_failed_window']['median_earliest_source_age_ms'],6000)
        self.assertTrue(self.gate(samples(delay=2000))['pass'])
        # Source initially 4 seconds late catches up to a stable 2-second delay;
        # progress temporarily exceeds wall time without becoming future-dated.
        self.assertTrue(self.gate(samples(lambda t:t+min(t,2000),delay=4000))['pass'])
        self.assertTrue(self.gate(samples(lambda t:0 if t<2000 else t,delay=2000))['pass'])
        # Two brief age outliers above 6000ms do not make a five-second median
        # stale; the initial plateau catches up before a full growth window.
        burst=self.gate(samples(lambda t:0 if t<3000 else t,delay=5500))
        self.assertTrue(burst['pass'],burst)
        self.assertIsNone(burst['age_failed_window'])
        evidence=test_core.MeasurementTests().evidence()
        for row in evidence['client']:
            edge=row['sourceTimeline']
            for key in ('newestT0Ns','edgeEndNs'): edge[key]=str(int(edge[key])-20_000_000_000)
        result=assess(**evidence)
        self.assertEqual(result['status'],'FAIL')
        self.assertIn('LIVE source-age workload exceeded its declared freshness allowance.',result['failures'])

    def test_age_policy_uses_exclusive_end_once_and_strict_six_second_median(self):
        # t0 is 6250ms old, so exclusive end is exactly 6000ms old: allowed.
        result=self.gate(samples(delay=6250))
        self.assertTrue(result['pass'],result)
        self.assertEqual(result['policy']['live_age_allowance_ms'],5000)
        self.assertEqual(result['policy']['host_provider_clock_uncertainty_ms'],1000)
        self.assertEqual(result['max_window_median_earliest_source_age_ms'],6000)
        stale=self.gate(samples(delay=6251))
        self.assertTrue(stale['available']);self.assertFalse(stale['pass'])
        self.assertEqual(stale['age_failed_window']['median_earliest_source_age_ms'],6001)

    def test_paired_forward_sequence_time_steps_and_future_epochs_are_incomplete(self):
        for first in (0,5):
            rows=samples()
            for row in rows[first:]:
                edge=row['sourceTimeline'];edge['newestSeq']+=240
                for key in ('newestT0Ns','edgeEndNs'): edge[key]=str(int(edge[key])+60_000_000_000)
            result=self.gate(rows)
            self.assertFalse(result['available'],first);self.assertIsNone(result['pass'])
            self.assertIn('LIVE source edge is implausibly future-dated beyond column width plus clock uncertainty.',result['missing'])
        evidence=test_core.MeasurementTests().evidence()
        for row in evidence['client'][5:]:
            edge=row['sourceTimeline'];edge['newestSeq']+=240
            for key in ('newestT0Ns','edgeEndNs'): edge[key]=str(int(edge[key])+60_000_000_000)
        self.assertEqual(assess(**evidence)['status'],'INCOMPLETE')

    def test_future_allowance_includes_column_width_plus_one_second_only(self):
        for extra_ns,available in ((0,True),(1,False)):
            rows=samples()
            for row in rows:
                edge=row['sourceTimeline'];edge['newestSeq']+=4
                for key in ('newestT0Ns','edgeEndNs'): edge[key]=str(int(edge[key])+1_000_000_000+extra_ns)
            result=self.gate(rows)
            self.assertEqual(result['available'],available,extra_ns)
            if available:
                self.assertTrue(result['pass'])
                self.assertEqual(result['samples'][0]['source_future_lead_ms'],1250)
            else: self.assertIsNone(result['pass'])

    def test_future_and_age_bounds_use_actual_rpc_end_and_start_respectively(self):
        rows=samples()
        for row in rows:
            row['sourceObservation']['collectorEndMs']+=100
            edge=row['sourceTimeline'];edge['newestSeq']+=4
            for key in ('newestT0Ns','edgeEndNs'): edge[key]=str(int(edge[key])+1_100_000_000)
        result=self.gate(rows)
        self.assertTrue(result['pass'],result)
        self.assertEqual(result['samples'][0]['source_future_lead_ms'],1250)
        rows=samples(delay=6250)
        for row in rows: row['sourceObservation']['collectorEndMs']+=500
        result=self.gate(rows)
        self.assertTrue(result['pass'],result)
        self.assertEqual(result['samples'][0]['earliest_possible_source_age_ms'],6000)
        self.assertEqual(result['samples'][0]['source_debt_high_ms'],6500)

    def test_slow_source_and_freeze_fail_with_zero_client_queue_and_good_fps(self):
        for advance in (lambda t:t//2,lambda t:0):
            result=self.gate(samples(advance))
            self.assertTrue(result['available'],result)
            self.assertFalse(result['pass'])
            self.assertGreaterEqual(result['failed_window']['source_debt_growth_low_ms'],1000)
        evidence=test_core.MeasurementTests().evidence()
        for row in evidence['client']:
            row['sourceTimeline']=copy.deepcopy(evidence['client'][0]['sourceTimeline'])
        result=assess(**evidence)
        self.assertEqual(result['status'],'FAIL')
        self.assertIn('Sustained LIVE source-time backlog growth observed.',result['failures'])

    def test_inclusive_one_second_growth_and_positive_slope(self):
        # Test a valid 250ms column grid at the exact 1000ms/10s boundary.
        rows=samples(lambda t:t-((t//10_000)*1000))
        result=self.gate(rows)
        self.assertFalse(result['pass'])
        self.assertEqual(result['failed_window']['source_debt_growth_low_ms'],1000)

    def test_missing_invalid_clock_resets_and_source_discontinuities_are_incomplete(self):
        for field,value in (('sourceTimeline',None),('sourceObservation',None),('timeOriginMs',42),('nowMs',0)):
            rows=samples(); rows[5][field]=value
            result=self.gate(rows)
            self.assertFalse(result['available'],field)
            self.assertIsNone(result['pass'])
        for field,value in (('newestT0Ns','nan'),('edgeEndNs','0'),('dtNs',0),('newestSeq',-1)):
            rows=samples(); rows[5]['sourceTimeline'][field]=value
            self.assertFalse(self.gate(rows)['available'],field)
        for field,value in (('collectorEndMs',-1),('collectorStartMs',100_000),('collectorTimeOriginMs',42)):
            rows=samples(); rows[5]['sourceObservation'][field]=value
            self.assertFalse(self.gate(rows)['available'],field)
        rows=samples(); rows[5]['sourceTimeline']['newestT0Ns']=str(int(rows[5]['sourceTimeline']['newestT0Ns'])+10_000_000_000)
        rows[5]['sourceTimeline']['edgeEndNs']=str(int(rows[5]['sourceTimeline']['edgeEndNs'])+10_000_000_000)
        self.assertFalse(self.gate(rows)['available'])

    def test_long_observation_interval_cannot_fabricate_conclusive_debt_growth(self):
        rows=samples(lambda t:t//2)
        rows[10]['sourceObservation']['collectorStartMs']=rows[10]['sourceObservation']['collectorEndMs']-10000
        self.assertFalse(self.gate(rows)['available'])

    def test_history_excluded_even_without_source_timeline(self):
        result=self.gate([{}],'normalized-history-replay')
        self.assertTrue(result['available']);self.assertTrue(result['pass']);self.assertTrue(result['excluded'])
        evidence=test_core.MeasurementTests().evidence();evidence['scope']='normalized-history-replay'
        for row in evidence['client']:
            row.pop('sourceTimeline');row.pop('sourceObservation')
        self.assertEqual(assess(**evidence)['status'],'PASS')

    def test_upstream_counter_cadence_is_separate_and_resets_remain_unavailable(self):
        rows=samples()
        result=source_book_cadence(rows)
        self.assertTrue(result['available']);self.assertEqual(result['delta'],20);self.assertEqual(result['per_second'],1)
        rows[10]['capability']['source_book_events']=0
        self.assertFalse(source_book_cadence(rows)['available'])
        rows=samples();rows[5]['capability']={}
        self.assertFalse(source_book_cadence(rows)['available'])


if __name__=='__main__': unittest.main()
