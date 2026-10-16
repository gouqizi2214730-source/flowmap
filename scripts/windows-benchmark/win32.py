"""Owned suspended launch + Windows nested job limits; no external process adoption."""
from __future__ import annotations
import ctypes as C
from ctypes import wintypes as W
import os
from pathlib import Path
import subprocess
import time
from core import identity_matches, NATIVE_PRIVATE_WS_SOURCE

SIZE = C.c_size_t
ULONG64 = C.c_ulonglong

class BasicLimits(C.Structure):
    _fields_ = [('PerProcessUserTimeLimit', C.c_longlong), ('PerJobUserTimeLimit', C.c_longlong),
                ('LimitFlags', W.DWORD), ('MinimumWorkingSetSize', SIZE), ('MaximumWorkingSetSize', SIZE),
                ('ActiveProcessLimit', W.DWORD), ('Affinity', SIZE), ('PriorityClass', W.DWORD), ('SchedulingClass', W.DWORD)]
class Io(C.Structure):
    _fields_ = [(n, ULONG64) for n in ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]
class ExtendedLimits(C.Structure):
    _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', Io), ('ProcessMemoryLimit', SIZE),
                ('JobMemoryLimit', SIZE), ('PeakProcessMemoryUsed', SIZE), ('PeakJobMemoryUsed', SIZE)]
class CpuRate(C.Structure):
    _fields_ = [('ControlFlags', W.DWORD), ('CpuRate', W.DWORD)]
class Startup(C.Structure):
    _fields_ = [('cb', W.DWORD), ('lpReserved', W.LPWSTR), ('lpDesktop', W.LPWSTR), ('lpTitle', W.LPWSTR),
                ('dwX', W.DWORD), ('dwY', W.DWORD), ('dwXSize', W.DWORD), ('dwYSize', W.DWORD),
                ('dwXCountChars', W.DWORD), ('dwYCountChars', W.DWORD), ('dwFillAttribute', W.DWORD),
                ('dwFlags', W.DWORD), ('wShowWindow', W.WORD), ('cbReserved2', W.WORD),
                ('lpReserved2', C.POINTER(C.c_byte)), ('hStdInput', W.HANDLE), ('hStdOutput', W.HANDLE), ('hStdError', W.HANDLE)]
class ProcessInfo(C.Structure):
    _fields_ = [('hProcess', W.HANDLE), ('hThread', W.HANDLE), ('dwProcessId', W.DWORD), ('dwThreadId', W.DWORD)]
