"""Pure measurement logic. Missing evidence is INCOMPLETE, never a passing fallback."""
from __future__ import annotations
from provenance import provenance_verified
from health import HEALTH_CONTRACT, health_observations
import bisect
import csv
import hashlib
import math
from collections import Counter
from decimal import Decimal
from pathlib import Path
from statistics import median

NATIVE_PRIVATE_WS_SOURCE = 'GetProcessMemoryInfo/PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize'


def percentile(values, p):
    if not values or not 0 <= p <= 1:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


def identity_matches(expected, observed):
    return bool(observed and expected['pid'] == observed['pid'] and
                expected['creation_ticks'] == observed['creation_ticks'])


def validate_limits(affinity, cpu_rate, commit_mib, logical_count):
    if logical_count > 64:
        raise ValueError('This harness supports one processor group (at most 64 logical CPUs).')
    if affinity is not None and (affinity <= 0 or affinity >> logical_count):
        raise ValueError('Affinity must be nonzero and fit the available logical processors.')
    if cpu_rate is not None and not 1 <= cpu_rate <= 10_000:
        raise ValueError('CPU rate is an integer from 1 to 10000 (100 = 1% of system CPU).')
    if commit_mib is not None and commit_mib < 128:
        raise ValueError('Job private commit budget must be at least 128 MiB.')
    return {'affinity_mask': affinity, 'logical_processors_allowed': affinity.bit_count() if affinity else logical_count,
            'cpu_hard_rate': cpu_rate, 'cpu_percent_of_system': cpu_rate / 100 if cpu_rate else None,
            'app_job_commit_limit_bytes': commit_mib * 1048576 if commit_mib else None,
            'meaning': 'Affinity and CPU hard cap on this host; aggregate job commit, not installed RAM or another CPU model.'}


def private_memory_totals(rows):
    """Never sum WorkingSet (which includes shared pages) or add GPU shared allocation to RAM."""
    ids = [(r['pid'], r['creation_ticks']) for r in rows]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate process identity in memory sample')
    return {'private_commit_bytes': sum(r['private_commit_bytes'] for r in rows),
            'private_working_set_bytes': (sum(r['private_working_set_bytes'] for r in rows)
                                          if all(r.get('private_working_set_bytes') is not None for r in rows) else None)}


