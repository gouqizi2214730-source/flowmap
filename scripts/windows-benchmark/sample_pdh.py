"""Single synchronous external sampler; native EX2 RAM stays in ProcessObserver."""
import argparse
import ctypes as C
from ctypes import wintypes as W
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time

from pdh import Query, GROUPS, PROVIDER, checked_values, retain_requested_gpu, unix_ms

GPU_PID = re.compile(r'^pid_(\d+)_')
GPU_LUID = re.compile(r'(?:^|_)luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_')

def luid(name):
    match=GPU_LUID.search(name)
    if not match: raise ValueError('Malformed GPU LUID instance: '+name)
    high=int(match[1],16)
    if high>=2**31: high-=2**32
    return f'{high},{int(match[2],16)}'

def kernel_api():
    dll=C.WinDLL('kernel32',use_last_error=True)
    for name,args,result in (
        ('OpenProcess',[W.DWORD,W.BOOL,W.DWORD],W.HANDLE),
        ('GetProcessTimes',[W.HANDLE]+[C.POINTER(W.FILETIME)]*4,W.BOOL),
        ('WaitForSingleObject',[W.HANDLE,W.DWORD],W.DWORD),
        ('CloseHandle',[W.HANDLE],W.BOOL),
        ('CreateFileW',[W.LPCWSTR,W.DWORD,W.DWORD,C.c_void_p,W.DWORD,W.DWORD,W.HANDLE],W.HANDLE),
        ('ReadFile',[W.HANDLE,C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p],W.BOOL)):
        call=getattr(dll,name);call.argtypes=args;call.restype=result
    return dll

def read_identities(path):
    # Keep atomic native observation publication possible while reading.
    api=kernel_api();handle=api.CreateFileW(str(path),0x80000000,1|2|4,None,3,0,None)
    if handle==C.c_void_p(-1).value: raise C.WinError(C.get_last_error())
    try:
        buffer=C.create_string_buffer(1024*1024);count=W.DWORD()
        if not api.ReadFile(handle,buffer,len(buffer),C.byref(count),None): raise C.WinError(C.get_last_error())
        if count.value==len(buffer): raise ValueError('Identity snapshot exceeds 1 MiB')
        rows=json.loads(buffer.raw[:count.value].decode('utf-8-sig'))
    finally: api.CloseHandle(handle)
    if not isinstance(rows,list): raise ValueError('Identity snapshot must be an array')
    result={}
    for row in rows:
        if not isinstance(row,dict) or any(type(row.get(k)) is not int or row[k]<=0 for k in ('pid','creation_ticks')):
            raise ValueError('Invalid process identity snapshot entry')
        if row['pid'] in result: raise ValueError('Duplicate snapshot PID')
        result[row['pid']]=row['creation_ticks']
    return result

def process_identity(pid):
    api=kernel_api();handle=api.OpenProcess(0x1000|0x100000,False,pid)
    if not handle: raise C.WinError(C.get_last_error())
    try:
        times=[W.FILETIME() for _ in range(4)]
        if not api.GetProcessTimes(handle,*(C.byref(t) for t in times)): raise C.WinError(C.get_last_error())
        if api.WaitForSingleObject(handle,0)!=258: raise OSError('Process no longer live')
        return (times[0].dwHighDateTime<<32)|times[0].dwLowDateTime
    finally: api.CloseHandle(handle)

def check_identities(requested,identity_reader):
    result={}
    for pid,birth in requested.items():
        item={'pid':pid,'expected_creation_ticks':birth,'start_unix_ms':unix_ms()}
        try:
            actual=identity_reader(pid)
            item.update(creation_ticks=actual,verified=actual==birth)
            if actual!=birth: item['error']='Process creation identity mismatch'
        except Exception as error: item.update(creation_ticks=None,verified=False,error=str(error))
        item['end_unix_ms']=unix_ms();result[pid]=item
    return result

def build_fields(evidence, requested, starts, errors):
    groups={}
    for group,fields in GROUPS.items():
        instances={}
        for field,counter in fields.items():
            path='\\'+group+'\\'+counter
            values,issues=checked_values(evidence,path);errors.extend(issues)
            for name,value in values.items(): instances.setdefault(name,{'Name':name})[field]=value['value']
        groups[group]=instances
    memory=groups['Memory']
    if set(memory)!={''}: errors.append('PDH Memory scalar instance missing/ambiguous')
    system=memory.get('',{})
    cpu=[r for n,r in groups['Processor Information(*)'].items() if re.fullmatch(r'\d+,\d+',n)]
    paging=list(groups['Paging File(*)'].values())
    for group,rows in (('Memory',[system]),('Processor Information(*)',cpu),('Paging File(*)',paging)):
        if not rows: errors.append('PDH '+group+' instances missing')
        for row in rows:
            for field in GROUPS[group]:
                if row.get(field) is None: errors.append('PDH '+group+' '+str(row.get('Name'))+' '+field+' missing/invalid')
    if len(cpu)!=os.cpu_count(): errors.append('PDH logical CPU count differs from host')
    adapters=[]
    for name,row in groups['GPU Adapter Memory(*)'].items():
        item={'instance':name,**{k:row.get(k) for k in GROUPS['GPU Adapter Memory(*)']}}
        try: item['luid']=luid(name)
        except ValueError as error: errors.append(str(error))
        if any(item.get(k) is None for k in GROUPS['GPU Adapter Memory(*)']): errors.append('PDH adapter counters missing/invalid: '+name)
        adapters.append(item)
    if not adapters: errors.append('PDH GPU adapter instances missing')
    candidates=[]
    for group,kind in (('GPU Process Memory(*)','allocation'),('GPU Engine(*)','engine')):
        for name,row in groups[group].items():
            match=GPU_PID.match(name)
            if not match: errors.append('Malformed GPU PID instance: '+name);continue
            pid=int(match[1])
            if pid not in requested: continue
            start=starts.get(pid,{})
            # Candidate retained before either identity filter, even invalid data.
            candidate={'instance':name,'kind':kind,'pid':pid,'expected_creation_ticks':requested[pid],
                       'creation_ticks':requested[pid] if start.get('verified') else None,
                       'identity_verified_at_start':start.get('verified') is True,
                       **{k:row.get(k) for k in GROUPS[group]}}
            if kind=='allocation':
                try: candidate['luid']=luid(name)
                except ValueError as error: errors.append(str(error))
            if any(candidate[k] is None for k in GROUPS[group]): errors.append('PDH owned GPU candidate counter missing/invalid: '+name)
            candidates.append(candidate)
    return {'system_memory':{k:system.get(k) for k in GROUPS['Memory']},'per_core_cpu':cpu,'paging_file':paging,
            'gpu_adapter_host_totals':adapters,'owned_gpu_candidates':candidates}