class Memory(C.Structure):
    _fields_ = [('cb', W.DWORD), ('PageFaultCount', W.DWORD)] + [(n, SIZE) for n in (
        'PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage',
        'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]
class MemoryEx2(C.Structure):
    _fields_ = Memory._fields_ + [('PrivateWorkingSetSize', SIZE), ('SharedCommitUsage', ULONG64)]

PRIVATE_WS_SOURCE = NATIVE_PRIVATE_WS_SOURCE


class NativeProcessError(RuntimeError):
    def __init__(self, call, pid, code, detail=None):
        self.call, self.pid, self.winerror = call, pid, code
        super().__init__(f'{call} PID {pid}: WinError {code}: {detail or C.WinError(code)}')


class ConfirmedProcessExit(NativeProcessError):
    def __init__(self, call, pid, code, creation_ticks):
        self.creation_ticks = creation_ticks
        self.exit_proof = 'WaitForSingleObject(same held process handle, 0) == WAIT_OBJECT_0'
        super().__init__(call, pid, code, self.exit_proof)


class HeldProcessSample(dict):
    """Row plus non-serialized exact process handle for tree reconciliation."""
    def __init__(self, row, handle):
        super().__init__(row); self.handle=handle

    def check_live(self):
        state=kernel.WaitForSingleObject(self.handle,0)
        if state==0:
            raise ConfirmedProcessExit('owned-tree reconciliation held-handle check',self['pid'],0,self['creation_ticks'])
        if state!=258: raise NativeProcessError('WaitForSingleObject',self['pid'],C.get_last_error())

    def close(self):
        if self.handle: kernel.CloseHandle(self.handle);self.handle=None

if os.name == 'nt':
    kernel = C.WinDLL('kernel32', use_last_error=True)
    psapi = C.WinDLL('psapi', use_last_error=True)
    def bind(dll, name, args, result=W.BOOL):
        f = getattr(dll, name); f.argtypes = args; f.restype = result; return f
    bind(kernel, 'CreateJobObjectW', [C.c_void_p, W.LPCWSTR], W.HANDLE)
    bind(kernel, 'SetInformationJobObject', [W.HANDLE, C.c_int, C.c_void_p, W.DWORD])
    bind(kernel, 'QueryInformationJobObject', [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.c_void_p])
    bind(kernel, 'AssignProcessToJobObject', [W.HANDLE, W.HANDLE])
    bind(kernel, 'CloseHandle', [W.HANDLE])
    bind(kernel, 'ResumeThread', [W.HANDLE], W.DWORD)
    bind(kernel, 'TerminateProcess', [W.HANDLE, W.UINT])
    bind(kernel, 'OpenProcess', [W.DWORD, W.BOOL, W.DWORD], W.HANDLE)
    bind(kernel, 'GetProcessTimes', [W.HANDLE] + [C.POINTER(W.FILETIME)] * 4)
    bind(kernel, 'QueryFullProcessImageNameW', [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)])
    bind(kernel, 'CreateProcessW', [W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL, W.DWORD, C.c_void_p, W.LPCWSTR, C.POINTER(Startup), C.POINTER(ProcessInfo)])
    bind(kernel, 'QueryPerformanceCounter', [C.POINTER(C.c_longlong)])
    bind(kernel, 'QueryPerformanceFrequency', [C.POINTER(C.c_longlong)])
    bind(kernel, 'IsProcessInJob', [W.HANDLE,W.HANDLE,C.POINTER(W.BOOL)])
    bind(kernel, 'WaitForSingleObject', [W.HANDLE, W.DWORD], W.DWORD)
    bind(kernel, 'GetExitCodeProcess', [W.HANDLE, C.POINTER(W.DWORD)])
    bind(psapi, 'GetProcessMemoryInfo', [W.HANDLE, C.c_void_p, W.DWORD])

def checked(ok, call=None):
    if not ok:
        error=C.WinError(C.get_last_error())
        if call: error.add_note(call)
        raise error
    return ok

def ticks(ft): return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

def qpc():
    value, frequency = C.c_longlong(), C.c_longlong()
    checked(kernel.QueryPerformanceCounter(C.byref(value)), 'QueryPerformanceCounter'); checked(kernel.QueryPerformanceFrequency(C.byref(frequency)), 'QueryPerformanceFrequency')
    return value.value, frequency.value

def query_process_image(handle, pid, creation, attempts):
    """Reprobe only this retained identity; denial alone never proves exit.

    The 250 ms deadline includes the first call and all waits. Do not start a
    retry or accept a recovered result after it. OS scheduling/native calls
    cannot be preempted; actual timings remain evidence, never backdated.
    """
    deadline = time.monotonic() + .250
    original_code = None
    while True:
        image, length = C.create_unicode_buffer(32768), W.DWORD(32768)
        attempt = {'call':'QueryFullProcessImageNameW','pid':pid,'creation_ticks':creation,
                   'start_unix_ms':time.time()*1000,'start_monotonic_ms':time.monotonic()*1000,
                   'buffer_capacity':32768}
        ok = kernel.QueryFullProcessImageNameW(handle, 0, image, C.byref(length))
        code = C.get_last_error() if not ok else None
        attempt.update(end_unix_ms=time.time()*1000,end_monotonic_ms=time.monotonic()*1000,
                       ok=bool(ok),winerror=code,returned_length=length.value,path=image.value if ok else None)
        state = kernel.WaitForSingleObject(handle,0)
        wait_error = C.get_last_error() if state == 0xffffffff else None
        exit_code = W.DWORD()
        exit_ok = kernel.GetExitCodeProcess(handle,C.byref(exit_code))
        exit_error = C.get_last_error() if not exit_ok else None
        attempt.update(wait=state,wait_error=wait_error,exit_code=exit_code.value if exit_ok else None,
                       exit_code_error=exit_error,state_unix_ms=time.time()*1000,
                       state_monotonic_ms=time.monotonic()*1000)
        attempts.append(attempt)
        if original_code is None and not ok: original_code = code
        within_deadline = time.monotonic() <= deadline
        # Only the actual same-handle signal proves exit. Exit code 0 does not.
        if state == 0 and (len(attempts) == 1 or within_deadline):
            raise ConfirmedProcessExit('QueryFullProcessImageNameW',pid,original_code or 0,creation)
        if ok and state == 258 and (len(attempts) == 1 or within_deadline): return image.value
        if (state != 258 or code not in (5,31) or not within_deadline or len(attempts) >= 26): break
        time.sleep(min(.010,max(0,deadline-time.monotonic())))
        if time.monotonic() >= deadline: break
    raise NativeProcessError('QueryFullProcessImageNameW',pid,original_code or code or 0,
                             'No valid image or same-held-handle exit proof within bounded image query')


def process_sample(pid, *, retain_handle=False):
    # SYNCHRONIZE permits exit proof on the SAME held identity. An error code
    # alone never proves exit; OpenProcess failure has no such handle.
    handle = kernel.OpenProcess(0x1000 | 0x0010 | 0x100000, False, pid)
    if not handle: raise NativeProcessError('OpenProcess',pid,C.get_last_error())
    creation=None
    image_attempts=[]
    def call_result(ok, name):
        if ok: return
        code=C.get_last_error()  # capture before the exit-proof API overwrites it
        if kernel.WaitForSingleObject(handle,0)==0:
            raise ConfirmedProcessExit(name,pid,code,creation)
        raise NativeProcessError(name,pid,code)
    try:
        times = [W.FILETIME() for _ in range(4)]
        call_result(kernel.GetProcessTimes(handle, *(C.byref(t) for t in times)), 'GetProcessTimes')
        creation=ticks(times[0])
        image = query_process_image(handle,pid,creation,image_attempts)
        memory = MemoryEx2()
        # Unsupported/old API success must not turn an untouched extension into
        # a fake zero. Both EX2-only fields must actually be supplied.
        sentinel=SIZE(-1).value
        memory.PrivateWorkingSetSize=sentinel; memory.SharedCommitUsage=ULONG64(-1).value
        memory.cb = C.sizeof(memory)
        call_result(psapi.GetProcessMemoryInfo(handle, C.byref(memory), C.sizeof(memory)), 'GetProcessMemoryInfo(EX2)')
        state=kernel.WaitForSingleObject(handle,0)
        if state==0: raise ConfirmedProcessExit('post-EX2 held-handle check',pid,0,creation)
        if state!=258: raise NativeProcessError('WaitForSingleObject',pid,C.get_last_error())
        if (memory.cb!=C.sizeof(memory) or memory.PrivateWorkingSetSize==sentinel or
                memory.SharedCommitUsage==ULONG64(-1).value or memory.PrivateWorkingSetSize>memory.WorkingSetSize):
            raise NativeProcessError('GetProcessMemoryInfo(EX2)',pid,0,'EX2 extension absent/invalid; private WS unavailable')
        row={'pid': pid, 'creation_ticks': creation, 'image': image,
                'image_query_attempts':image_attempts,
                'cpu_seconds': (ticks(times[2]) + ticks(times[3])) / 1e7,
                'private_commit_bytes': memory.PrivateUsage,
                'private_working_set_bytes':memory.PrivateWorkingSetSize,'private_working_set_source':PRIVATE_WS_SOURCE,
                'shared_commit_bytes_not_summed':memory.SharedCommitUsage,'memory_counters_bytes':C.sizeof(memory),
                'working_set_bytes_not_summed': memory.WorkingSetSize,
                'peak_private_commit_bytes': memory.PeakPagefileUsage}
        if retain_handle:
            held=HeldProcessSample(row,handle);handle=None
            return held
        return row
    except BaseException as error:
        error.creation_ticks=creation
        error.image_query_attempts=image_attempts
        raise
    finally:
        if handle: kernel.CloseHandle(handle)


def ambient_cpu_budget():
    """Read the calling process's inherited job before creating the owned job."""
    member=W.BOOL()
    if not kernel.IsProcessInJob(W.HANDLE(-1),None,C.byref(member)):
        return {'available':False,'error':C.get_last_error(),'interpretation':'Containing job CPU budget unknown.'}
    if not member.value: return {'available':True,'in_job':False,'hard_cap':False}
    rate=CpuRate()
    if not kernel.QueryInformationJobObject(None,15,C.byref(rate),C.sizeof(rate),None):
        return {'available':False,'in_job':True,'error':C.get_last_error(),'interpretation':'Containing job CPU budget unknown.'}
    return {'available':True,'in_job':True,'control_flags':rate.ControlFlags,'rate_per_10000':rate.CpuRate,
            'hard_cap':bool(rate.ControlFlags & 1 and rate.ControlFlags & 4),
            'interpretation':'Current containing job only; CPU rates of nested jobs are relative to parent allocation.'}

class Job:
    def __init__(self, limits):
        if os.name != 'nt': raise RuntimeError('Windows only')
        self.handle = checked(kernel.CreateJobObjectW(None, None))
        self.process = None; self.root = None
        try:
            extended = ExtendedLimits(); extended.BasicLimitInformation.LimitFlags = 0x2000  # kill on close
            if limits['affinity_mask']:
                extended.BasicLimitInformation.LimitFlags |= 0x10
                extended.BasicLimitInformation.Affinity = limits['affinity_mask']
            if limits['app_job_commit_limit_bytes']:
                extended.BasicLimitInformation.LimitFlags |= 0x200
                extended.JobMemoryLimit = limits['app_job_commit_limit_bytes']
            checked(kernel.SetInformationJobObject(self.handle, 9, C.byref(extended), C.sizeof(extended)))
            if limits['cpu_hard_rate']:
                rate = CpuRate(0x1 | 0x4, limits['cpu_hard_rate'])  # ENABLE | HARD_CAP
                checked(kernel.SetInformationJobObject(self.handle, 15, C.byref(rate), C.sizeof(rate)))
        except BaseException:
            self.close(); raise

    def launch(self, executable, env):
        info, startup = ProcessInfo(), Startup(); startup.cb = C.sizeof(startup)
        block = C.create_unicode_buffer('\0'.join(f'{k}={v}' for k, v in sorted(env.items(), key=lambda kv: kv[0].upper())) + '\0\0')
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(executable)]))
        checked(kernel.CreateProcessW(str(executable), command, None, None, False, 0x4 | 0x400, block,
                                      str(Path(executable).parent), C.byref(startup), C.byref(info)))
        self.process = info.hProcess
        try:
            checked(kernel.AssignProcessToJobObject(self.handle, info.hProcess))
            self.root = process_sample(info.dwProcessId)
            if not self.root: raise RuntimeError('Could not identify owned suspended native process')
            if kernel.ResumeThread(info.hThread) == 0xffffffff: raise C.WinError(C.get_last_error())
            return self.root
        except BaseException:
            kernel.TerminateProcess(info.hProcess, 1); raise
        finally: kernel.CloseHandle(info.hThread)

    def pids(self):
        buffer = C.create_string_buffer(65536)
        checked(kernel.QueryInformationJobObject(self.handle, 3, buffer, len(buffer), None), 'QueryInformationJobObject(PID list)')
        count = C.cast(buffer, C.POINTER(W.DWORD))[1]
        if count * C.sizeof(SIZE) + 8 > len(buffer): raise RuntimeError('Job PID buffer too small')
        return list((SIZE * count).from_buffer(buffer, 8))

    def peak_commit(self):
        limits = ExtendedLimits()
        checked(kernel.QueryInformationJobObject(self.handle, 9, C.byref(limits), C.sizeof(limits), None), 'QueryInformationJobObject(peak commit)')
        return limits.PeakJobMemoryUsed

    def close(self):
        if self.handle: kernel.CloseHandle(self.handle); self.handle = None
        if self.process: kernel.CloseHandle(self.process); self.process = None


