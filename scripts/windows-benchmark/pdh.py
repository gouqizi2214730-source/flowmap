"""Locale-neutral PDH queries. No previous-row counter or instance cache.

Every query has two collections: rates span BOTH, gauges use the second.
Callers must bracket the entire query with process ownership observations.
"""
import ctypes as C
from ctypes import wintypes as W
import math
import hashlib
import json
import os
import re
import time

VALID = (0, 1)  # PDH_CSTATUS_VALID_DATA / PDH_CSTATUS_NEW_DATA
MORE_DATA = 0x800007D2
FORMAT = 0x200 | 0x8000  # DOUBLE | NOCAP100; never cap or manufacture zeros
PROVIDER = 'windows-pdh-english-fresh-two-collect-v1'

MEMORY = dict(zip(('AvailableBytes','CommittedBytes','CommitLimit','PagesInputPersec','PagesOutputPersec','PageReadsPersec','PageWritesPersec'),
                 ('Available Bytes','Committed Bytes','Commit Limit','Pages Input/sec','Pages Output/sec','Page Reads/sec','Page Writes/sec')))
CPU = dict(zip(('PercentProcessorTime','PercentUserTime','PercentPrivilegedTime','PercentIdleTime','ProcessorFrequency','ParkingStatus'),
              ('% Processor Time','% User Time','% Privileged Time','% Idle Time','Processor Frequency','Parking Status')))
PAGING = {'PercentUsage':'% Usage','PercentUsagePeak':'% Usage Peak'}
ALLOCATION = {'dedicated_bytes':'Dedicated Usage','shared_bytes':'Shared Usage','committed_bytes':'Total Committed'}
GROUPS = {'Memory':MEMORY, 'Processor Information(*)':CPU, 'Paging File(*)':PAGING,
          'GPU Process Memory(*)':ALLOCATION, 'GPU Adapter Memory(*)':ALLOCATION,
          'GPU Engine(*)':{'utilization_percent':'Utilization Percentage'}}
PATHS = ['\\'+group+'\\'+counter for group,fields in GROUPS.items() for counter in fields.values()]
RATE_PATHS = {'\\Memory\\'+MEMORY[k] for k in tuple(MEMORY)[3:]} | {
    '\\Processor Information(*)\\'+CPU[k] for k in tuple(CPU)[:4]} | {r'\GPU Engine(*)\Utilization Percentage'}

class Formatted(C.Structure):
    _fields_ = [('status',W.DWORD),('value',C.c_double)]
class FormattedItem(C.Structure):
    _fields_ = [('name',W.LPWSTR),('counter',Formatted)]
class Raw(C.Structure):
    _fields_ = [('status',W.DWORD),('timestamp',W.FILETIME),('first',C.c_longlong),
                ('second',C.c_longlong),('multi',W.DWORD)]
class RawItem(C.Structure):
    _fields_ = [('name',W.LPWSTR),('counter',Raw)]

def unix_ms(): return time.time_ns()/1_000_000

def load_api():
    if os.name != 'nt': raise OSError('PDH is Windows-only')
    dll=C.WinDLL('pdh')
    signatures = {
        'PdhOpenQueryW':[W.LPCWSTR,C.c_size_t,C.POINTER(W.HANDLE)],
        'PdhAddEnglishCounterW':[W.HANDLE,W.LPCWSTR,C.c_size_t,C.POINTER(W.HANDLE)],
        'PdhCollectQueryData':[W.HANDLE], 'PdhCloseQuery':[W.HANDLE],
        'PdhGetRawCounterArrayW':[W.HANDLE,C.POINTER(W.DWORD),C.POINTER(W.DWORD),C.c_void_p],
        'PdhGetFormattedCounterArrayW':[W.HANDLE,W.DWORD,C.POINTER(W.DWORD),C.POINTER(W.DWORD),C.c_void_p]}
    for name,args in signatures.items():
        call=getattr(dll,name);call.argtypes=args;call.restype=W.DWORD
    return dll

