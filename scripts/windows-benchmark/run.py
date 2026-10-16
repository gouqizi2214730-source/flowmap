"""Run a visible, isolated native Windows benchmark. A job budget is not physical RAM."""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from core import validate_limits, presented_events, presentation_gate, assess, ownership_intervals, resource_evidence, normalize_client, workload_sample
from fixture import verify_fixture
from provenance import source_fingerprint as fingerprint, verify_artifact, bind_sidecar, sha, sample_identity
from win32 import Job, qpc, process_sample, safe_stop, place_window, window_snapshot, ambient_cpu_budget
from observation import ProcessObserver, observe_processes

HERE = Path(__file__).resolve().parent
ACTIVE_REPORT = {}


def drain_presentmon(proc, sample, deadline, *, clock=time.monotonic, sleep=time.sleep):
    while proc.poll() is None and clock()<deadline:
        sample(); sleep(.25)
    sample()


def presentmon_log_issues(log):
    issues = []
    for line in log.splitlines():
        lower = line.lower()
        if ('warning' in lower and ('lost' in lower or 'overflow' in lower) and
                any(word in lower for word in ('etw', 'event', 'buffer'))):
            counts = [int(value.replace(',', '')) for value in re.findall(r'\d[\d,]*', line)]
            if not counts or any(value > 0 for value in counts):
                issues.append('PresentMon collection loss: ' + line.strip())
    return issues


def presentation_collection_issue(csv_path, candidates):
    if not csv_path.exists():
        return 'PresentMon CSV is missing; displayed-frame collection unavailable.'
    if not candidates:
        return 'PresentMon CSV has no usable owned displayed target stream.'
    return None


def cleanup_presentmon(executable, session, capture_status, *, execute=subprocess.run):
    """Only a generated run-owned session; no discovery, wildcard or elevation.

    v2.6.0 returns 7 plus the exact name when no such session exists. A second
    terminate-only invocation verifies absence after a successful stop.
    """
    if not re.fullmatch(r'FlowMapBenchmark-[0-9a-f]{32}', session):
        raise ValueError('Invalid owned PresentMon session name')
    command = [str(executable), '--session_name', session, '--terminate_existing_session']
    record = {'session_name': session, 'capture_status_before_cleanup': capture_status,
              'command': command, 'attempts': [], 'verified_absent': False}
    for _ in range(2):
        try:
            result = execute(command, capture_output=True, text=True, encoding='utf-8', errors='replace',
                             timeout=10, creationflags=0x08000000 if os.name == 'nt' else 0)
            output = (result.stdout or '') + (result.stderr or '')
            record['attempts'].append({'exit_code': result.returncode, 'output': output})
            if result.returncode == 7 and ('no existing sessions found: ' + session).lower() in output.lower():
                record['verified_absent'] = True
                break
            if result.returncode != 0:
                break
        except Exception as error:
            record['attempts'].append({'error': f'{type(error).__name__}: {error}'})
            break
    return record


def guarded_main(action, state=None):
    """An assessment/reporting exception after collection still has a verdict.
    Only a newly created, owned run directory is registered in ACTIVE_REPORT.
    Independent known failures are re-assessed and never downgraded to PASS.
    """
    state=ACTIVE_REPORT if state is None else state
    try: return action()
    except Exception as error:
        if not state.get('output'): raise
        out=Path(state['output'])
        message=f'Final assessment/report exception: {type(error).__name__}: {error}'
        verdict=assess(state.get('presentation',{}),state.get('client',[]),state.get('health',[]),False,{},
            start=state.get('start'),end=state.get('end'),scope=state.get('scope','diagnostic-live-only'),
            resources={'available':False,'missing':['Final resource assessment unavailable.']},
            driver=state.get('driver'),driver_exit=state.get('driver_exit'),
            require_independent_health=True,health_target=state.get('health_target'))
        verdict['missing'].append(message)
        result={k:state.get(k) for k in ('evidence_id','source_fingerprint','exe_sha256','runtime_sha256','provenance','scope')}
        result.update(schema=2,acceptance=verdict,errors=list(state.get('errors',[]))+[message],
                      report_recovered=True,driver=state.get('driver',{}))
        write(out/'result.json',result)
        (out/'summary.md').write_text(f"# Windows benchmark\n\nVerdict: **{verdict['status']}**\n\n"+json.dumps(verdict,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'output':str(out),'status':verdict['status'],'report_recovered':True,'error':message}))
        return 2