def safe_stop(helper, expected):
    if helper.poll() is not None: return
    observed = process_sample(helper.pid)
    if helper.poll() is None and identity_matches(expected, observed):
        helper.terminate()
        try: helper.wait(timeout=5)
        except subprocess.TimeoutExpired: helper.kill(); helper.wait(timeout=5)
    elif helper.poll() is None:
        raise RuntimeError('Refusing to stop a helper whose creation time changed')


def place_window(root, rect):
    """Place only a window owned by this exact native process. Negative x is supported.
    Dimensions are physical outer pixels; benchmark shell is undecorated so client matches.
    """
    user = C.WinDLL('user32', use_last_error=True)
    callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    bind(user, 'EnumWindows', [callback_type, W.LPARAM])
    bind(user, 'GetWindowThreadProcessId', [W.HWND, C.POINTER(W.DWORD)], W.DWORD)
    bind(user, 'IsWindowVisible', [W.HWND])
    bind(user, 'SetWindowPos', [W.HWND, W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.UINT])
    bind(user, 'GetWindowRect', [W.HWND, C.POINTER(W.RECT)])
    bind(user, 'GetClientRect', [W.HWND, C.POINTER(W.RECT)])
    bind(user, 'GetDpiForWindow', [W.HWND], W.UINT)
    bind(user, 'SetThreadDpiAwarenessContext', [W.HANDLE], W.HANDLE)
    previous = user.SetThreadDpiAwarenessContext(W.HANDLE(-4))  # per-monitor aware v2, this harness thread only
    windows = []
    @callback_type
    def collect(hwnd, _):
        pid = W.DWORD(); user.GetWindowThreadProcessId(hwnd, C.byref(pid))
        if pid.value == root['pid'] and user.IsWindowVisible(hwnd): windows.append(hwnd)
        return True
    try:
        checked(user.EnumWindows(collect, 0))
        if not identity_matches(root, process_sample(root['pid'])): raise RuntimeError('Native process identity changed')
        if not windows: raise RuntimeError('Owned visible native window not yet available')
        hwnd = windows[0]
        checked(user.SetWindowPos(hwnd, None, *rect, 0x4 | 0x10))  # no-z-order, no activation
        outer, client = W.RECT(), W.RECT()
        checked(user.GetWindowRect(hwnd, C.byref(outer))); checked(user.GetClientRect(hwnd, C.byref(client)))
        return {'hwnd': int(hwnd), 'dpi': user.GetDpiForWindow(hwnd), 'requested_outer_physical': list(rect),
                'outer_physical': [outer.left, outer.top, outer.right-outer.left, outer.bottom-outer.top],
                'client_physical': [client.right-client.left, client.bottom-client.top],
                'monitor': window_monitor(hwnd)}
    finally:
        if previous: user.SetThreadDpiAwarenessContext(previous)


