"""Independent actual HTTP observations. Legacy paired health is not this contract."""
import json
import math
import re

HEALTH_CONTRACT = 'independent-health-v1'
HEALTH_COVERAGE_MS = 5000
HEALTH_TIMEOUT_MS = 10000


def number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool): return False
    # Legal JSON integers can exceed the float domain used by interval math.
    # Validation must reject them, including during guarded report recovery.
    try: return math.isfinite(value) and value >= 0
    except OverflowError: return False


def server_fields(body):
    stats = body.get('stats')
    if not isinstance(stats, dict): return False
    drops, rec = stats.get('drops'), stats.get('recording')
    return bool(isinstance(drops, dict) and isinstance(rec, dict) and body.get('stats_available') is True and
        isinstance(body.get('recording_enabled'), bool) and isinstance(rec.get('enabled'), bool) and
        isinstance(rec.get('stalled'), bool) and
        all(number(drops.get(k)) and int(drops[k]) == drops[k] for k in ('feed','tx_lag','snapshot')) and
        all(number(rec.get(k)) and int(rec[k]) == rec[k] for k in ('flush_failures','flush_stalls')) and
        all(k in rec and (rec[k] is None or number(rec[k])) for k in ('last_flush_ts','last_flush_age_s')))


def health_observations(rows, start, end, collection, client, target=None):
    """Select last completed pre-start baseline and wholly in-window requests.

    A late completion never supplies an in-window timestamp or fresh flush.
    All rows (including warmup and drain) must have valid bounds and successful
    HTTP completion. Only the nearest baseline participates in counter deltas;
    older warmup/history changes are not measured loss.
    """
    missing, valid, decoded = [], [], []
    collection = collection if isinstance(collection, dict) else {}
    rows = rows if isinstance(rows, list) else []
    cid, url, origin = (collection.get(k) for k in ('collectionId', 'url', 'collectorTimeOriginMs'))
    if (collection.get('contract') != HEALTH_CONTRACT or type(collection.get('schema')) is not int or collection.get('schema') != 1 or
            not isinstance(cid, str) or not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', cid) or
            not isinstance(url, str) or not re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/api/health', url) or
            int(url.split(':')[2].split('/')[0]) > 65535 or not number(origin) or
            collection.get('timeoutMs') != HEALTH_TIMEOUT_MS or collection.get('coverageLimitMs') != HEALTH_COVERAGE_MS or
            collection.get('drained') is not True or collection.get('errors') != [] or
            (target is not None and url != target)):
        missing.append('Independent health collection contract/owned target/drain absent or invalid.')
    begin, stop = collection.get('collectionStartMonoMs'), collection.get('collectionEndMonoMs')
    if not (all(number(v) for v in (begin, stop, origin, start, end)) and begin <= stop and
            origin+begin <= start and end <= origin+stop <= end+HEALTH_TIMEOUT_MS+250):
        missing.append('Independent health lifetime bounds absent, future, or not drained within timeout.')
    stats = collection.get('stats') or {}
    if (not isinstance(stats, dict) or stats.get('started') != len(rows) or stats.get('completed') != len(rows) or
            any(not number(stats.get(k)) or int(stats[k]) != stats[k] for k in ('started','completed','failed','skipped')) or
            stats.get('failed') != 0):
        missing.append('Independent health request counts/error fields absent or invalid.')
    if not (number(start) and number(end) and end > start):
        missing.append('Independent health measured boundaries absent or invalid.')
        start = end = 0
    if not client or any(not isinstance(s, dict) or not isinstance(s.get('sourceObservation'), dict) or
                         s['sourceObservation'].get('collectorTimeOriginMs') != origin for s in client):
        missing.append('Independent health collector origin differs from actual client RPC origin.')
    previous_end = previous_utc_end = -1
    bounded_rows = []
    seen = set()
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            missing.append(f'Invalid health observation {i}: expected object.'); continue
        fields = [row.get(k) for k in ('requestStartMonoMs', 'requestEndMonoMs', 'requestStartUnixMs',
                                      'requestEndUnixMs', 'requestDurationMs', 'collectorTimeOriginMs')]
        lo, hi, ulo, uhi, duration, row_origin = fields
        oid = row.get('observationId')
        bounded = (all(number(v) for v in fields) and hi >= lo and lo >= previous_end and uhi > previous_utc_end and row_origin == origin and
                   abs((hi-lo)-duration) <= .01 and
                   abs((row_origin+lo)-ulo) <= .01 and abs((row_origin+hi)-uhi) <= .01 and
                   number(begin) and number(stop) and begin <= lo <= hi <= stop)
        identity = (type(row.get('schema')) is int and row.get('schema') == 1 and row.get('contract') == HEALTH_CONTRACT and
                    row.get('collectionId') == cid and number(row.get('requestSequence')) and row.get('requestSequence') == i+1 and
                    oid == f'{cid}:{i+1}' and oid not in seen and row.get('url') == url and row.get('method') == 'GET')
        if not bounded or not identity or duration > HEALTH_TIMEOUT_MS:
            missing.append(f'Invalid/replayed health observation identity or request bounds at index {i}.')
        if isinstance(oid, str): seen.add(oid)
        if bounded: previous_end = hi; previous_utc_end = uhi; bounded_rows.append(row)
        successful = row.get('statusCode') == 200 and row.get('error', 'absent') is None and row.get('timedOut') is False
        if not successful: missing.append(f'Health HTTP error/timeout/status at index {i}.')
        body = None
        try:
            body = json.loads(row['responseBody'], parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            if not isinstance(body, dict): raise ValueError('response is not an object')
        except (KeyError, TypeError, ValueError):
            body = None
            missing.append(f'Health response missing/invalid JSON at index {i}.')
        if isinstance(body,dict) and not server_fields(body):
            missing.append(f'Health server loss/recorder fields absent or invalid at index {i}.')
        if bounded and duration <= HEALTH_TIMEOUT_MS and identity and successful and body is not None:
            valid.append(row); decoded.append(body)
    baseline = next((i for i in reversed(range(len(valid))) if valid[i]['requestEndUnixMs'] <= start), None)
    selected = ([baseline] if baseline is not None else []) + [i for i, row in enumerate(valid)
        if row['requestStartUnixMs'] >= start and row['requestEndUnixMs'] <= end]
    measured = [i for i in selected if i != baseline]
    times = [valid[i]['requestEndUnixMs'] for i in measured]
    gaps = ([start-valid[baseline]['requestEndUnixMs']] if baseline is not None else []) + (
        [times[0]-(valid[baseline]['requestEndUnixMs'] if baseline is not None else start), end-times[-1]] +
        [b-a for a,b in zip(times,times[1:])] if times else [])
    max_gap = max(gaps, default=None)
    available = bool(baseline is not None and len(times) >= 2 and max_gap is not None and max_gap <= HEALTH_COVERAGE_MS)
    if not available: missing.append('Actual completed health measured-window coverage unavailable (new 5000 ms health contract).')
    bodies = [dict(decoded[i], _health_observation=valid[i]) for i in selected]
    if any(row['requestStartUnixMs'] < start < row['requestEndUnixMs'] for row in valid):
        missing.append('Health request crosses measured start; counter baseline is uncertain.')
    end_bracket = next((i for i,row in enumerate(valid) if row['requestEndUnixMs'] > end), None)
    if end_bracket is None:
        missing.append('Required completed end-bracketing health observation absent; final loss/recorder state is unknown.')
    if selected and end_bracket is not None:
        # The first state after the end brackets the unsampled measured tail,
        # even when an idle worker starts that final request at/after the end.
        # Its cumulative change may precede the end; it is uncertain, not clean
        # evidence and not a definite measured failure. It stays unselected.
        before = decoded[selected[-1]]
        body = decoded[end_bracket]
        if server_fields(before) and server_fields(body):
            a,b=before['stats'],body['stats']
            if (any(a['drops'][k] != b['drops'][k] for k in ('feed','tx_lag','snapshot')) or
                    any(a['recording'][k] != b['recording'][k] for k in ('flush_failures','flush_stalls','enabled','stalled')) or
                    before['recording_enabled'] != body['recording_enabled']):
                missing.append('Loss/recorder state changed in end-bracketing health observation; timing relative to measured end is uncertain.')
    # A body is a state somewhere within its actual request interval. A claimed
    # flush after completion is impossible and must not create fresh evidence.
    for body in bodies:
        rec = body.get('stats', {}).get('recording', {}) if isinstance(body.get('stats'), dict) else {}
        if not isinstance(rec, dict): continue
        stamp, age = rec.get('last_flush_ts'), rec.get('last_flush_age_s')
        row = body['_health_observation']
        if (stamp is None) != (age is None):
            missing.append('Health recorder timestamp/age nullability is inconsistent.')
        if stamp is not None and number(stamp):
            flush_ms = stamp / 1e6
            if flush_ms > row['requestEndUnixMs'] + .01:
                missing.append('Health recording flush timestamp is after actual response completion.')
            # Server age is rounded to one decimal second (50 ms + 1 ms clock
            # serialization tolerance); this does not widen coverage or flush.
            # Compare the untrusted age to the bounded interval in seconds.
            # Scaling a finite integer age by 1000 can exceed the float domain
            # before addition to flush_ms (e.g. 10**306); scaling the observed
            # interval down avoids both that exception and float infinity.
            min_age_s = (row['requestStartUnixMs']-flush_ms-51)/1000
            max_age_s = (row['requestEndUnixMs']-flush_ms+51)/1000
            if number(age) and not (min_age_s <= age <= max_age_s):
                missing.append('Health recorder age/timestamp is stale or inconsistent with actual request bounds.')
    return {'contract': HEALTH_CONTRACT, 'available': available and not missing,
            'permitted_gap_ms': HEALTH_COVERAGE_MS, 'max_gap_ms': max_gap,
            'max_query_latency_ms': max((r['requestDurationMs'] for r in bounded_rows), default=None),
            'observations': len(rows), 'measured_observations': len(measured),
            'baseline_observation_id': valid[baseline]['observationId'] if baseline is not None else None,
            'end_bracketing_observation_id': valid[end_bracket]['observationId'] if end_bracket is not None else None,
            'used_observation_ids': [valid[i]['observationId'] for i in selected],
            'excluded_observation_ids': [r['observationId'] for i,r in enumerate(valid) if i not in selected],
            'missing': sorted(set(missing)),
            'policy': 'Nearest wholly completed pre-start baseline plus wholly in-window requests; an actual completed end bracket is required. Late responses never provide measured coverage or fresh flush.'}, bodies