def source_fingerprint():
    return fingerprint(HERE.parent.parent)


def _replace_snapshot(temporary, path):
    if os.name != 'nt' or not path.exists():
        temporary.replace(path)
        return

    def extended(value):
        value = os.path.abspath(value)
        if value.startswith('\\\\?\\'): return value
        if value.startswith('\\\\'): return '\\\\?\\UNC\\' + value[2:]
        return '\\\\?\\' + value

    # One rename keeps old handles readable and subsequent opens on the new
    # file. MoveFileExW denies held destinations; ReplaceFileW has a name gap.
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                  ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.SetFileInformationByHandle.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    kernel.SetFileInformationByHandle.restype = ctypes.c_int
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int

    class RenameInfo(ctypes.Structure):
        _fields_ = [('Flags', ctypes.c_uint32), ('RootDirectory', ctypes.c_void_p),
                    ('FileNameLength', ctypes.c_uint32), ('FileName', ctypes.c_wchar * 1)]

    target = extended(path).encode('utf-16-le')
    buffer = ctypes.create_string_buffer(ctypes.sizeof(RenameInfo) + len(target))
    info = RenameInfo.from_buffer(buffer)
    info.Flags = 3  # FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS
    info.FileNameLength = len(target)
    ctypes.memmove(ctypes.addressof(buffer) + RenameInfo.FileName.offset, target, len(target))
    handle = kernel.CreateFileW(extended(temporary), 0x10000, 7, None, 3, 0x80, None)  # DELETE, share R/W/delete, OPEN_EXISTING
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.SetFileInformationByHandle(handle, 22, buffer, ctypes.sizeof(buffer)):  # FileRenameInfoEx
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)