class Luid(C.Structure):
    _fields_=[('LowPart',W.DWORD),('HighPart',W.LONG)]
class Rational(C.Structure):
    _fields_=[('Numerator',W.UINT),('Denominator',W.UINT)]
class DisplaySource(C.Structure):
    _fields_=[('adapterId',Luid),('id',W.UINT),('modeInfoIdx',W.UINT),('statusFlags',W.UINT)]
class DisplayTarget(C.Structure):
    _fields_=[('adapterId',Luid),('id',W.UINT),('modeInfoIdx',W.UINT),('outputTechnology',W.UINT),
              ('rotation',W.UINT),('scaling',W.UINT),('refreshRate',Rational),('scanLineOrdering',W.UINT),
              ('targetAvailable',W.BOOL),('statusFlags',W.UINT)]
class DisplayPath(C.Structure):
    _fields_=[('source',DisplaySource),('target',DisplayTarget),('flags',W.UINT)]
class DeviceHeader(C.Structure):
    _fields_=[('type',W.UINT),('size',W.UINT),('adapterId',Luid),('id',W.UINT)]
class SourceName(C.Structure):
    _fields_=[('header',DeviceHeader),('viewGdiDeviceName',W.WCHAR*32)]
class MonitorInfo(C.Structure):
    _fields_=[('cbSize',W.DWORD),('rcMonitor',W.RECT),('rcWork',W.RECT),('dwFlags',W.DWORD),('szDevice',W.WCHAR*32)]


