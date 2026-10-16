"""Independent exhaustive reference for all pre-optimization window semantics."""
import random
from statistics import median
import unittest

from core import source_window_summary, source_time_gate


def reference(rows):
    windows=[]
    for i,first in enumerate(rows):
        block=[s for s in rows[i:] if s['collector_end_ms']-first['collector_end_ms']<=10000]
        for j,last in enumerate(block):
            if j<2 or last['collector_end_ms']-first['collector_end_ms']<5000:continue
            prefix=block[:j+1]
            x=[s['collector_end_ms']-first['collector_end_ms'] for s in prefix]
            y=[s['source_debt_growth_ms'] for s in prefix]
            xm,ym=sum(x)/len(x),sum(y)/len(y)
            slope=sum((a-xm)*(b-ym) for a,b in zip(x,y))/sum((a-xm)**2 for a in x)
            growth=last['collector_start_ms']-first['collector_end_ms']-(int(last['edge_end_ns'])-int(first['edge_end_ns']))/1e6
            windows.append({'start_collector_ms':first['collector_end_ms'],'end_collector_ms':last['collector_end_ms'],
                            'source_debt_growth_low_ms':growth,'source_debt_slope_ms_per_second':slope*1000})
    times=[r['collector_end_ms'] for r in rows]
    starts={times[0],times[-1]-5000}
    for at in times:
        for boundary in (at,at-5000):starts.update((boundary,boundary+.000001))
    ages=[]
    for at in sorted(s for s in starts if times[0]<=s<=times[-1]-5000):
        block=[r for r in rows if at<=r['collector_end_ms']<=at+5000]
        if len(block)<2:continue
        ages.append({'start_collector_ms':at,'end_collector_ms':at+5000,'samples':len(block),
                     'median_earliest_source_age_ms':median(r['earliest_possible_source_age_ms'] for r in block)})
    return {'failed_window':next((w for w in windows if w['source_debt_growth_low_ms']>=1000 and w['source_debt_slope_ms_per_second']>0),None),
            'age_failed_window':next((w for w in ages if w['median_earliest_source_age_ms']>6000),None),
            'max_window_debt_growth_low_ms':max((w['source_debt_growth_low_ms'] for w in windows),default=None),
            'max_window_median_earliest_source_age_ms':max((w['median_earliest_source_age_ms'] for w in ages),default=None),
            'growth_count':len(windows),'age_count':len(ages)}


def long_live_fixture(seconds=1800):
    origin=1_700_000_000_000
    rows=[]
    for i in range(seconds*4+1):
        now=i*250;t0=(origin+now-2000)*1_000_000
        rows.append({'timeOriginMs':origin,'nowMs':now,
            'sourceTimeline':{'newestSeq':i,'newestT0Ns':str(t0),'edgeEndNs':str(t0+250_000_000),'dtNs':250_000_000},
            'sourceObservation':{'collectorTimeOriginMs':origin,'collectorStartMs':now,'collectorEndMs':now+2}})
    return rows,origin,origin+seconds*1000


class SourceWindowParityTests(unittest.TestCase):
    def test_bounded_summary_matches_independent_exhaustive_windows(self):
        for seed in range(24):
            rng=random.Random(seed);rows=[];at=0;edge=0
            for i in range(110):
                at+=rng.choice([125,250,500,777])
                if seed%6==0:edge=at  # stable debt, exact zero slope
                elif seed%6==1:edge=at//250*250-2000  # modest stable delay
                elif seed%6==2:edge=at//500*250  # slowdown
                elif seed%6==3:edge=max(0,at-9000)  # plateau then catch-up
                elif seed%6==4:edge=at-(1000 if at>=10000 else 0)  # exact inclusive growth
                else:edge+=rng.choice([0,0,250,500,1000])
                rows.append({'collector_start_ms':at-rng.randrange(0,25),'collector_end_ms':at,
                             'edge_end_ns':str((1_700_000_000_000+edge)*1_000_000),
                             'source_debt_growth_ms':at-edge,'earliest_possible_source_age_ms':at-edge})
            with self.subTest(seed=seed):
                expected,actual=reference(rows),source_window_summary(rows)
                for key in ('age_failed_window','max_window_debt_growth_low_ms','max_window_median_earliest_source_age_ms'):
                    self.assertEqual(actual[key],expected[key],key)
                self.assertEqual(actual['window_evaluation']['growth_windows'],expected['growth_count'])
                self.assertEqual(actual['window_evaluation']['age_windows'],expected['age_count'])
                a,b=actual['failed_window'],expected['failed_window']
                self.assertEqual(a is None,b is None)
                if a:
                    for key in ('start_collector_ms','end_collector_ms','source_debt_growth_low_ms'):self.assertEqual(a[key],b[key])
                    self.assertAlmostEqual(a['source_debt_slope_ms_per_second'],b['source_debt_slope_ms_per_second'],places=8)

    def test_1800_second_four_hz_fixture_keeps_raw_samples_and_bounded_window_members(self):
        rows,start,end=long_live_fixture()
        result=source_time_gate(rows,start,end,'live-recording')
        self.assertTrue(result['pass'],result.get('missing'))
        self.assertEqual(len(result['samples']),7201)
        self.assertLessEqual(result['window_evaluation']['max_growth_window_samples'],41)
        self.assertLessEqual(result['window_evaluation']['max_age_window_samples'],21)
        self.assertGreater(result['window_evaluation']['growth_windows'],140000)


if __name__=='__main__':unittest.main()