def write(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    # Windows readers outside the sampler may briefly deny delete sharing.
    # Retry only replacement, for at most four 10ms waits; never overwrite.
    for attempt in range(5):
        try:
            _replace_snapshot(temporary, path)
            return
        except OSError as error:
            if os.name != 'nt' or getattr(error, 'winerror', None) not in (5, 32, 33) or attempt == 4:
                raise
            time.sleep(.01)

def read_lines(path, errors=None):
    if not path.exists(): return []
    rows=[]
    for number,line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(),1):
        if not line.strip(): continue
        try:
            value=json.loads(line)
            if not isinstance(value,dict): raise ValueError('sample must be an object')
            rows.append(value)
        except (ValueError,TypeError) as error:
            if errors is None: raise
            errors.append(f'{path.name}:{number}: malformed raw sample: {error}')
    return rows

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--exe', type=Path, required=True)
    p.add_argument('--build-manifest',type=Path,required=True)
    p.add_argument('--profile', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--manifest', type=Path, default=HERE/'live.json')
    p.add_argument('--duration', type=int, default=60)
    p.add_argument('--warmup', type=int, default=30)
    p.add_argument('--affinity', type=lambda v: int(v, 0))
    p.add_argument('--cpu-rate', type=int)
    p.add_argument('--commit-mib', type=int)
    p.add_argument('--gpu-luid', required=True)
    p.add_argument('--gpu-device', default='6613')
    p.add_argument('--presentmon', type=Path, required=True)
    p.add_argument('--stream', help='Swapchain address, or sole-owned for the pilot-verified single-stream private WebView2 architecture. Multiple streams remain INCOMPLETE.')
    p.add_argument('--node', default='C:/Program Files/nodejs/node.exe')
    p.add_argument('--window', nargs=4, type=int, default=[-1920,357,1920,1080])
    p.add_argument('--scope',choices=['diagnostic-live-only','live-recording','normalized-history-replay'])
    p.add_argument('--history-timeout',type=int,default=180,help='Cold history load timeout, separate from measured duration')
    args = p.parse_args()
    if os.name != 'nt': p.error('Windows only')
    if args.duration < 5 or args.warmup < 0: p.error('duration >=5 and warmup >=0 required')
    limits = validate_limits(args.affinity, args.cpu_rate, args.commit_mib, os.cpu_count())
    ambient=ambient_cpu_budget();limits['ambient_job_cpu']=ambient
    if args.cpu_rate and (not ambient.get('available') or ambient.get('in_job')):
        limits['cpu_percent_of_system']=None
        limits['cpu_percent_of_containing_job']=args.cpu_rate/100
        limits['meaning']+=' Parent job relationship is reported; full-system CPU percentage is unverified when inherited from a job.'
    exe, profile, out = args.exe.resolve(), args.profile.resolve(), args.output.resolve()
    if not exe.is_file() or 'benchmark' not in exe.name.lower(): p.error('Use the uniquely named benchmark executable')
    if profile.exists() or out.exists(): p.error('Profile and output must be new directories; failed runs are preserved')
    if profile == out or profile in out.parents or out in profile.parents: p.error('Profile and output must be separate')
    manifest = json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    scope=args.scope or manifest.get('acceptanceScope') or ('normalized-history-replay' if manifest.get('mode')=='replay' else 'diagnostic-live-only')
    if (scope=='normalized-history-replay') != (manifest.get('mode')=='replay'): p.error('Replay history and live scopes must match subscription mode')
    history = manifest.get('history', {})
    history_evidence=None
    fixture=None
    if history.get('directory'):
        fixture = (args.manifest.resolve().parent/history['directory']).resolve()
        history_evidence=verify_fixture(fixture,manifest)
    if scope=='normalized-history-replay' and not history_evidence: p.error('History acceptance requires hashed one-hour normalized fixture')
    build_path=args.build_manifest.resolve()
    build_manifest=json.loads(build_path.read_text(encoding='utf-8-sig'))
    build_hash=sha(build_path)
    provenance={'origin_verified':False,'package_parity_verified':False,'source_match_verified':False,
                'unchanged_verified':False,'identity_verified':False,'build_manifest_path':str(build_path),'build_manifest_sha256':build_hash}
    runtime_hash=build_manifest.get('runtime_sha256')
    source_hash=fingerprint(HERE.parent.parent,build_manifest.get('native_config_path'))
    exe_hash=hashlib.sha256(exe.read_bytes()).hexdigest()
    profile.mkdir(parents=True); out.mkdir(parents=True)
    owner = uuid.uuid4().hex
    (profile/'.flowmap-benchmark-owner').write_text(owner, encoding='utf-8')
    if fixture:
        shutil.copytree(fixture, profile/'recordings')
    port = free_port()
    env = dict(os.environ)
    env.update(FLOWMAP_BENCHMARK_PROFILE=str(profile), FLOWMAP_BENCHMARK_OWNER=owner,
               WEBVIEW2_USER_DATA_FOLDER=str(profile/'webview-cache'),
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f'--use-angle=d3d11 --use-adapter-luid={args.gpu_luid} --remote-debugging-port={port}')
    write(out/'run-config.json', {'arguments':vars(args)|{'exe':str(exe),'profile':str(profile),'output':str(out),'manifest':str(args.manifest),'presentmon':str(args.presentmon),'build_manifest':str(build_path)},
        'limits':limits,'workload':manifest,'instrumentation':'benchmark-only raw CPU counters, CDP, private app identity, undecorated native window; release Rust/Vite optimizations retained',
        'gpu_luid':args.gpu_luid,'profile':str(profile),'scope':scope,'history_evidence':history_evidence,
        'provenance':provenance,'runtime_sha256':runtime_hash,'source_fingerprint':source_hash,'exe_sha256':exe_hash,'manifest_sha256':hashlib.sha256(args.manifest.read_bytes()).hexdigest()})
    ACTIVE_REPORT.clear()
    ACTIVE_REPORT.update(output=out,evidence_id=owner,source_fingerprint=source_hash,exe_sha256=exe_hash,runtime_sha256=runtime_hash,provenance=provenance,scope=scope)
    job, helpers, logs = None, [], []
    rows, identities, errors, window_rows = [], {}, [], []
    ACTIVE_REPORT['errors'] = errors
    observer = None; published_ids = None; observer_stopped = True
    pm_session = 'FlowMapBenchmark-' + owner; pm_command = None; pm_cleanup = None
    helper_status={}
    placement, gpu_pid, pm, driver = None, None, None, None
    binding=None; end_binding=None; runtime=None; report_before=None
    def helper(command, name):
        log = (out/(name+'.log')).open('w', encoding='utf-8'); logs.append(log)
        # Only background helpers are hidden; the native application remains visible.
        proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
        identity = process_sample(proc.pid)
        if not identity: raise RuntimeError('Cannot identify owned helper')
        helpers.append((proc, identity, name)); return proc
    def publish_process(row):
        for process in row['processes']:
            key = f"{process['pid']}:{process['creation_ticks']}"
            identities[key] = {'pid':process['pid'],'creation_ticks':process['creation_ticks']}
        rows.append(row)
        with (out/'process.ndjson').open('a',encoding='utf-8') as f: f.write(json.dumps(row)+'\n')

    def sample_owned():
        nonlocal published_ids
        observer.check()
        row = observer.publish(publish_process, wait=True)
        current = sorted((p['pid'],p['creation_ticks']) for p in row['processes'])
        if current != published_ids:
            write(out/'identities.json', [{'pid':pid,'creation_ticks':birth} for pid,birth in current])
            published_ids = current
        if placement:
            window_start = time.time()*1000
            observation=window_snapshot(root,placement['hwnd'])
            observation.update(sample_start_unix_ms=window_start, unix_ms=time.time()*1000)
            window_rows.append(observation)
            with (out/'window.ndjson').open('a',encoding='utf-8') as f: f.write(json.dumps(observation)+'\n')
        observer.check()
        return row
    try:
        helper(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(HERE/'sample.ps1'),'-Inventory'], 'inventory')
        job = Job(limits); root = job.launch(exe, env); write(out/'root.json',root)
        observer = ProcessObserver(lambda: observe_processes(job, process_sample, qpc)).start()
        deadline = time.monotonic()+60
        while time.monotonic()<deadline:
            sample_owned()
            try: placement = place_window(root,args.window); break
            except RuntimeError: time.sleep(.2)
        if not placement: raise RuntimeError('Owned native window did not become visible')
        write(out/'window.json',placement)
        # This stdlib-only worker uses the direct interpreter: the Windows venv
        # redirector otherwise makes Popen.pid differ from the executing PID.
        helper([sys._base_executable,'-B',str(HERE/'sample_pdh.py'),'--identity-file',str(out/'identities.json'),'--output-file',str(out/'system.ndjson'),'--stop-file',str(out/'sampler-stop')], 'sampler')
        # Bind the actual external interpreter/package before any driver inputs.
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            observation=sample_owned()
            if (profile/'native-info.json').exists() and (profile/'sidecar-provenance.json').exists():
                native=json.loads((profile/'native-info.json').read_text(encoding='utf-8-sig'))
                report_before=json.loads((profile/'sidecar-provenance.json').read_text(encoding='utf-8-sig'))
                runtime=Path(native['interpreter']).resolve().parent
                bound_at=observation['unix_ms']
                binding=bind_sidecar(native,report_before,observation['processes'],runtime,build_manifest,owner)
                verify_artifact(build_manifest,HERE.parent.parent,exe,runtime)
                if sha(build_path)!=build_hash: raise RuntimeError('Build manifest changed')
                provenance.update(binding,package_parity_verified=True,source_match_verified=True,
                                  package_sha256=build_manifest['package_sha256'],source_package_sha256=build_manifest['package_sha256'],
                                  installed_package_sha256=build_manifest['package_sha256'],runtime_sha256=runtime_hash)
                write(out/'sidecar-provenance.json',report_before)
                break
            time.sleep(.25)
        if not binding: raise RuntimeError('Sidecar provenance unavailable before driver')
        health_target=f"http://127.0.0.1:{native['serverPort']}/api/health"
        ACTIVE_REPORT['health_target']=health_target
        config = {'output':str(out),'cdpPort':port,'serverPort':native['serverPort'],
                  'healthContract':'independent-health-v1','manifest':manifest,'warmup':args.warmup,'duration':args.duration,
                  'scope':scope,'historyEvidence':history_evidence,'historyTimeoutMs':args.history_timeout*1000}
        write(out/'driver-config.json',config)
        driver = helper([args.node,str(HERE/'driver.cjs'),str(out/'driver-config.json')], 'driver')
        deadline = time.monotonic()+args.duration+args.warmup+2*args.history_timeout+180
        while driver.poll() is None and time.monotonic()<deadline:
            sample_owned()
            if not pm and (out/'ready.json').exists():
                ready = json.loads((out/'ready.json').read_text(encoding='utf-8-sig'))
                owned = {r['pid'] for r in rows[-1]['processes']}
                candidates = [r['id'] for r in ready.get('processInfo',{}).get('processInfo',[]) if r['type']=='GPU' and r['id'] in owned]
                if len(candidates)!=1: raise RuntimeError(f'Owned GPU PID was not uniquely identified: {candidates}')
                gpu_pid=candidates[0]
                pm_command = [str(args.presentmon.resolve()),'--process_id',str(gpu_pid),'--v2_metrics','--qpc_time','--write_display_metadata','--no_track_input','--no_console_stats',
                    '--session_name',pm_session,'--output_file',str(out/'present.csv'),'--timed',str(args.duration+args.warmup+10),'--terminate_after_timed']
                write(out/'presentation-target.json',{'gpu_pid':gpu_pid,'requested_swapchain':args.stream,
                    'session_name':pm_session,'command':pm_command,'gpu_duration_tracking':True,'display_tracking':True})
                pm = helper(pm_command, 'presentmon')
            # Close brackets around independent slow CIM queries without
            # relaxing the 3.5s ownership/working-set evidence gate.
            time.sleep(.25)
        if driver.poll() is None: raise RuntimeError('Driver deadline exceeded')
        if pm:
            # Prefer normal timed exit so PresentMon can flush the raw trace.
            drain_presentmon(pm,sample_owned,deadline+20)
        else: sample_owned()
    except BaseException as error: errors.append(str(error))
    finally:
        # Do this before any filesystem/report/provenance cleanup can fail.
        # Preserve the original timed-capture status even if cleanup ends it.
        if pm_command:
            helper_status['presentmon'] = pm.poll() if pm else None
            # A still-starting helper must not create its session after the
            # absence check. Stop only its proven PID+creation identity first.
            for proc,identity,name in helpers:
                if name=='presentmon' and proc.poll() is None:
                    try: safe_stop(proc,identity)
                    except Exception as error: errors.append('PresentMon helper cleanup: '+str(error))
            pm_cleanup=cleanup_presentmon(args.presentmon.resolve(),pm_session,helper_status['presentmon'])
            if not pm_cleanup['verified_absent']: errors.append('Owned PresentMon ETW session cleanup/absence verification failed.')
            try: write(out/'presentation-cleanup.json',pm_cleanup)
            except Exception as error: errors.append('PresentMon cleanup report: '+str(error))
            if pm and pm.poll() is None:
                try: pm.wait(timeout=5)
                except subprocess.TimeoutExpired: pass
        try: (out/'sampler-stop').touch()
        except Exception as error: errors.append('Sampler stop signal: '+str(error))
        # Let the current slow CIM sample revalidate identities while the job still exists.
        sampler_stopped = True
        for proc,identity,name in helpers:
            if name=='sampler' and proc.poll() is None:
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    errors.append('Sampler did not stop cleanly.')
                    try: safe_stop(proc,identity)
                    except Exception as error: errors.append('Sampler helper cleanup: '+str(error))
                if proc.poll() is None:
                    sampler_stopped=False
                    errors.append('Sampler is still running; job teardown deferred to runner exit.')
        if job and binding:
            try:
                final_observation=sample_owned()
                native_end=json.loads((profile/'native-info.json').read_text(encoding='utf-8-sig'))
                report_end=json.loads((profile/'sidecar-provenance.json').read_text(encoding='utf-8-sig'))
                end_binding=bind_sidecar(native_end,report_end,final_observation['processes'],runtime,build_manifest,owner)
                if not sample_identity(end_binding,binding): raise RuntimeError('Sidecar changed/respawned')
            except Exception as error:
                end_binding=None
                errors.append('provenance: '+str(error))
        if observer:
            observer_stopped = observer.stop()
            try: observer.publish(publish_process, check=False)
            except Exception as error: errors.append('Final process publication: '+str(error))
            errors.extend(observer.failures)
            try: write(out/'observation-status.json', observer.status())
            except Exception as error: errors.append('Observation status report: '+str(error))
            if observer.status()['pending'] or observer.status()['lost']:
                errors.append('Process observation evidence was not fully persisted.')
        if binding and end_binding:
            try:
                # Include the final queued observations flushed after joining.
                for observation in rows:
                    if observation['unix_ms'] < bound_at: continue
                    matches=[p for p in observation['processes'] if p['pid']==binding['pid']]
                    if len(matches)!=1 or not sample_identity(matches[0],binding):
                        raise RuntimeError('Sidecar ownership identity disappeared/changed')
                provenance['identity_verified']=True
            except Exception as error: errors.append('provenance: '+str(error))
        if job and observer_stopped and sampler_stopped:
            try: job.close()
            except Exception as error: errors.append('Job cleanup: '+str(error))
        if runtime and binding:
            try:
                verify_artifact(build_manifest,HERE.parent.parent,exe,runtime)
                if sha(build_path)!=build_hash: raise RuntimeError('Build manifest changed')
                provenance['unchanged_verified']=True
            except Exception as error: errors.append('provenance: '+str(error))
        try:
            config_path=out/'run-config.json'
            config_record=json.loads(config_path.read_text(encoding='utf-8-sig'))
            config_record['provenance']=provenance
            write(config_path,config_record)
        except Exception as error: errors.append('provenance report: '+str(error))
        helper_status.update({name:proc.poll() for proc,identity,name in helpers if name!='presentmon'})
        for proc, identity, name in reversed(helpers):
            if proc.poll() is None:
                try: safe_stop(proc,identity)
                except Exception as error: errors.append('cleanup: '+str(error))
        for log in logs: log.close()
    driver_result={}
    if (out/'driver-result.json').exists():
        try: driver_result=json.loads((out/'driver-result.json').read_text(encoding='utf-8-sig'))
        except ValueError as error: errors.append('Malformed driver result: '+str(error))
    for name in ('inventory','sampler','presentmon'):
        if helper_status.get(name)!=0: errors.append(f'{name} helper exit/status: {helper_status.get(name)}')
    if (out/'presentmon.log').exists():
        errors.extend(presentmon_log_issues((out/'presentmon.log').read_text(encoding='utf-8-sig',errors='replace')))
    raw_client = read_lines(out/'client.ndjson',errors)
    raw_health = read_lines(out/'health.ndjson',errors)
    ACTIVE_REPORT.update(errors=errors,client=raw_client,health=raw_health,
                         driver=driver_result,driver_exit=helper_status.get('driver'))
    client=normalize_client(raw_client,errors)
    events, candidates, rejected, ownership = [],{},{},{}
    if (out/'present.csv').exists() and rows:
        ownership=ownership_intervals(rows)
        write(out/'ownership-intervals.json',ownership)
        try: events,candidates,rejected=presented_events(out/'present.csv', rows[0]['qpc_frequency'],ownership)
        except Exception as error: errors.append('presentation: '+str(error))
    selected=f'{gpu_pid}:{args.stream}' if args.stream else None
    if args.stream=='sole-owned':
        owned_candidates=[s for s in candidates if s.startswith(f'{gpu_pid}:')]
        selected=owned_candidates[0] if len(owned_candidates)==1 else None
    presentation={'available':False,'reason':'A pilot-verified swapchain must be explicitly selected.'}
    collection_issue=presentation_collection_issue(out/'present.csv',candidates)
    if collection_issue:
        presentation['reason']=collection_issue
        errors.append(collection_issue)
    start,end=driver_result.get('measurementStartUnixMs'),driver_result.get('measurementEndUnixMs')
    ACTIVE_REPORT.update(start=start,end=end)
    if selected and candidates and start and end and rows:
        offset=rows[0]['qpc_ms']-rows[0]['unix_ms']
        if any(lo<=start+offset and hi>=end+offset for lo,hi in ownership.get(gpu_pid,[])):
            presentation=presentation_gate([e['qpc_ms'] for e in events if e['stream']==selected],start+offset,end+offset)
        else:
            presentation={'available':False,'reason':'GPU process ownership interval is not continuous across measurement; missing/replaced PID correlation.'}
    ACTIVE_REPORT['presentation']=presentation
    geometry=driver_result.get('geometry',{})
    system_info=driver_result.get('systemInfo',{}).get('gpu',{})
    devices=system_info.get('devices',[])
    verified={'profile':False,'hardware_adapter':False,'display_stream':False,'geometry':False}
    native_path=profile/'native-info.json'
    if native_path.exists():
        native=json.loads(native_path.read_text(encoding='utf-8-sig')); write(out/'native-info.json',native)
        try:
            verified['profile']=os.path.samefile(native['profile'],profile) and os.path.samefile(native['webviewCache'],profile/'webview-cache') and native.get('rootPid')==root['pid'] and native.get('identifier')=='com.nazmiefearmutcu.flowmap.benchmark'
        except (OSError,KeyError): verified['profile']=False
    # SystemInfo active device plus renderer string: an inventory of two adapters alone is insufficient.
    end_devices=driver_result.get('systemInfoEnd',{}).get('gpu',{}).get('devices',[])
    verified['hardware_adapter']=bool(devices and end_devices and devices[0].get('deviceId')==int(args.gpu_device,16) and
        end_devices[0].get('deviceId')==devices[0].get('deviceId') and args.gpu_device.lower() in geometry.get('glRenderer','').lower())
    baseline={'physical_content':[1920,1080],'dpi':96,'refresh_hz':120,'required_panels':['dom-ladder','tape','cvd-pane'],
              'required_overlays':['profile','cvd','volume']}
    measured_windows=[w for w in window_rows if start and end and start-3500<=w['unix_ms']<=end+3500]
    verified['geometry']=bool(measured_windows and all(w['client_physical']==[1920,1080] and w['dpi']==96 for w in measured_windows) and
        client and all(s.get('geometry',{}).get('physicalContentWidth')==1920 and s.get('geometry',{}).get('physicalContentHeight')==1080 and s.get('geometry',{}).get('devicePixelRatio')==1 for s in client))
    monitor=(placement or {}).get('monitor',{})
    verified['display_refresh']=bool(monitor.get('source_adapter_luid')==args.gpu_luid and monitor.get('target_available') and abs((monitor.get('refresh_hz') or 0)-120)<.05)
    verified['stable_window']=bool(measured_windows and all(w.get('visible') and not w.get('minimized') and
        w['monitor']==monitor and w['outer_physical']==placement['outer_physical'] and w['dpi']==placement['dpi'] for w in measured_windows))
    selected_events=[e for e in events if e['stream']==selected and start and end and start+(rows[0]['qpc_ms']-rows[0]['unix_ms'])<=e['qpc_ms']<end+(rows[0]['qpc_ms']-rows[0]['unix_ms'])]
    display_ids={e['metadata'].get('VidPnSourceId') for e in selected_events}
    # Source ID mapping is supplied by CCD for the HWND's actual active monitor.
    end_gpu_pids=[r.get('id') for r in driver_result.get('processInfoEnd',{}).get('processInfo',[]) if r.get('type')=='GPU']
    gpu_lifetimes=[k for k,v in identities.items() if v['pid']==gpu_pid]
    verified['display_stream']=bool(selected_events and display_ids=={str(monitor.get('source_id'))} and
        end_gpu_pids==[gpu_pid] and len(gpu_lifetimes)==1 and verified['stable_window'] and verified['display_refresh'])
    verified['interaction']=bool(driver_result.get('interactionResponse',{}).get('pan') and driver_result.get('interactionResponse',{}).get('zoom') and len({json.dumps(s.get('view'),sort_keys=True) for s in client})>1)
    verified['workload']=bool(client and all(workload_sample(s,manifest,scope,baseline,independent_health=True) for s in client))
    verified['runtime_provenance']=all(provenance.get(k) is True for k in ('origin_verified','package_parity_verified','source_match_verified','unchanged_verified','identity_verified'))
    verified['history']=bool(history_evidence and driver_result.get('historyVerified'))
    resource=resource_evidence(rows,read_lines(out/'system.ndjson',errors),start,end,os.cpu_count(),args.gpu_luid)
    write(out/'resource-summary.json',resource)
    verdict=assess(presentation,client,raw_health,bool(driver_result.get('complete') and not errors),verified,
        start=start,end=end,scope=scope,manifest=manifest,resources=resource,driver=driver_result,driver_exit=helper_status.get('driver'),
        require_independent_health=True,health_target=ACTIVE_REPORT.get('health_target'))
    result={'acceptance':verdict,'verified':verified,'errors':errors,'presentation_candidates':candidates,'presentation_rejected':rejected,
        'selected_stream':selected,'driver':driver_result,'peak_app_private_commit_bytes':max((r['private_commit_bytes'] for r in rows),default=None),
        'peak_job_commit_bytes':max((r['peak_job_commit_bytes'] for r in rows),default=None),'resource_limits':limits,
        'physical_RAM_claim':'No lower installed RAM or older CPU was physically tested.',
        'provenance':provenance,'runtime_sha256':runtime_hash,'schema':3,'health_contract':'independent-health-v1',
        'evidence_id':owner,'source_fingerprint':source_hash,'exe_sha256':exe_hash,'gpu_luid':args.gpu_luid,
        'baseline':baseline,'workload':manifest,'history_evidence':history_evidence,'resource_summary':resource,'helper_exit_codes':helper_status,
        'observation_status':observer.status() if observer else None,'presentation_cleanup':pm_cleanup,
        'gpu_identity':devices[0] if devices else None,
        'display_metadata_values':sorted(str(v) for v in display_ids),
        'identities':list(identities.values()),
        'artifact_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file() and p.suffix in ('.json','.ndjson','.csv','.png','.log')}}
    write(out/'result.json',result)
    (out/'summary.md').write_text(f"# Windows benchmark\n\nVerdict: **{verdict['status']}**\n\n"+json.dumps(verdict,indent=2)+"\n",encoding='utf-8')
    print(json.dumps({'output':str(out),'status':verdict['status'],'verified':verified,'errors':errors,'candidates':candidates}))
    return 0 if verdict['status']=='PASS' else 2

if __name__=='__main__': raise SystemExit(guarded_main(main))