def window_monitor(hwnd):
    """Owned HWND -> physical monitor -> active CCD source/target and rational Hz.
    No WMI mode guess and no invented mapping of PresentMon VidPnSourceId.
    DISPLAYCONFIG_MODE_INFO is a 16-byte header plus 48-byte aligned union.
    """
    user=C.WinDLL('user32',use_last_error=True)
    bind(user,'MonitorFromWindow',[W.HWND,W.DWORD],W.HANDLE)
    bind(user,'GetMonitorInfoW',[W.HANDLE,C.POINTER(MonitorInfo)])
    bind(user,'GetDisplayConfigBufferSizes',[W.UINT,C.POINTER(W.UINT),C.POINTER(W.UINT)],W.LONG)
    bind(user,'QueryDisplayConfig',[W.UINT,C.POINTER(W.UINT),C.POINTER(DisplayPath),C.POINTER(W.UINT),C.c_void_p,C.c_void_p],W.LONG)
    bind(user,'DisplayConfigGetDeviceInfo',[C.POINTER(DeviceHeader)],W.LONG)
    handle=user.MonitorFromWindow(hwnd,0)
    if not handle: raise RuntimeError('Owned window has no active monitor')
    info=MonitorInfo(); info.cbSize=C.sizeof(info); checked(user.GetMonitorInfoW(handle,C.byref(info)))
    result={'device':info.szDevice,'monitor_physical':[info.rcMonitor.left,info.rcMonitor.top,info.rcMonitor.right,info.rcMonitor.bottom],
            'proof':'MonitorFromWindow/GetMonitorInfoW + QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS)'}
    for _ in range(3):
        pc,mc=W.UINT(),W.UINT()
        error=user.GetDisplayConfigBufferSizes(2,C.byref(pc),C.byref(mc))
        if error: raise C.WinError(error)
        paths=(DisplayPath*pc.value)(); modes=(C.c_ulonglong*(mc.value*8))()
        error=user.QueryDisplayConfig(2,C.byref(pc),paths,C.byref(mc),modes,None)
        if error==122: continue
        if error: raise C.WinError(error)
        matches=[]
        for path in paths[:pc.value]:
            name=SourceName(); name.header=DeviceHeader(1,C.sizeof(SourceName),path.source.adapterId,path.source.id)
            error=user.DisplayConfigGetDeviceInfo(C.byref(name.header))
            if error: raise C.WinError(error)
            if name.viewGdiDeviceName==info.szDevice:
                rate=path.target.refreshRate
                matches.append({'source_id':path.source.id,'target_id':path.target.id,
                    'source_adapter_luid':f'{path.source.adapterId.HighPart},{path.source.adapterId.LowPart}',
                    'target_adapter_luid':f'{path.target.adapterId.HighPart},{path.target.adapterId.LowPart}',
                    'refresh_numerator':rate.Numerator,'refresh_denominator':rate.Denominator,
                    'refresh_hz':rate.Numerator/rate.Denominator if rate.Denominator else None,
                    'target_available':bool(path.target.targetAvailable),'path_flags':path.flags})
        if len(matches)!=1: raise RuntimeError(f'Active monitor source mapping not unique: {matches}')
        return result|matches[0]
    raise RuntimeError('Display topology kept changing during QueryDisplayConfig')