def sample(identity_path, *, query_factory=Query, snapshot_reader=read_identities, identity_reader=process_identity, interval=1.0):
    start=unix_ms();clock=time.perf_counter();errors=[];diagnostics=[];stages=[]
    row={'schema':4,'counter_provider':PROVIDER,'sample_start_unix_ms':start,'errors':errors,
         'sampler_pid':os.getpid(),'sampler_interpreter':sys.executable,
         'private_working_sets':[],'private_ws_diagnostic_errors':['Independent CIM WS diagnostic intentionally omitted; mandatory native EX2 unchanged.'],
         'identity_diagnostic_errors':diagnostics,'provider_stages':stages,'counter_evidence':{},
         'system_memory':{},'per_core_cpu':[],'paging_file':[],'gpu_adapter_host_totals':[],
         'owned_gpu_candidates':[],'gpu_process_allocations_unsummed':[],'owned_gpu_engines':[]}
    try:
        requested=snapshot_reader(identity_path)
        starts=check_identities(requested,identity_reader)
        row['identity_start']=list(starts.values())
        with query_factory() as query:
            stages=query.stages
            row['provider_stages']=stages
            evidence=query.acquire(interval=interval)
            row['counter_evidence']=evidence
        row['counter_extraction_end_unix_ms']=unix_ms()
        # A newly published owned PID must not vanish through start-only filtering.
        last_requested=snapshot_reader(identity_path)
        for pid,birth in last_requested.items():
            if pid in requested and requested[pid]!=birth: errors.append('PID creation identity changed between snapshots: '+str(pid))
            requested.setdefault(pid,birth)
        retain_requested_gpu(evidence,requested)
        row.update(build_fields(evidence,requested,starts,errors))
        row['counter_mapping_end_unix_ms']=unix_ms()
        ends=check_identities(requested,identity_reader)
        row['identity_end']=list(ends.values())
        for observations in (starts,ends):
            diagnostics.extend(f'PID {pid}: {value["error"]}' for pid,value in observations.items() if value.get('error'))
        for candidate in row['owned_gpu_candidates']:
            candidate['identity_verified_at_end']=ends[candidate['pid']]['verified']
            fields=GROUPS['GPU Process Memory(*)' if candidate['kind']=='allocation' else 'GPU Engine(*)']
            valid=all(candidate[k] is not None for k in fields)
            positive=any(candidate[k] is not None and candidate[k]>0 for k in fields)
            owned=candidate['identity_verified_at_start'] and candidate['identity_verified_at_end']
            if positive and not owned: errors.append('Positive owned GPU candidate has unproven full-query identity: '+str(candidate['pid']))
            if valid and owned:
                item={k:v for k,v in candidate.items() if k not in ('kind','expected_creation_ticks','identity_verified_at_start','identity_verified_at_end')}
                row['gpu_process_allocations_unsummed' if candidate['kind']=='allocation' else 'owned_gpu_engines'].append(item)
        row['rate_interval_start_unix_ms']=stages[0]['start_unix_ms']
        row['rate_interval_end_unix_ms']=stages[1]['end_unix_ms']
        row['gauge_collection_start_unix_ms']=stages[1]['start_unix_ms']
        row['gauge_collection_end_unix_ms']=stages[1]['end_unix_ms']
    except Exception as error: errors.append(type(error).__name__+': '+str(error))
    row.update(unix_ms=unix_ms(),sampler_ms=(time.perf_counter()-clock)*1000,
               timestamp_utc=datetime.now(timezone.utc).isoformat(),
               precision_notes='PDH DOUBLE, NOCAP100; pagefile usage is a floating percentage of provider page counts, not integral CIM. Rates span first through second collect; gauges are second collect. Warmup excluded; no cached previous-row data.')
    return row

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--identity-file',required=True);parser.add_argument('--output-file',required=True);parser.add_argument('--stop-file',required=True)
    args=parser.parse_args()
    with open(args.output_file,'a',encoding='utf-8',newline='\n') as output:
        while not Path(args.stop_file).exists():
            start=time.monotonic();row=sample(args.identity_file)
            output.write(json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n');output.flush()
            time.sleep(max(0,1-(time.monotonic()-start)))

if __name__=='__main__':main()