class Query:
    def __init__(self, paths=PATHS, api=None):
        self.api=api or load_api();self.handle=W.HANDLE();self.handles={};self.stages=[]
        self.check(self.api.PdhOpenQueryW(None,0,C.byref(self.handle)), 'PdhOpenQueryW')
        try:
            for path in paths:
                handle=W.HANDLE()
                self.check(self.api.PdhAddEnglishCounterW(self.handle,path,0,C.byref(handle)), 'PdhAddEnglishCounterW '+path)
                self.handles[path]=handle
        except BaseException:
            self.close();raise

    @staticmethod
    def check(status, call):
        if status: raise OSError(f'{call}: PDH 0x{status:08x}')

    def close(self):
        if self.handle:
            handle=self.handle;self.handle=W.HANDLE()
            self.check(self.api.PdhCloseQuery(handle), 'PdhCloseQuery')

    def __enter__(self): return self
    def __exit__(self,*args): self.close()

    def array(self,handle,raw=False):
        """Bounded resize: reprobe with size=0 after growth; no stale size reuse."""
        call=self.api.PdhGetRawCounterArrayW if raw else self.api.PdhGetFormattedCounterArrayW
        prefix=(handle,) if raw else (handle,FORMAT)
        attempts=[]
        for _ in range(3):
            size,count=W.DWORD(),W.DWORD()
            status=call(*prefix,C.byref(size),C.byref(count),None)
            attempts.append({'phase':'size','status':status,'bytes':size.value})
            if status!=MORE_DATA: return {'status':status,'items':[],'attempts':attempts}
            if not 0<size.value<=64*1024*1024:
                return {'status':None,'items':[],'attempts':attempts,'error':'PDH array size outside 64 MiB bound'}
            capacity=size.value;buffer=C.create_string_buffer(capacity)
            status=call(*prefix,C.byref(size),C.byref(count),buffer)
            attempts.append({'phase':'data','status':status,'bytes':capacity})
            if status==MORE_DATA: continue
            if status: return {'status':status,'items':[],'attempts':attempts}
            item_type=RawItem if raw else FormattedItem
            if count.value*C.sizeof(item_type)>capacity:
                return {'status':None,'items':[],'attempts':attempts,'error':'PDH item count exceeds buffer'}
            values=C.cast(buffer,C.POINTER(item_type));items=[]
            for i in range(count.value):
                item=values[i];entry={'name':item.name,'status':item.counter.status}
                if raw:
                    entry['timestamp_filetime']=(item.counter.timestamp.dwHighDateTime<<32)|item.counter.timestamp.dwLowDateTime
                else:
                    # INVALID_DATA's numeric payload is undefined, not a zero.
                    value=item.counter.value
                    entry['value']=value if item.counter.status in VALID and math.isfinite(value) else None
                items.append(entry)
            return {'status':0,'items':items,'attempts':attempts}
        return {'status':MORE_DATA,'items':[],'attempts':attempts,'error':'PDH array grew on all three attempts'}

    def collect(self):
        stage={'start_unix_ms':unix_ms()};start=time.perf_counter()
        status=self.api.PdhCollectQueryData(self.handle)
        stage.update(end_unix_ms=unix_ms(),elapsed_ms=(time.perf_counter()-start)*1000,status=status)
        self.stages.append(stage);self.check(status,'PdhCollectQueryData')
        return stage

    def acquire(self, interval=1.0, between=None):
        self.collect()
        first={path:self.array(handle,raw=True) for path,handle in self.handles.items()}
        warmup={path:self.array(handle) for path,handle in self.handles.items()}
        # First formatted sample is diagnostic only, even when a gauge is valid.
        if between: between()
        time.sleep(interval)
        self.collect()
        result={}
        for path,handle in self.handles.items():
            raw=self.array(handle,raw=True);formatted=self.array(handle)
            result[path]={'kind':'rate' if path in RATE_PATHS else 'gauge',
                         'first_raw':first[path],'warmup_formatted':warmup[path],
                         'current_raw':raw,'formatted':formatted}
        return result

def checked_values(evidence, path):
    """Union raw and formatted instances, including removed/new/invalid ones."""
    record=evidence[path];maps={};problems=[]
    for field in ('first_raw','current_raw','formatted'):
        array=record[field];items={}
        if array['status']!=0: problems.append(f'{path} {field}: PDH status {array["status"]}')
        for item in array['items']:
            if item['name'] in items: problems.append(f'{path}: duplicate instance {item["name"]}')
            items[item['name']]=item
        maps[field]=items
    names=set().union(*(set(items) for items in maps.values()))
    result={}
    for name in sorted(names):
        first=maps['first_raw'].get(name);raw=maps['current_raw'].get(name);formatted=maps['formatted'].get(name)
        valid=(raw is not None and raw['status'] in VALID and formatted is not None and formatted['status'] in VALID and
               isinstance(formatted.get('value'),(float,int)) and math.isfinite(formatted['value']) and formatted['value']>=0)
        if record['kind']=='rate': valid=valid and first is not None and first['status'] in VALID
        result[name]={'value':formatted['value'] if valid else None,
                      'first_raw_status':first['status'] if first else None,
                      'raw_status':raw['status'] if raw else None,
                      'formatted_status':formatted['status'] if formatted else None}
    return result,problems