def window_snapshot(root, hwnd):
    if not identity_matches(root,process_sample(root['pid'])): raise RuntimeError('Native window process identity changed')
    user=C.WinDLL('user32',use_last_error=True)
    bind(user,'GetWindowThreadProcessId',[W.HWND,C.POINTER(W.DWORD)],W.DWORD)
    bind(user,'GetWindowRect',[W.HWND,C.POINTER(W.RECT)])
    bind(user,'GetClientRect',[W.HWND,C.POINTER(W.RECT)])
    bind(user,'GetDpiForWindow',[W.HWND],W.UINT)
    bind(user,'IsWindowVisible',[W.HWND])
    bind(user,'IsIconic',[W.HWND])
    pid=W.DWORD(); user.GetWindowThreadProcessId(hwnd,C.byref(pid))
    if pid.value!=root['pid']: raise RuntimeError('Owned HWND changed process')
    outer,client=W.RECT(),W.RECT()
    checked(user.GetWindowRect(hwnd,C.byref(outer))); checked(user.GetClientRect(hwnd,C.byref(client)))
    return {'hwnd':int(hwnd),'dpi':user.GetDpiForWindow(hwnd),'visible':bool(user.IsWindowVisible(hwnd)),
            'minimized':bool(user.IsIconic(hwnd)),
            'outer_physical':[outer.left,outer.top,outer.right-outer.left,outer.bottom-outer.top],
            'client_physical':[client.right-client.left,client.bottom-client.top], 'monitor':window_monitor(hwnd)}