def fixture_files(root):
    root = Path(root).resolve()
    result = []
    for path in sorted(root.rglob('*.parquet')):
        if path.is_symlink() or root not in path.resolve().parents:
            raise ValueError('Fixture symlink/reparse escape')
        result.append({'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return result


def presented_events(path, qpc_frequency, ownership):
    """PresentMon v2 QPC start + display latency = display-change timestamp.
    Retain dropped rows in raw CSV. Filter by observed process birth/death QPC.
    ownership maps PID to intervals [birth-qpc-ms, last-observed/end-qpc-ms].
    """
    events, candidates, rejected, seen = [], Counter(), Counter(), set()
    with Path(path).open(newline='', encoding='utf-8-sig') as source:
        reader = csv.DictReader(source)
        required = {'ProcessID', 'SwapChainAddress', 'CPUStartQPC', 'DisplayLatency', 'DisplayedTime'}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f'Unsupported presentation CSV; required {sorted(required)}, got {reader.fieldnames}')
        for row in reader:
            pid = int(row['ProcessID'])
            start = float(row['CPUStartQPC']) * 1000 / qpc_frequency
            if not any(lo <= start <= hi for lo, hi in ownership.get(pid, [])):
                rejected['notOwnedAtEventTime'] += 1
                continue
            stream = f"{pid}:{row['SwapChainAddress']}"
            if row['DisplayedTime'].strip().upper() in {'NA', 'N/A', '', 'NAN'}:
                rejected['notDisplayed'] += 1
                continue
            latency, displayed = float(row['DisplayLatency']), float(row['DisplayedTime'])
            if not (math.isfinite(latency) and latency >= 0 and math.isfinite(displayed) and displayed > 0):
                rejected['invalidDisplayMetric'] += 1
                continue
            at = start + latency
            key = (stream, at)
            if key in seen:
                rejected['duplicateDisplayRow'] += 1
                continue
            seen.add(key); candidates[stream] += 1
            events.append({'stream': stream, 'qpc_ms': at, 'displayed_ms': displayed,
                           'metadata': {k: row.get(k) for k in ('VidPnSourceId', 'LayerIndex', 'PresentId', 'PresentMode')}})
    return events, dict(candidates), dict(rejected)


def presentation_gate(times, start, end):
    times = sorted(set(t for t in times if start <= t < end))
    if end - start < 5000 or not times:
        return {'available': False, 'reason': 'No displayed events or less than one full 5-second window.'}
    # Counts change only when either edge crosses an event. Test both sides.
    starts = {start, end - 5000}
    for t in times:
        for boundary in (t, t + 0.000001, t - 5000, t - 5000 + 0.000001):
            if start <= boundary <= end - 5000:
                starts.add(boundary)
    windows = [(s, (bisect.bisect_left(times, s + 5000) - bisect.bisect_left(times, s)) / 5) for s in starts]
    worst = min(windows, key=lambda v: v[1])
    gaps = [times[0] - start, end - times[-1]] + [b - a for a, b in zip(times, times[1:])]
    return {'available': True, 'frames': len(times), 'duration_ms': end - start,
            'worst_5s_fps': worst[1], 'worst_window_start_qpc_ms': worst[0],
            'max_display_gap_ms': max(gaps), 'pass': worst[1] >= 30 and max(gaps) <= 250}


def chart_draw_gate(client,start,end):
    """CPU chart completion continuity, distinct from whole-window presentation."""
    if not finite(start) or not finite(end) or end<=start: return {'available':False}
    sample_coverage=coverage([client_timestamp(s) for s in client],start,end,3000)
    if not sample_coverage['available']: return {'available':False,'reason':'Missing chart telemetry coverage; no freeze inferred from missing samples.'}
    times=[]
    for s in client:
        if s.get('_malformed_frames') or not finite(s.get('timeOriginMs')) or not isinstance(s.get('frames'),list): return {'available':False}
        for f in s['frames']:
            if not isinstance(f.get('drew'),bool) or not finite(f.get('endMs')): return {'available':False}
            at=s['timeOriginMs']+f['endMs']
            if f['drew'] and start<=at<end: times.append(at)
    times=sorted(set(times))
    if not times: return {'available':False}
    gaps=[times[0]-start,end-times[-1]]+[b-a for a,b in zip(times,times[1:])]
    return {'available':True,'draws':len(times),'max_chart_draw_gap_ms':max(gaps),'pass':max(gaps)<=250,
            'meaning':'CPU chart draw completion continuity; never displayed FPS or screen latency.'}


COUNTERS = ('finalizedReceived', 'partialReceived', 'finalizedApplied', 'partialApplied',
            'partialReplaced', 'finalizedHistoryOmitted', 'partialHistoryOmitted',
            'telemetryOverflow', 'streamIngestErrors', 'frameErrors',
            'historyReceived', 'historyApplied', 'historyOmitted:staleSession') + tuple(
    f'{kind}Discarded:{reason}' for reason in ('sessionReset', 'contextLost', 'unattributed', 'row-mismatch', 'queueOverflow')
    for kind in ('finalized', 'partial')) + tuple(
    f'historyDiscarded:{reason}' for reason in ('contextLost', 'noRing', 'rowMismatch', 'writeError'))
CAPABILITIES = {'stream-discard-v1', 'history-discard-v1', 'queue-age-v1', 'input-draw-v1'}


def finite(value, minimum=0):
    if not isinstance(value, (int, float)) or isinstance(value, bool): return False
    try: return math.isfinite(value) and value >= minimum
    except OverflowError: return False


def object_map(value, path, problems):
    if isinstance(value,dict): return dict(value)
    problems.append(f'Malformed {path}: expected object, got {type(value).__name__}.')
    return {}


def object_rows(value, path, problems):
    if not isinstance(value,list):
        problems.append(f'Malformed {path}: expected array, got {type(value).__name__}.'); return []
    return [object_map(row,f'{path}[{i}]',problems) for i,row in enumerate(value)]


def string_rows(value, path, problems):
    if not isinstance(value,list) or not all(isinstance(v,str) for v in value):
        problems.append(f'Malformed {path}: expected string array.'); return []
    return list(value)


def normalize_health(value, path, problems):
    h=object_map(value,path,problems)
    h['stats']=object_map(h.get('stats'),path+'.stats',problems)
    for key in ('drops','recording'):
        h['stats'][key]=object_map(h['stats'].get(key),path+'.stats.'+key,problems)
    if 'feeds' in h: h['feeds']=object_rows(h['feeds'],path+'.feeds',problems)
    return h


def normalize_client(value, problems):
    rows=object_rows(value,'client',problems)
    for i,s in enumerate(rows):
        path=f'client[{i}]'
        for key in ('capabilities','requiredCounters'):
            s[key]=string_rows(s.get(key),path+'.'+key,problems)
        s['counters']=object_map(s.get('counters'),path+'.counters',problems)
        for key in ('inputs','frames'):
            original=s.get(key)
            if key=='frames' and (not isinstance(original,list) or any(not isinstance(x,dict) for x in original)):
                s['_malformed_frames']=True
            s[key]=object_rows(original,path+'.'+key,problems)
        for key in ('geometry','subscription','overlays','overlayData','book','view'):
            if key in s: s[key]=object_map(s[key],path+'.'+key,problems)
        if 'panels' in s: s['panels']=object_rows(s['panels'],path+'.panels',problems)
        if 'health' in s: s['health']=normalize_health(s['health'],path+'.health',problems)
    return rows


def normalize_resources(process, system, problems):
    processes=object_rows(process,'process',problems); systems=object_rows(system,'system',problems)
    for i,row in enumerate(processes):
        row['processes']=object_rows(row.get('processes'),f'process[{i}].processes',problems)
    for i,row in enumerate(systems):
        row['system_memory']=object_map(row.get('system_memory'),f'system[{i}].system_memory',problems)
        for key in ('per_core_cpu','paging_file','gpu_process_allocations_unsummed','gpu_adapter_host_totals','owned_gpu_engines'):
            row[key]=object_rows(row.get(key),f'system[{i}].{key}',problems)
        diagnostic=[]
        row['private_working_sets']=object_rows(row.get('private_working_sets'),f'system[{i}].private_working_sets',diagnostic)
        row['private_ws_diagnostic_errors']=string_rows(row.get('private_ws_diagnostic_errors',[]),'private_ws_diagnostic_errors',diagnostic)+diagnostic
        if not isinstance(row.get('errors'),list) or not all(isinstance(e,str) for e in row.get('errors',[])):
            problems.append(f'Malformed system[{i}].errors: expected string array.'); row['errors']=['Malformed sampler errors array.']
    for rows,fields in ((processes,('processes',)),(systems,('gpu_process_allocations_unsummed','owned_gpu_engines'))):
        for row in rows:
            for field in fields:
                for item in row[field]:
                    for key in ('pid','creation_ticks'):
                        if not finite(item.get(key),1) or int(item[key])!=item[key]:
                            problems.append(f'Malformed {field}.{key}: expected positive integer.'); item[key]=None
    for row in systems:
        for cpu in row['per_core_cpu']:
            if not isinstance(cpu.get('Name'),str): problems.append('Malformed per_core_cpu.Name.'); cpu['Name']=None
        for field in ('gpu_process_allocations_unsummed','gpu_adapter_host_totals','owned_gpu_engines'):
            for gpu in row[field]:
                if 'instance' in gpu and not isinstance(gpu['instance'],str):
                    problems.append(f'Malformed {field}.instance.'); gpu['instance']=None
    return processes,systems


def client_timestamp(sample):
    return sample['timeOriginMs']+sample['nowMs'] if finite(sample.get('timeOriginMs')) and finite(sample.get('nowMs')) else None


def coverage(times, start, end, max_gap_ms):
    if not finite(start) or not finite(end) or end <= start or len(times) < 2 or not all(finite(t) for t in times):
        return {'available': False, 'reason': 'Missing/invalid sample timestamps or measurement boundaries.'}
    if any(b <= a for a, b in zip(times, times[1:])):
        return {'available': False, 'reason': 'Sample timestamps are not strictly increasing.'}
    gaps = [max(0, times[0]-start), max(0, end-times[-1])] + [b-a for a,b in zip(times,times[1:])]
    return {'available': max(gaps) <= max_gap_ms, 'max_gap_ms': max(gaps), 'samples': len(times),
            'permitted_gap_ms': max_gap_ms, 'reason': 'Actual timestamp coverage; never nominal sampling frequency.'}


def process_observation_bounds(row, clock='unix'):
    """Schema 3 bounds enclose actual acquisition, before any publication.

    Old point stamps cannot establish the outside bounds of a slow query.
    They remain readable as diagnostics, but cannot qualify resource evidence.
    """
    if row.get('schema') not in (3,4):
        raise ValueError('Process acquisition interval absent/unsupported (schema 3 or 4 required).')
    unix = [row.get('observation_start_unix_ms'), row.get('observation_end_unix_ms')]
    qpc = [row.get('observation_start_qpc_ms'), row.get('observation_end_qpc_ms')]
    duration = row.get('observation_duration_ms')
    if (not all(finite(v) for v in unix+qpc+[duration]) or
            unix[1] < unix[0] or qpc[1] < qpc[0] or
            row.get('unix_ms') != unix[1] or row.get('qpc_ms') != qpc[1] or
            abs(duration-(qpc[1]-qpc[0])) > .01 or
            abs((unix[1]-unix[0])-duration) > 5):
        raise ValueError('Process acquisition interval/timestamp consistency invalid.')
    return tuple(unix if clock == 'unix' else qpc)


def ownership_intervals(rows, max_gap_ms=3500):
    """Authorize only continuously observed lifetimes, ending at LAST observation.
    First observation is deliberately conservative (not inferred process birth).
    A disappearance or uncertain sample gap closes the interval, including PID reuse.
    """
    intervals, active = {}, {}
    previous = None
    for sample in rows:
        # New identity begins only after acquisition completes; the last
        # guaranteed observation of an existing identity is acquisition start.
        lo, hi = process_observation_bounds(sample, 'qpc') if sample.get('schema') in (3,4) else (sample['qpc_ms'], sample['qpc_ms'])
        current = {(p['pid'], p['creation_ticks']) for p in sample['processes']}
        for key in list(active):
            if key not in current or (previous is not None and hi-previous > max_gap_ms):
                bounds = active.pop(key)
                intervals.setdefault(key[0], []).append(tuple(bounds))
        for key in current:
            if key in active: active[key][1] = lo
            else: active[key] = [hi, hi]
        previous = lo
    for (pid, _), interval in active.items(): intervals.setdefault(pid, []).append(tuple(interval))
    return intervals


def backlog_gate(samples):
    """5..10 second windows: positive queue/age trends tolerate plateaus/bursts.
    Fail a >=2-column net rise with positive regression slope, or >=1s age growth
    in a non-draining nonempty queue. Coverage is separately required.
    """
    for i, first in enumerate(samples):
        block = [s for s in samples[i:] if s['nowMs']-first['nowMs'] <= 10_000]
        if len(block) < 3 or block[-1]['nowMs']-first['nowMs'] < 5000: continue
        x = [s['nowMs']-first['nowMs'] for s in block]
        def slope(field):
            y = [s[field] for s in block]; xm, ym = sum(x)/len(x), sum(y)/len(y)
            return sum((a-xm)*(b-ym) for a,b in zip(x,y))/sum((a-xm)**2 for a in x)
        growth = block[-1]['queueLength']-first['queueLength']
        age = block[-1]['oldestQueuedAgeMs']-first['oldestQueuedAgeMs']
        if (growth >= 2 and slope('queueLength') > 0) or (
            growth >= 0 and block[-1]['queueLength'] > 0 and age >= 1000 and slope('oldestQueuedAgeMs') > 0):
            return {'pass': False, 'startMs':first['nowMs'], 'endMs':block[-1]['nowMs'],
                    'netQueueGrowth':growth, 'oldestAgeGrowthMs':age,
                    'queueSlopePerSecond':slope('queueLength')*1000}
    return {'pass': True, 'rule': '5..10s timestamp windows, plateau/burst tolerant net growth and oldest-age trend.'}


def source_window_summary(rows):
    """Evaluate every original 5..10s/age window, retaining only summaries.

    Growth has a bounded forward scan per start and running regression sums;
    age membership uses binary search and medians of only its five-second slice.
    Raw samples remain in source_time_gate's result, without all-window copies.
    """
    failed=None; max_growth=None; evaluated=0; max_members=0
    for i,first in enumerate(rows):
        count=sx=sy=sxx=sxy=0
        for j in range(i,len(rows)):
            last=rows[j]
            x=last['collector_end_ms']-first['collector_end_ms']
            if x>10_000: break
            y=last['source_debt_growth_ms']-first['source_debt_growth_ms']
            count+=1; sx+=x; sy+=y; sxx+=x*x; sxy+=x*y
            if count<3 or x<5000: continue
            slope=(sxy-sx*sy/count)/(sxx-sx*sx/count)
            growth=last['collector_start_ms']-first['collector_end_ms']-(int(last['edge_end_ns'])-int(first['edge_end_ns']))/1e6
            evaluated+=1; max_members=max(max_members,count)
            max_growth=growth if max_growth is None else max(max_growth,growth)
            if failed is None and growth>=1000 and slope>0:
                failed={'start_collector_ms':first['collector_end_ms'],'end_collector_ms':last['collector_end_ms'],
                        'source_debt_growth_low_ms':growth,'source_debt_slope_ms_per_second':slope*1000}
    times=[r['collector_end_ms'] for r in rows]
    first_at,last_at=times[0],times[-1]
    starts={first_at,last_at-5000}
    for at in times:
        for boundary in (at,at-5000): starts.update((boundary,boundary+.000001))
    age_failed=None; max_age=None; age_evaluated=0; max_age_members=0
    for at in sorted(s for s in starts if first_at<=s<=last_at-5000):
        lo,hi=bisect.bisect_left(times,at),bisect.bisect_right(times,at+5000)
        if hi-lo<2: continue
        value=median(rows[k]['earliest_possible_source_age_ms'] for k in range(lo,hi))
        age_evaluated+=1; max_age_members=max(max_age_members,hi-lo)
        max_age=value if max_age is None else max(max_age,value)
        if age_failed is None and value>6000:
            age_failed={'start_collector_ms':at,'end_collector_ms':at+5000,'samples':hi-lo,
                        'median_earliest_source_age_ms':value}
    return {'failed_window':failed,'max_window_debt_growth_low_ms':max_growth,
            'age_failed_window':age_failed,'max_window_median_earliest_source_age_ms':max_age,
            'window_evaluation':{'growth_windows':evaluated,'age_windows':age_evaluated,
                                 'max_growth_window_samples':max_members,'max_age_window_samples':max_age_members}}


def source_time_gate(client, start, end, scope):
    """LIVE source debt growth uses actual collector monotonic intervals.

    The scalar edge is timestampAtColumn(timeline.newestSeq)+dtNs, captured
    inside the real page snapshot, independent of the camera. Constant initial
    source delay is not growth. Full RPC bounds make the growth test conservative.
    """
    if scope == 'normalized-history-replay':
        return {'available':True,'pass':True,'excluded':True,'reason':'Normalized history playback has a different source clock.'}
    result = {'available':False,'pass':None,'samples':[],'missing':[],
              'policy':{'live_age_allowance_ms':5000,'host_provider_clock_uncertainty_ms':1000,
                        'age_window_ms':5000,'max_window_median_earliest_age_ms':6000,
                        'future_lead_allowance':'column dtMs + 1000ms beyond collector RPC end',
                        'meaning':'Fixed active-Binance-BTC benchmark allowances, including timestamp precision; not provider guarantees or clock calibration.'},
              'rule':'5..10s measured windows: >=1000ms outside-bound source debt growth and positive least-squares slope.'}
    if not finite(start) or not finite(end) or end<=start:
        result['missing'].append('LIVE source-time measurement boundaries absent/invalid.')
        return result
    # Check origins before phase filtering: a reset must not hide its own row
    # by moving the page timestamp outside the measured interval.
    page_origins=[s.get('timeOriginMs') for s in client]
    collector_origins=[s['sourceObservation'].get('collectorTimeOriginMs') if isinstance(s.get('sourceObservation'),dict) else None for s in client]
    if (not page_origins or not all(finite(v) for v in page_origins+collector_origins) or
            len(set(page_origins))!=1 or len(set(collector_origins))!=1):
        result['missing'].append('LIVE source/page clock origin absent/invalid or discontinuous.')
    page_times=[client_timestamp(s) for s in client]
    if not all(finite(v) for v in page_times) or any(b<=a for a,b in zip(page_times,page_times[1:])):
        result['missing'].append('LIVE source page monotonic timestamps absent/invalid or discontinuous.')
    selected = [s for s in client if finite(client_timestamp(s)) and start<=client_timestamp(s)<=end]
    previous = None
    origins = None
    for sample in selected:
        try:
            edge = sample.get('sourceTimeline')
            obs = sample.get('sourceObservation')
            if not isinstance(edge,dict) or not isinstance(obs,dict): raise ValueError('LIVE source timeline/collector interval absent.')
            seq,dt = edge.get('newestSeq'),edge.get('dtNs')
            if not finite(seq) or int(seq)!=seq or not finite(dt,1) or int(dt)!=dt:
                raise ValueError('LIVE source sequence/column duration invalid.')
            def ns(key):
                value=edge.get(key)
                if not isinstance(value,str) or not value.isascii() or not value.isdigit():
                    raise ValueError('LIVE source nanosecond timestamp absent/invalid.')
                return int(value)
            t0,edge_ns=ns('newestT0Ns'),ns('edgeEndNs')
            if t0<=0 or edge_ns!=t0+dt: raise ValueError('LIVE source exclusive column end is inconsistent.')
            lo,hi,origin = (obs.get(k) for k in ('collectorStartMs','collectorEndMs','collectorTimeOriginMs'))
            if not all(finite(v) for v in (lo,hi,origin)) or hi<lo or hi-lo>3000:
                raise ValueError('LIVE source collector monotonic interval invalid.')
            pair=(origin,sample.get('timeOriginMs'))
            if origins is not None and pair!=origins: raise ValueError('LIVE source/page clock origin discontinuity.')
            origins=pair
            # Page drain and edge acquisition must belong to this actual RPC.
            page_at=client_timestamp(sample)
            if not origin+lo-5<=page_at<=origin+hi+5:
                raise ValueError('LIVE source/page and collector clocks disagree.')
            # Keep subtraction in integer nanoseconds. Converting absolute
            # epoch timestamps to float milliseconds first can hide a boundary
            # violation smaller than that epoch float's precision.
            start_unix_ns=int((Decimal(str(origin))+Decimal(str(lo)))*1_000_000)
            end_unix_ns=int((Decimal(str(origin))+Decimal(str(hi)))*1_000_000)
            earliest_age_ms=(start_unix_ns-edge_ns)/1e6
            latest_age_ms=(end_unix_ns-edge_ns)/1e6
            raw={'collector_start_ms':lo,'collector_end_ms':hi,'page_now_ms':sample['nowMs'],
                 'collector_start_unix_ns':str(start_unix_ns),'collector_end_unix_ns':str(end_unix_ns),
                 'newest_seq':seq,'newest_t0_ns':str(t0),'edge_end_ns':str(edge_ns),'dt_ns':dt,
                 'source_edge_unix_ms':edge_ns/1e6,'source_debt_low_ms':earliest_age_ms,
                 'source_debt_high_ms':latest_age_ms,'earliest_possible_source_age_ms':earliest_age_ms,
                 'source_future_lead_ms':(edge_ns-end_unix_ns)/1e6,
                 'source_future_lead_allowance_ms':dt/1e6+result['policy']['host_provider_clock_uncertainty_ms']}
            # Exclusive end can legitimately lead by one column width. The
            # additional 1000ms covers declared host/provider clock uncertainty
            # and numeric precision, not arbitrary forward clock epochs.
            if edge_ns>end_unix_ns+dt+result['policy']['host_provider_clock_uncertainty_ms']*1_000_000:
                result['samples'].append(raw)
                raise ValueError('LIVE source edge is implausibly future-dated beyond column width plus clock uncertainty.')
            if previous:
                if lo<previous['collector_end_ms'] or sample['nowMs']<=previous['page_now_ms']:
                    raise ValueError('LIVE source observation clocks are not strictly ordered.')
                if seq<previous['newest_seq'] or dt!=previous['dt_ns'] or abs((t0-int(previous['newest_t0_ns']))-(seq-previous['newest_seq'])*dt)>1_000_000:
                    raise ValueError('LIVE source timeline reset/clock discontinuity or changed column duration.')
            result['samples'].append(raw)
            previous=raw
        except (TypeError,ValueError,OverflowError) as error:
            result['missing'].append(str(error))
    measured_coverage=coverage([client_timestamp(s) for s in selected],start,end,3000)
    if not measured_coverage['available']: result['missing'].append('LIVE source-time sample coverage unavailable.')
    if len(result['samples'])<3: result['missing'].append('LIVE source-time samples absent/insufficient.')
    if result['missing']:
        result['missing']=sorted(set(result['missing']))
        return result
    rows=result['samples']
    first=rows[0]
    for row in rows:
        row['elapsed_ms']=row['collector_end_ms']-first['collector_end_ms']
        row['source_advance_ms']=(int(row['edge_end_ns'])-int(first['edge_end_ns']))/1e6
        row['source_debt_growth_ms']=row['elapsed_ms']-row['source_advance_ms']
    summary=source_window_summary(rows)
    if not summary['window_evaluation']['growth_windows']:
        result['missing'].append('LIVE source-time evidence has no full 5..10 second window.')
        return result
    if not summary['window_evaluation']['age_windows']:
        result['missing'].append('LIVE source-age evidence has no full 5 second window.')
        return result
    failures=[]
    if summary['failed_window']: failures.append('Sustained LIVE source-time backlog growth observed.')
    if summary['age_failed_window']: failures.append('LIVE source-age workload exceeded its declared freshness allowance.')
    result.update(available=True,**{'pass':not failures},failures=failures,**summary)
    return result


def source_book_cadence(client):
    """Parsed accepted bridge books, sampled through change-only Status (~1s).
    This is neither raw wire frames nor a count of unique book changes.
    """
    values=[(s['capability'].get('source_book_events') if isinstance(s.get('capability'),dict) else None) for s in client]
    unavailable={'available':False,'reason':'Accepted source-book counter/identity absent, invalid or reset.'}
    if len(values)<2 or not all(finite(v) and int(v)==v for v in values) or any(b<a for a,b in zip(values,values[1:])):
        return unavailable
    if len({s.get('session') for s in client})!=1 or not client[0].get('session'):
        return unavailable
    elapsed=client[-1]['nowMs']-client[0]['nowMs']
    if not finite(elapsed,1): return unavailable
    return {'available':True,'delta':values[-1]-values[0],'elapsed_ms':elapsed,
            'per_second':(values[-1]-values[0])*1000/elapsed,
            'meaning':'Parsed BookSnapshot/BookDelta accepted by bridge, including unchanged books; Status delivery at most once per second can lag counter endpoints. Not raw wire frames or unique book changes.'}


def driver_issues(driver, exit_code):
    missing=[]; driver=object_map(driver,'driver',missing)
    errors=string_rows(driver.get('errors'),'driver.errors',missing)
    failures = [f'Application/driver error: {e}' for e in errors]
    if exit_code not in (None, 0): failures.append(f'Driver exit code {exit_code}.')
    if driver.get('complete') is not True or exit_code!=0: missing.append('Driver did not finish all required final verification.')
    return failures, missing


def resource_evidence(process, system, start, end, logical_count, gpu_luid):
    """Native EX2 RAM per complete owned-tree acquisition; independent CIM.
    GPU identity must survive its full query; GPU/shared allocations stay unsummed.
    """
    if not finite(start) or not finite(end) or end<=start:
        return {'available':False,'missing':['Measured resource boundaries unavailable.']}
    missing, joined, native_ram, cim_missing = [], [], [], []
    process,system=normalize_resources(process,system,missing)
    if any(not finite(r.get('unix_ms')) for r in process): missing.append('Process sample timestamps absent/invalid.')
    if any(not finite(r.get('unix_ms')) for r in system): missing.append('System sample timestamps absent/invalid.')
    valid_process = [r for r in process if finite(r.get('unix_ms')) and start-3500 <= r['unix_ms'] <= end+3500]
    bounded_process,all_bounded_process = [],[]
    valid_row_ids={id(r) for r in valid_process}
    for r in process:
        try:
            process_observation_bounds(r)
            all_bounded_process.append(r)
            if id(r) in valid_row_ids: bounded_process.append(r)
        except ValueError as error:
            if id(r) in valid_row_ids: missing.append(str(error))
    measured = [r for r in system if finite(r.get('unix_ms')) and start <= r['unix_ms'] <= end]
    bounded_row_ids={id(r) for r in bounded_process}
    for r in valid_process:
        if not finite(r.get('private_commit_bytes')) or not r.get('processes') or not all(
            finite(p.get('private_commit_bytes')) and finite(p.get('cpu_seconds')) and finite(p.get('pid'),1) and finite(p.get('creation_ticks'),1)
            for p in r.get('processes',[])):
            missing.append('Process CPU/private commit/identity fields absent or invalid.')
        ids=[(p['pid'],p['creation_ticks']) for p in r['processes']]
        direct=(id(r) in bounded_row_ids and r.get('schema')==4 and r.get('owned_tree_complete') is True and not r.get('acquisition_issues') and
                isinstance(r.get('acquisition_issues'),list) and isinstance(r.get('job_pids_start'),list) and isinstance(r.get('job_pids_end'),list) and
                r.get('private_working_set_source')==NATIVE_PRIVATE_WS_SOURCE and len(set(ids))==len(ids) and
                sorted(p['pid'] for p in r['processes'])==sorted(r.get('job_pids_end',[])) and
                bool(r['processes']) and all(
                    p.get('private_working_set_source')==NATIVE_PRIVATE_WS_SOURCE and
                    finite(p.get('private_working_set_bytes')) and int(p['private_working_set_bytes'])==p['private_working_set_bytes'] and
                    finite(p.get('working_set_bytes_not_summed')) and p['private_working_set_bytes']<=p['working_set_bytes_not_summed']
                    for p in r['processes']))
        total=sum(p['private_working_set_bytes'] for p in r['processes']) if direct else None
        if not direct or r.get('private_working_set_bytes')!=total:
            missing.append('Complete identity-bound native EX2 private working set unavailable; no CIM/commit/total-WS fallback.')
        else:
            native_ram.append({'unix_ms':r['unix_ms'],'observation_start_unix_ms':r['observation_start_unix_ms'],
                'observation_end_unix_ms':r['observation_end_unix_ms'],'private_working_set_bytes':total,
                'source':NATIVE_PRIVATE_WS_SOURCE,'identities':[{'pid':pid,'creation_ticks':birth} for pid,birth in ids]})
    pc = coverage([r['unix_ms'] for r in valid_process], start, end, 3500)
    sc = coverage([r.get('unix_ms') for r in measured], start, end, 5000)
    if not pc['available']: missing.append('Process sampler coverage unavailable.')
    if not sc['available']: missing.append('System sampler coverage unavailable.')
    required_mem = ('AvailableBytes','CommittedBytes','CommitLimit','PagesInputPersec','PagesOutputPersec','PageReadsPersec','PageWritesPersec')
    for s in measured:
        if s.get('schema') not in (3,4) or not isinstance(s.get('errors'),list) or s.get('errors'): missing.append('System sampler schema/error.')
        if s.get('schema')==4 or any(k in s for k in ('counter_provider','counter_evidence','rate_interval_start_unix_ms')):
            from pdh import validate_row
            missing.extend(validate_row(s))
        mem = s.get('system_memory') or {}
        if not all(finite(mem.get(k)) for k in required_mem): missing.append('System RAM/paging fields absent/invalid.')
        cpu = s.get('per_core_cpu', [])
        if len(cpu) != logical_count or len({r.get('Name') for r in cpu}) != logical_count or not all(finite(r.get('PercentProcessorTime')) for r in cpu):
            missing.append('Per-logical-core CPU telemetry absent/invalid.')
        paging = s.get('paging_file', [])
        if not paging or not all(finite(r.get('PercentUsage')) for r in paging): missing.append('Paging-file usage absent/invalid.')
        gpu = s.get('gpu_process_allocations_unsummed', [])
        adapter = s.get('gpu_adapter_host_totals', [])
        if not gpu or not adapter or not s.get('owned_gpu_engines'): missing.append('GPU allocation/engine telemetry absent.')
        for g in gpu:
            if not all(finite(g.get(k)) for k in ('dedicated_bytes','shared_bytes','committed_bytes')) or not g.get('creation_ticks') or not g.get('pid'):
                missing.append('GPU process allocation identity/fields absent.')
        if not any(g.get('luid') == gpu_luid for g in gpu): missing.append('Target GPU allocation unavailable.')
        target_adapters=[g for g in adapter if g.get('luid')==gpu_luid]
        if not target_adapters or not all(all(finite(g.get(k)) for k in ('dedicated_bytes','shared_bytes','committed_bytes')) for g in target_adapters):
            missing.append('Target adapter host allocation fields absent/invalid.')
        if not all(finite(g.get('utilization_percent')) and g.get('pid') and g.get('creation_ticks') for g in s.get('owned_gpu_engines',[])):
            missing.append('GPU engine fields/identity absent/invalid.')
        candidates=s.get('owned_gpu_candidates')
        if not isinstance(candidates,list) or not candidates:
            missing.append('Owned GPU candidate evidence absent/invalid.')
        else:
            for candidate in candidates:
                if not isinstance(candidate,dict) or candidate.get('kind') not in ('allocation','engine'):
                    missing.append('Owned GPU candidate schema invalid.');continue
                fields=('dedicated_bytes','shared_bytes','committed_bytes') if candidate['kind']=='allocation' else ('utilization_percent',)
                if not all(finite(candidate.get(k)) for k in fields):
                    missing.append('Owned GPU candidate counters absent/invalid.');continue
                if not any(candidate[k]>0 for k in fields): continue
                stream=gpu if candidate['kind']=='allocation' else s.get('owned_gpu_engines',[])
                if (candidate.get('identity_verified_at_start') is not True or candidate.get('identity_verified_at_end') is not True or
                        not finite(candidate.get('expected_creation_ticks'),1) or
                        candidate.get('creation_ticks')!=candidate['expected_creation_ticks'] or
                        not any(g.get('pid')==candidate.get('pid') and g.get('creation_ticks')==candidate.get('creation_ticks') and
                                g.get('instance')==candidate.get('instance') and all(g.get(k)==candidate[k] for k in fields) for g in stream)):
                    missing.append('Positive owned GPU candidate has unproven/omitted full-query identity or counters.')
        # Use the bracketing process observations, not a nearest-PID guess.
        sample_start=s.get('sample_start_unix_ms')
        if not finite(sample_start) or sample_start>s['unix_ms']:
            missing.append('System query-start timestamp absent/invalid.'); continue
        before = next((r for r in reversed(bounded_process) if r['observation_end_unix_ms'] <= sample_start), None)
        after = next((r for r in bounded_process if r['observation_start_unix_ms'] >= s['unix_ms']), None)
        ws = {(w.get('pid'),w.get('creation_ticks')):w for w in s.get('private_working_sets', [])}
        if not before or not after or after['observation_end_unix_ms']-before['observation_start_unix_ms'] > 3500:
            missing.append('GPU attribution has no close full-query bracketing process samples.'); continue
        identities = {(p['pid'],p['creation_ticks']) for p in before['processes']}
        end_ids = {(p['pid'],p['creation_ticks']) for p in after['processes']}
        bracket_start,bracket_end=before['observation_start_unix_ms'],after['observation_end_unix_ms']
        inside=[{(p['pid'],p['creation_ticks']) for p in r['processes']} for r in all_bounded_process
                if r['observation_end_unix_ms']>=bracket_start and r['observation_start_unix_ms']<=bracket_end]
        attributed={(g.get('pid'),g.get('creation_ticks')) for g in gpu+s.get('owned_gpu_engines',[])}
        if not attributed.issubset(identities & end_ids) or any(not attributed.issubset(observed) for observed in inside):
            missing.append('GPU allocation/engine identity is not continuously owned over its full query bracket.')
        # Independent CIM RAM diagnostics keep the old strict whole-tree join.
        # Their incompleteness never substitutes for missing direct native RAM.
        diagnostic=list(s.get('private_ws_diagnostic_errors',[]))
        if identities!=end_ids or not identities or not identities.issubset(ws):
            diagnostic.append('CIM private working set ownership/coverage uncertain.')
        if any(observed!=identities for observed in inside):
            diagnostic.append('CIM private working set ownership changed within its full process bracket.')
        if not all(finite(ws.get(k,{}).get('private_working_set_bytes')) for k in identities):
            diagnostic.append('CIM private working set values absent/invalid.')
        if diagnostic: cim_missing.extend(diagnostic)
        else: joined.append({'unix_ms':s['unix_ms'],'private_working_set_bytes':sum(ws[k]['private_working_set_bytes'] for k in identities),
                             'identities':[{'pid':k[0],'creation_ticks':k[1]} for k in sorted(identities)]})
    def instance_peaks(field):
        result={}
        for s in measured:
            for g in s.get(field,[]):
                key=g.get('instance') or f"{g.get('pid')}:{g.get('creation_ticks')}:{g.get('luid')}"
                values=result.setdefault(key,{'luid':g.get('luid'),'pid':g.get('pid'),'creation_ticks':g.get('creation_ticks')})
                for name in ('dedicated_bytes','shared_bytes','committed_bytes','utilization_percent'):
                    if finite(g.get(name)): values[name]=max(values.get(name,0),g[name])
        return result
    per_core={}
    for s in measured:
        for c in s.get('per_core_cpu',[]):
            if finite(c.get('PercentProcessorTime')): per_core[c.get('Name')]=max(per_core.get(c.get('Name'),0),c['PercentProcessorTime'])
    app_cpu=[]
    for a,b in zip(valid_process,valid_process[1:]):
        before={(p['pid'],p['creation_ticks']):p for p in a['processes']}
        after={(p['pid'],p['creation_ticks']):p for p in b['processes']}
        if before.keys()==after.keys() and b['unix_ms']>a['unix_ms'] and all(finite(p.get('cpu_seconds')) for p in list(before.values())+list(after.values())):
            delta=sum(after[k]['cpu_seconds']-before[k]['cpu_seconds'] for k in before)
            if delta<0: missing.append('Process CPU time counter reset.')
            else: app_cpu.append(delta/(b['unix_ms']-a['unix_ms'])*100000/logical_count)
    if not app_cpu: missing.append('Owned-tree CPU counter interval unavailable.')
    return {'available': not missing and bool(measured) and bool(native_ram), 'missing':sorted(set(missing)),
            'process_coverage':pc, 'system_coverage':sc, 'private_ws_joined':joined,
            'cim_private_ws_diagnostics':{'available':not cim_missing and len(joined)==len(measured),'missing':sorted(set(cim_missing)),
                                          'meaning':'Independent slow-CIM diagnostic; not required native RAM and never a fallback.'},
            'native_private_ws_samples':native_ram,'private_working_set_source':NATIVE_PRIVATE_WS_SOURCE,
            'peak_private_working_set_bytes':max((r['private_working_set_bytes'] for r in native_ram),default=None),
            'peak_private_commit_bytes':max((r['private_commit_bytes'] for r in valid_process if finite(r.get('private_commit_bytes'))),default=None),
            'min_available_system_ram_bytes':min((s['system_memory']['AvailableBytes'] for s in measured if finite((s.get('system_memory') or {}).get('AvailableBytes'))),default=None),
            'gpu_process_samples_unsummed':[g for s in measured for g in s.get('gpu_process_allocations_unsummed',[])],
            'gpu_process_instance_peaks_unsummed':instance_peaks('gpu_process_allocations_unsummed'),
            'gpu_adapter_host_instance_peaks_unsummed':instance_peaks('gpu_adapter_host_totals'),
            'gpu_engine_instance_peaks_unsummed':instance_peaks('owned_gpu_engines'),
            'per_core_host_cpu_peak_percent':per_core,
            'peak_app_cpu_percent_of_logical_host':max(app_cpu,default=None),
            'peak_pagefile_usage_percent_integer':max((p['PercentUsage'] for s in measured for p in s.get('paging_file',[]) if finite(p.get('PercentUsage'))),default=None),
            'peak_pagefile_usage_percent':max((p['PercentUsage'] for s in measured for p in s.get('paging_file',[]) if finite(p.get('PercentUsage'))),default=None),
            'peak_paging_rates':{k:max((s['system_memory'][k] for s in measured if finite((s.get('system_memory') or {}).get(k))),default=None) for k in required_mem[3:]},
            'paging_note':'PDH schema 4 retains DOUBLE percentage precision of provider page counts; legacy CIM schema 3 is integer-rounded. The legacy _integer summary key is an unrounded compatibility alias. Neither proves unsampled occupancy or paging activity.'}


def assess(presentation, client, health, complete, verified, *, start=None, end=None,
           scope='diagnostic-live-only', manifest=None, resources=None, driver=None, driver_exit=None,
           require_independent_health=False, health_target=None):
    failures, missing, inputs, input_times = [], [], [], []
    presentation=object_map(presentation,'presentation',missing)
    verified=object_map(verified,'verified',missing)
    resources=object_map(resources,'resources',missing)
    client=normalize_client(client,missing)
    independent_health=bool(require_independent_health or isinstance(driver,dict) and 'healthCollection' in driver or
                            isinstance(health,list) and any(isinstance(h,dict) and h.get('contract')==HEALTH_CONTRACT for h in health))
    health_coverage={'contract':'legacy-paired-health','available':False}
    if independent_health:
        health_coverage,health=health_observations(health,start,end,driver.get('healthCollection') if isinstance(driver,dict) else None,client,health_target)
        missing.extend(health_coverage['missing'])
    health=[normalize_health(h,f'health[{i}]',missing) for i,h in enumerate(object_rows(health,'health',missing))]
    if not complete: missing.append('Run did not complete its requested measured duration.')
    for name in ('profile','hardware_adapter','display_stream','geometry','workload','display_refresh','stable_window','runtime_provenance','interaction'):
        if verified.get(name) is not True: missing.append(f'Unverified {name}.')
    if not presentation.get('available'): missing.append('Displayed-frame telemetry unavailable.')
    elif presentation.get('pass') is False: failures.append('Presented FPS or display gap gate failed.')
    elif presentation.get('pass') is not True: missing.append('Presentation pass field absent/invalid.')
    if driver is not None:
        f,m = driver_issues(driver,driver_exit); failures.extend(f); missing.extend(m)
    if resources.get('available') is not True: missing.extend(string_rows(resources.get('missing',[]),'resources.missing',missing) or ['Resource telemetry unavailable.'])
    cc = coverage([client_timestamp(s) for s in client],start,end,3000)
    if not cc['available']: missing.append('Client measured-window sampling coverage unavailable.')
    valid = True
    for s in client:
        counters = s.get('counters',{})
        if s.get('schema') != 2 or not CAPABILITIES.issubset(s.get('capabilities',[])) or not set(COUNTERS).issubset(s.get('requiredCounters',[])):
            missing.append('Client telemetry schema/capabilities incomplete.'); valid=False
        if not all(finite(counters.get(k)) and int(counters[k]) == counters[k] for k in COUNTERS):
            missing.append('Client reasoned counters absent/invalid.'); valid=False
        if not all(finite(s.get(k)) for k in ('nowMs','timeOriginMs','queueLength','oldestQueuedAgeMs','pendingInputs')):
            missing.append('Client queue/timestamp fields absent/invalid.'); valid=False
        if not all(finite(s.get(k)) and int(s[k])==s[k] for k in ('queueLength','pendingInputs')):
            missing.append('Client queue/input counts are not nonnegative integers.'); valid=False
        if 'inputs' not in s or 'frames' not in s: missing.append('Raw input/frame arrays absent.'); valid=False
        for item in s.get('inputs',[]):
            if all(finite(item.get(k)) for k in ('latencyMs','eventMs','drawMs')) and item['drawMs'] >= item['eventMs']:
                if finite(s.get('timeOriginMs')) and finite(start) and finite(end):
                    event_at=s['timeOriginMs']+item['eventMs']
                    # Phase membership follows the original event, not the
                    # snapshot or draw completion. A late draw keeps its full latency.
                    if start <= event_at < end:
                        inputs.append(item['latencyMs'])
                        input_times.append(event_at)
            else: missing.append('Nonfinite/invalid input-to-draw sample.')
        for frame in s.get('frames',[]):
            if not all(finite(frame.get(k)) for k in ('rafMs','startMs','endMs')) or frame.get('endMs',0)<frame.get('startMs',0):
                missing.append('Nonfinite/invalid callback frame sample.')
        visibility=s.get('pageVisibility')
        if visibility == 'hidden': failures.append('Native page not visible throughout measurement.')
        elif visibility != 'visible': missing.append('Client page visibility absent/invalid.')
    p95 = percentile(inputs,.95)
    chart=chart_draw_gate(client,start,end)
    if not chart['available']: missing.append('Chart draw continuity telemetry unavailable.')
    elif not chart['pass']: failures.append('Chart CPU draw gap exceeded 250 ms during interaction.')
    interaction_coverage=coverage(sorted(set(input_times)),start,end,1000)
    if not interaction_coverage['available']: missing.append('Continuous measured interaction sample coverage unavailable.')
    if not any(s.get('frames') for s in client): missing.append('Raw callback frame telemetry empty.')
    if p95 is None: missing.append('Input-to-draw samples absent.')
    elif p95 > 100: failures.append('Input-to-draw p95 exceeded 100 ms (CPU proxy).')
    backlog = {'pass':None}
    if client:
        for key in COUNTERS:
            previous=None
            for s in client:
                value=s['counters'].get(key)
                if not finite(value): continue
                if previous is not None:
                    if value<previous: missing.append(f'Client counter reset: {key}.')
                    if value>previous and (key.startswith(('finalizedDiscarded:','historyDiscarded:')) or key in ('telemetryOverflow','streamIngestErrors','frameErrors')):
                        failures.append(f'{key}: {value-previous}')
                previous=value
    if valid and client:
        backlog=backlog_gate(client)
        if not backlog['pass']: failures.append('Sustained queue/backlog growth observed.')
        if client[-1]['pendingInputs']: failures.append('Interaction inputs never reached a chart draw.')
    source_time=source_time_gate(client,start,end,scope)
    if not source_time['available']: missing.extend(source_time['missing'])
    elif source_time['pass'] is False: failures.extend(source_time['failures'])
    if not client: missing.append('Raw client telemetry absent.')
    server_valid=bool(health) and (independent_health or len(health)==len(client))
    if independent_health and manifest:
        sessions={s.get('session') for s in client if isinstance(s.get('session'),str)}
        for h in health:
            feeds=h.get('feeds') or []
            if not isinstance(feeds,list) or not any(isinstance(f,dict) and f.get('session_id') in sessions and
                all(f.get(k)==manifest.get(k) for k in ('market','symbol','mode')) and
                (scope=='normalized-history-replay' or f.get('state')=='live') for f in feeds):
                missing.append('Independent actual health feed/session workload unavailable.')
    snapshots=[]
    for h in health:
        stats=h.get('stats') or {}; rec=stats.get('recording') or {}; drops=stats.get('drops') or {}
        snapshots.append({**{k:v for k,v in drops.items() if k in ('feed','tx_lag','snapshot') and finite(v)},
                          **{k:rec[k] for k in ('flush_failures','flush_stalls') if finite(rec.get(k))}})
        if scope != 'normalized-history-replay' and (h.get('recording_enabled') is False or rec.get('enabled') is False): failures.append('Live recording disabled.')
        if rec.get('stalled') is True: failures.append('Recorder stalled.')
        if h.get('stats_available') is not True or not all(finite(drops.get(k)) and int(drops[k])==drops[k] for k in ('feed','tx_lag','snapshot')) or not all(finite(rec.get(k)) and int(rec[k])==rec[k] for k in ('flush_failures','flush_stalls')) or not isinstance(rec.get('enabled'),bool) or not isinstance(rec.get('stalled'),bool) or 'last_flush_ts' not in rec or 'last_flush_age_s' not in rec:
            server_valid=False; continue
        if rec['last_flush_ts'] is not None and not finite(rec['last_flush_ts']): server_valid=False
        if rec['last_flush_age_s'] is not None and not finite(rec['last_flush_age_s']): server_valid=False
        if scope != 'normalized-history-replay' and (h.get('recording_enabled') is not True or rec['enabled'] is not True):
            server_valid=False
    if not server_valid: missing.append('Server loss/recorder fields absent/invalid or sample coverage incomplete.')
    previous={}
    for snapshot in snapshots:
        for key,value in snapshot.items():
            if key in previous:
                if value<previous[key]: missing.append(f'Server counter reset: {key}.')
                if value>previous[key]: failures.append(f'Server {key} increased by {value-previous[key]}.')
            previous[key]=value
    if server_valid:
        if scope != 'normalized-history-replay':
            flushes=[h['stats']['recording']['last_flush_ts'] for h in health]
            if not (finite(start) and finite(end) and any(finite(t) and start*1e6 <= t <= end*1e6 and
                (not independent_health or health[i]['_health_observation']['requestStartUnixMs']>=start) for i,t in enumerate(flushes))):
                missing.append('No fresh successful recording flush within measured live trial.')
    if scope == 'normalized-history-replay' and not verified.get('history'):
        missing.append('Verified one-hour normalized fixture and rendered history coverage absent.')
    if scope not in ('diagnostic-live-only','live-recording','normalized-history-replay'): missing.append('Unknown acceptance scope.')
    deltas={k:client[-1]['counters'][k]-client[0]['counters'][k] for k in COUNTERS} if valid and client else None
    counter_seconds=(client[-1]['nowMs']-client[0]['nowMs'])/1000 if valid and len(client)>1 else 0
    return {'status':'FAIL' if failures else 'INCOMPLETE' if missing else 'PASS',
            'scope':scope,'minimum_certified':False,'failures':sorted(set(failures)),'missing':sorted(set(missing)),
            'presentation':presentation,'chart_draw_continuity':chart,'client_coverage':cc,'health_coverage':health_coverage,'interaction_coverage':interaction_coverage,
            'backlog':backlog,'source_time_backlog':source_time,'input_to_draw_p95_ms':p95,
            'renderer_counter_deltas':deltas,
            'normalized_depth_messages_per_second':(deltas['finalizedReceived']+deltas['partialReceived'])/counter_seconds if deltas and counter_seconds>0 else None,
            'applied_normalized_depth_messages_per_second':(deltas['finalizedApplied']+deltas['partialApplied'])/counter_seconds if deltas and counter_seconds>0 else None,
            'depth_cadence_meaning':'Finalized + partial normalized depth messages; multiple partial/final messages can represent the same source book. Not upstream exchange book-event cadence.',
            'accepted_source_book_events':source_book_cadence(client) if valid and client else {'available':False},
            'loss_scope':'Instrumented stream and full-resolution history sinks plus server counters. Normalized replay does not cover raw connector ingestion or recording; campaign requires a separate live recording trial.'}


def campaign_assess(history, live, boundary=None, soak=None, live_soak=None):
    missing=[]
    def trial(value,path):
        r=object_map(value,path,missing)
        for key in ('acceptance','driver','workload','verified','history_evidence'):
            r[key]=object_map(r.get(key,{}),path+'.'+key,missing)
        return r
    history=trial(history,'history');live=trial(live,'live')
    boundary=[trial(r,f'boundary[{i}]') for i,r in enumerate(object_rows(boundary or [],'boundary',missing))]
    soak=trial(soak or {},'history_soak');live_soak=trial(live_soak or {},'live_soak')
    for run,scope in ((history,'normalized-history-replay'),(live,'live-recording')):
        if run.get('acceptance',{}).get('status') != 'PASS' or run.get('acceptance',{}).get('scope') != scope:
            missing.append(f'Required passing {scope} trial absent.')
        if not run.get('evidence_id') or not run.get('source_fingerprint') or not run.get('exe_sha256'):
            missing.append(f'{scope} provenance/hash linkage absent.')
    linkage=('source_fingerprint','exe_sha256','runtime_sha256','resource_limits','gpu_luid','gpu_identity','baseline')
    for key in linkage:
        if history.get(key) != live.get(key) or history.get(key) is None: missing.append(f'Trial {key} linkage differs/absent.')
    for run in (history,live):
        if not provenance_verified(run.get('provenance')): missing.append('Verified runtime provenance absent.')
    gpu_identity=history.get('gpu_identity')
    if not isinstance(gpu_identity,dict) or not all(finite(gpu_identity.get(k),1) for k in ('vendorId','deviceId','subSysId')):
        missing.append('Actual GPU PCI vendor/device/subsystem identity absent/invalid.')
    hm,lm=history.get('workload',{}),live.get('workload',{})
    if any(hm.get(k)!=lm.get(k) or not hm.get(k) for k in ('market','symbol','band')): missing.append('Trial instrument linkage differs/absent.')
    history_span=history['history_evidence'].get('span_seconds')
    if history.get('verified',{}).get('history') is not True or not finite(history_span) or history_span<3600:
        missing.append('One hour of verified normalized history absent.')
    if history.get('evidence_id')==live.get('evidence_id'): missing.append('Live and history must be separate trials.')
    coverage_missing=list(missing)
    boundary=boundary or []
    if len(boundary)!=3: missing.append('Three distinct live-recording boundary trials of at least 10 minutes are required.')
    def long_trial(run,minimum_seconds,scope):
        if not run: return False
        driver=run.get('driver',{}); start=driver.get('measurementStartUnixMs');end=driver.get('measurementEndUnixMs')
        return bool(provenance_verified(run.get('provenance')) and run.get('runtime_sha256') and run.get('acceptance',{}).get('status')=='PASS' and finite(start) and finite(end) and
            isinstance(run.get('evidence_id'),str) and bool(run['evidence_id']) and
            run.get('acceptance',{}).get('scope')==scope and
            end-start>=minimum_seconds*1000 and all(run.get(k)==history.get(k) for k in linkage) and
            all(run.get('workload',{}).get(k)==hm.get(k) for k in ('market','symbol','band')) and
            (scope!='normalized-history-replay' or run.get('verified',{}).get('history')))
    if not all(long_trial(run,600,'live-recording') for run in boundary): missing.append('Live boundary duration/scope/configuration evidence invalid.')
    if len({r.get('evidence_id') for r in boundary})!=len(boundary): missing.append('Boundary trials must be distinct.')
    if not long_trial(soak,1800,'normalized-history-replay'): missing.append('Passing 30-minute normalized-history soak at linked configuration absent.')
    if not long_trial(live_soak,1800,'live-recording'): missing.append('Additional passing 30-minute live-recording soak at linked configuration absent.')
    if live_soak.get('evidence_id') and live_soak.get('evidence_id') in {r.get('evidence_id') for r in boundary}:
        missing.append('Live soak must be additional to the three distinct live boundary trials.')
    return {'status':'INCOMPLETE' if missing else 'PASS','minimum_certified':not missing,
            'coverage_status':'INCOMPLETE' if coverage_missing else 'PASS','missing':missing,
            'trial_evidence_ids':[history.get('evidence_id'),live.get('evidence_id')],
            'boundary_evidence_ids':[r.get('evidence_id') for r in boundary],'soak_evidence_id':(soak or {}).get('evidence_id'),
            'live_soak_evidence_id':(live_soak or {}).get('evidence_id'),
            'scope':'One-PC separate-phase qualification: normalized history plus sustained public-live recording; simultaneous history-plus-live behavior and raw connector replay are not certified.'}


def workload_sample(s, manifest, scope, baseline, *, independent_health=False):
    sub=s.get('subscription') or {}; overlays=s.get('overlays') or {}; data=s.get('overlayData') or {}
    panels={p.get('id'):p.get('visible') for p in s.get('panels',[])}
    feed=next((f for f in s.get('health',{}).get('feeds',[]) if f.get('session_id')==s.get('session')),None)
    window=manifest.get('window') or {}
    return bool(s.get('status')=='live' and s.get('session') and
        all(sub.get(k)==manifest.get(k) for k in ('market','symbol','mode','band')) and
        all(str(sub.get(k) or '')==str(window.get(k) or '') for k in ('startNs','endNs')) and
        all(panels.get(p) for p in baseline['required_panels']) and all(overlays.get(k) for k in baseline['required_overlays']) and
        data.get('profileMax',0)>0 and data.get('volumeBars',0)>0 and s.get('cvdPoints',0)>0 and
        (independent_health or feed and all(feed.get(k)==manifest.get(k) for k in ('market','symbol','mode'))) and
        (scope=='normalized-history-replay' or (s.get('feedState')=='live' and (independent_health or feed.get('state')=='live') and
         s.get('book',{}).get('hasBook') and s.get('book',{}).get('trades',0)>0)))