def retain_requested_gpu(evidence, requested):
    """Only unrequested host GPU values are summarized; no identity-status filter.

    Full arrays have already been extracted. Include the union of BOTH fresh
    identity snapshots, so new/denied/reused/exited owned candidates survive.
    Malformed instance names survive too and cause a producer/assessment error.
    """
    for path,record in evidence.items():
        if not path.startswith(('\\GPU Process Memory(', '\\GPU Engine(')): continue
        for field in ('first_raw','warmup_formatted','current_raw','formatted'):
            array=record[field];kept=[];omitted=[]
            for item in array['items']:
                parsed=re.match(r'^pid_(\d+)_',item['name'])
                (kept if parsed is None or int(parsed[1]) in requested else omitted).append(item)
            array.update(items=kept,scope='requested-start-end-pid-union',captured_count=len(kept)+len(omitted),
                         omitted_unrequested_count=len(omitted),
                         omitted_unrequested_sha256=hashlib.sha256(json.dumps(omitted,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest())

def validate_row(row):
    """Schema-4 provider proof; imported by assessment, never loads a Windows DLL.

    Legacy CIM rows retain their existing schema-3 checks. A row claiming PDH
    cannot obtain PASS by stripping collection/status/interval evidence.
    """
    issues=[]
    def require(condition, text):
        if not condition: issues.append('PDH '+text)
    def number(value): return type(value) in (int,float) and math.isfinite(value)
    try:
        require(row['schema']==4 and row['counter_provider']==PROVIDER,'schema/provider absent or invalid.')
        lo,hi=row['sample_start_unix_ms'],row['unix_ms']
        stages=row['provider_stages']
        require(len(stages)==2,'must contain exactly two actual collections.')
        first,second=stages
        times=[lo,first['start_unix_ms'],first['end_unix_ms'],second['start_unix_ms'],second['end_unix_ms'],
               row['counter_extraction_end_unix_ms'],row['counter_mapping_end_unix_ms'],hi]
        require(all(number(v) for v in times) and times==sorted(times),'collection/extraction bounds outside full query.')
        require(first['status']==second['status']==0 and all(number(s['elapsed_ms']) and s['elapsed_ms']>=0 for s in stages),'collection API status/timing invalid.')
        require(second['start_unix_ms']>first['end_unix_ms'],'warmup and measured collection must differ.')
        require(row['rate_interval_start_unix_ms']==first['start_unix_ms'] and row['rate_interval_end_unix_ms']==second['end_unix_ms'],
                'rate interval must cover first through second collection.')
        require(row['gauge_collection_start_unix_ms']==second['start_unix_ms'] and row['gauge_collection_end_unix_ms']==second['end_unix_ms'],
                'gauge interval must cover current collection.')
        identities=[]
        for key,left,right in (('identity_start',lo,first['start_unix_ms']),('identity_end',row['counter_mapping_end_unix_ms'],hi)):
            observations=row[key];by_pid={}
            for item in observations:
                require(number(item['start_unix_ms']) and number(item['end_unix_ms']) and left<=item['start_unix_ms']<=item['end_unix_ms']<=right,'identity read outside acquisition bounds.')
                require(item['pid'] not in by_pid and type(item['pid']) is int and item['pid']>0,'duplicate/invalid identity PID.')
                require(type(item['expected_creation_ticks']) is int and item['expected_creation_ticks']>0,'expected creation identity invalid.')
                require(type(item['verified']) is bool and (not item['verified'] or item['creation_ticks']==item['expected_creation_ticks']), 'identity verification contradicts creation ticks.')
                by_pid[item['pid']]=item
            identities.append(by_pid)
        requested={pid:item['expected_creation_ticks'] for identity in reversed(identities) for pid,item in identity.items()}
        for pid in identities[0].keys() & identities[1].keys():
            require(identities[0][pid]['expected_creation_ticks']==identities[1][pid]['expected_creation_ticks'],'identity changed between endpoints.')
        evidence=row['counter_evidence'];require(set(evidence)==set(PATHS),'mandatory English counter paths absent/extra.')
        values={}
        for path in PATHS:
            record=evidence[path]
            require(record['kind']==('rate' if path in RATE_PATHS else 'gauge'),'counter rate/gauge semantics invalid.')
            # Warmup retrieval is retained even for INVALID_DATA; it is not used.
            require(isinstance(record['warmup_formatted'],dict) and type(record['warmup_formatted']['status']) is int and isinstance(record['warmup_formatted']['items'],list),'warmup status evidence absent.')
            if path.startswith(('\\GPU Process Memory(', '\\GPU Engine(')):
                for field in ('first_raw','warmup_formatted','current_raw','formatted'):
                    array=record[field]
                    require(array['scope']=='requested-start-end-pid-union' and type(array['omitted_unrequested_count']) is int and array['omitted_unrequested_count']>=0 and
                            array['captured_count']==len(array['items'])+array['omitted_unrequested_count'] and bool(re.fullmatch('[0-9a-f]{64}',array['omitted_unrequested_sha256'])),
                            'unrequested GPU summary malformed.')
                    for item in array['items']:
                        parsed=re.match(r'^pid_(\d+)_',item['name'])
                        require(parsed is not None and int(parsed[1]) in requested,'retained GPU instance malformed or outside requested union.')
            values[path],problems=checked_values(evidence,path);issues.extend(problems)
        def match(group, rows, name_key, select=lambda name: True):
            expected=set().union(*(set(values['\\'+group+'\\'+counter]) for counter in GROUPS[group].values()))
            expected={name for name in expected if select(name)}
            require(len(rows)==len(expected) and {r[name_key] for r in rows}==expected,group+' instance coverage differs from actual raw arrays.')
            for item in rows:
                for field,counter in GROUPS[group].items():
                    value=values['\\'+group+'\\'+counter].get(item[name_key],{}).get('value')
                    require(value is not None and item.get(field)==value,group+' counter missing/invalid or differs from PDH data.')
        match('Memory',[dict(row['system_memory'],Name='')],'Name')
        match('Processor Information(*)',row['per_core_cpu'],'Name',lambda name:bool(re.fullmatch(r'\d+,\d+',name)))
        match('Paging File(*)',row['paging_file'],'Name')
        match('GPU Adapter Memory(*)',row['gpu_adapter_host_totals'],'instance')
        def expected_luid(name):
            parsed=re.search(r'(?:^|_)luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_',name)
            if not parsed: return None
            high=int(parsed[1],16)
            return f'{high if high<2**31 else high-2**32},{int(parsed[2],16)}'
        for item in row['gpu_adapter_host_totals']:
            require(item.get('luid') is not None and item['luid']==expected_luid(item['instance']),'adapter LUID differs from exact instance.')
        for group,kind in (('GPU Process Memory(*)','allocation'),('GPU Engine(*)','engine')):
            candidates=[c for c in row['owned_gpu_candidates'] if c['kind']==kind]
            def owned_name(name):
                parsed=re.match(r'^pid_(\d+)_',name)
                return bool(parsed and int(parsed[1]) in requested)
            match(group,candidates,'instance',owned_name)
            for item in candidates:
                pid=item['pid'];require(item['expected_creation_ticks']==requested[pid],'candidate expected identity differs.')
                parsed=re.match(r'^pid_(\d+)_',item['instance'])
                require(parsed is not None and int(parsed[1])==pid,'candidate PID differs from exact instance.')
                if kind=='allocation': require(item.get('luid') is not None and item['luid']==expected_luid(item['instance']),'candidate LUID differs from exact instance.')
                for index,key in enumerate(('identity_verified_at_start','identity_verified_at_end')):
                    verified=identities[index].get(pid,{}).get('verified') is True
                    require(item[key] is verified,'candidate identity proof differs from actual endpoint read.')
                require(item['creation_ticks']==(requested[pid] if item['identity_verified_at_start'] else None),'candidate creation identity differs from actual endpoint read.')
            expected=[{k:v for k,v in c.items() if k not in ('kind','expected_creation_ticks','identity_verified_at_start','identity_verified_at_end')}
                      for c in candidates if c['identity_verified_at_start'] and c['identity_verified_at_end'] and all(c.get(k) is not None for k in GROUPS[group])]
            stream=row['gpu_process_allocations_unsummed' if kind=='allocation' else 'owned_gpu_engines']
            require(sorted(stream,key=lambda v:v['instance'])==sorted(expected,key=lambda v:v['instance']),'attributed GPU stream differs from valid identity-bound raw candidates.')
        require(number(row['sampler_ms']) and row['sampler_ms']>=0,'monotonic query duration absent.')
    except (KeyError,TypeError,ValueError,AttributeError,IndexError,OverflowError):
        issues.append('PDH required provider/interval/status evidence absent or malformed.')
    return list(dict.fromkeys(issues))
