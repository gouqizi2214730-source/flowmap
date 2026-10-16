"""Real self-owned Windows EX2, held identity, exit and permanent-error tests."""
import ctypes as C
from ctypes import wintypes as W
import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import win32
from core import validate_limits
from observation import observe_processes, ProcessObserver


@unittest.skipUnless(os.name=='nt','Real Windows EX2/held process handles')
class WindowsMemoryTests(unittest.TestCase):
    def clock(self):
        now=[100.0]
        clock=SimpleNamespace(monotonic=lambda:now[0],time=lambda:1700000000+now[0],
                              sleep=lambda duration:now.__setitem__(0,now[0]+duration))
        return clock,now

    def child(self):
        code="import sys; a=bytearray(32*1024*1024); a[::4096]=b'x'*(len(a)//4096); print('READY',flush=True); sys.stdin.readline()"
        # The Windows venv redirector is a different process from its Python
        # worker; launch the actual interpreter so this PID owns the allocation.
        proc=subprocess.Popen([sys._base_executable,'-I','-B','-c',code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE,text=True,creationflags=0x08000000)
        def stop():
            if proc.poll() is None: proc.terminate()
            proc.communicate(timeout=5)
        self.addCleanup(stop)
        self.assertEqual(proc.stdout.readline().strip(),'READY')
        return proc

    def test_actual_96_byte_ex2_owned_child_identity_and_complete_job_ram(self):
        self.assertEqual(C.sizeof(win32.MemoryEx2),96)
        proc=self.child()
        row=win32.process_sample(proc.pid)
        self.assertEqual(row['pid'],proc.pid)
        self.assertGreater(row['creation_ticks'],0)
        self.assertEqual(row['private_working_set_source'],win32.PRIVATE_WS_SOURCE)
        self.assertGreater(row['private_working_set_bytes'],30*1024*1024)
        self.assertLessEqual(row['private_working_set_bytes'],row['working_set_bytes_not_summed'])
        self.assertNotEqual(row['private_working_set_bytes'],row['working_set_bytes_not_summed'])
        self.assertEqual(win32.process_sample(proc.pid)['creation_ticks'],row['creation_ticks'])
        # Independently ask the native API on Popen's retained owned handle.
        native=win32.MemoryEx2();native.cb=C.sizeof(native)
        self.assertTrue(win32.psapi.GetProcessMemoryInfo(W.HANDLE(int(proc._handle)),C.byref(native),C.sizeof(native)))
        self.assertLess(abs(row['private_working_set_bytes']-native.PrivateWorkingSetSize),1024*1024)
        job=win32.Job(validate_limits(None,None,None,os.cpu_count()))
        self.addCleanup(job.close)
        self.assertTrue(win32.kernel.AssignProcessToJobObject(job.handle,W.HANDLE(int(proc._handle))))
        observation=observe_processes(job,win32.process_sample,win32.qpc)
        self.assertEqual(observation['schema'],4)
        self.assertTrue(observation['owned_tree_complete'],observation)
        self.assertEqual(observation['job_pids_start'],[proc.pid])
        self.assertEqual(observation['job_pids_end'],[proc.pid])
        self.assertEqual(observation['private_working_set_bytes'],observation['processes'][0]['private_working_set_bytes'])

    def test_real_exit_while_query_has_same_held_handle_creation_proof(self):
        proc=self.child();expected=win32.process_sample(proc.pid)
        original=win32.kernel.QueryFullProcessImageNameW
        def exit_then_query(*args):
            proc.terminate();proc.wait(timeout=5)
            return original(*args)
        with patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=exit_then_query):
            with self.assertRaises(win32.ConfirmedProcessExit) as caught: win32.process_sample(proc.pid)
        self.assertEqual(caught.exception.creation_ticks,expected['creation_ticks'])
        self.assertEqual(caught.exception.pid,proc.pid)
        self.assertIn('same held process handle',caught.exception.exit_proof)

    def test_confirmed_child_exit_is_recorded_and_reconciled_without_adopting_a_pid(self):
        proc=self.child();expected=win32.process_sample(proc.pid)
        class Job:
            calls=0
            def pids(self):
                self.calls+=1
                return [os.getpid(),proc.pid] if self.calls==1 else [os.getpid()]
            def peak_commit(self): return 0
        def sample(pid,**kwargs):
            if pid==proc.pid:
                original=win32.kernel.QueryFullProcessImageNameW
                def exiting(*args): proc.terminate();proc.wait(timeout=5);return original(*args)
                with patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=exiting):
                    return win32.process_sample(pid,**kwargs)
            return win32.process_sample(pid,**kwargs)
        row=observe_processes(Job(),sample,win32.qpc)
        self.assertTrue(row['owned_tree_complete'],row)
        self.assertEqual(row['confirmed_exits'][0]['creation_ticks'],expected['creation_ticks'])
        self.assertEqual(row['job_pids_end'],[os.getpid()])
        self.assertEqual(row['process_attempts'][-1]['status'],'confirmed_exited')

    def test_live_denial_is_never_mislabeled_exit_and_observer_retains_traceback(self):
        proc=self.child()
        def denied(*args): C.set_last_error(5);return 0
        with patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=denied):
            with self.assertRaises(win32.NativeProcessError) as caught: win32.process_sample(proc.pid)
            self.assertNotIsInstance(caught.exception,win32.ConfirmedProcessExit)
            self.assertEqual(caught.exception.call,'QueryFullProcessImageNameW')
            self.assertEqual(caught.exception.pid,proc.pid);self.assertEqual(caught.exception.winerror,5)
            class Job:
                handle='owned-test-job'
                def pids(self):return [proc.pid]
                def peak_commit(self):return 0
            collector=ProcessObserver(lambda:observe_processes(Job(),win32.process_sample,win32.qpc)).start()
            self.assertTrue(collector.stop_requested.wait(2));self.assertTrue(collector.stop())
        detail=collector.status()['error_details'][0]
        self.assertEqual(detail['pid'],proc.pid);self.assertEqual(detail['winerror'],5)
        self.assertIn('QueryFullProcessImageNameW',detail['traceback'])
        self.assertIn('stage=process_sample',detail['traceback'])
        self.assertEqual(detail['acquisition_evidence']['process_attempts'][0]['status'],'error')
        attempt=detail['acquisition_evidence']['process_attempts'][0]
        self.assertGreater(attempt['creation_ticks'],0)
        self.assertGreater(len(attempt['image_query_attempts']),1)
        self.assertTrue(all(a['winerror']==5 and a['wait']==258 for a in attempt['image_query_attempts']))
        self.assertIsNone(proc.poll())

    def test_transient_image_denial_reprobes_same_handle_resets_buffer_and_persists_success(self):
        proc=self.child();expected=win32.process_sample(proc.pid)
        original=win32.kernel.QueryFullProcessImageNameW;handles=[];capacities=[]
        def transient(handle,flags,image,length):
            handles.append(handle);capacities.append(C.cast(length,C.POINTER(W.DWORD))[0])
            if len(handles)==1:
                C.cast(length,C.POINTER(W.DWORD))[0]=1
                C.set_last_error(5);return 0
            return original(handle,flags,image,length)
        class Job:
            def pids(self):return [proc.pid]
            def peak_commit(self):return 0
        with patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=transient), \
                patch.object(win32.kernel,'OpenProcess',wraps=win32.kernel.OpenProcess) as opened:
            row=observe_processes(Job(),win32.process_sample,win32.qpc)
        self.assertTrue(row['owned_tree_complete'])
        self.assertEqual(opened.call_count,1);self.assertEqual(handles,[handles[0]]*2)
        self.assertEqual(capacities,[32768,32768])
        evidence=row['process_attempts'][0]['image_query_attempts']
        self.assertEqual(evidence,row['processes'][0]['image_query_attempts'])
        self.assertEqual([a['winerror'] for a in evidence],[5,None])
        self.assertTrue(all(a['creation_ticks']==expected['creation_ticks'] for a in evidence))
        self.assertEqual(row['processes'][0]['image'],expected['image'])
        self.assertLessEqual(row['observation_start_unix_ms'],evidence[0]['start_unix_ms'])
        self.assertGreaterEqual(row['observation_end_unix_ms'],evidence[-1]['state_unix_ms'])

    def test_denial_then_actual_owned_child_exit_preserves_original_and_final_api_errors(self):
        proc=self.child();expected=win32.process_sample(proc.pid)
        original=win32.kernel.QueryFullProcessImageNameW;handles=[]
        def exiting(handle,*args):
            handles.append(handle)
            if len(handles)==1:C.set_last_error(5);return 0
            proc.terminate();proc.wait(timeout=5)
            return original(handle,*args)
        class Job:
            calls=0
            def pids(self):
                self.calls+=1
                return [proc.pid] if self.calls==1 else []
            def peak_commit(self):return 0
        with patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=exiting):
            row=observe_processes(Job(),win32.process_sample,win32.qpc)
        self.assertTrue(row['owned_tree_complete']);self.assertEqual(row['processes'],[])
        proof=row['confirmed_exits'][0];evidence=proof['image_query_attempts']
        self.assertEqual(proof['winerror'],5);self.assertEqual(proof['creation_ticks'],expected['creation_ticks'])
        self.assertEqual(evidence,row['process_attempts'][0]['image_query_attempts'])
        self.assertEqual(evidence[0]['wait'],258);self.assertEqual(evidence[-1]['wait'],0)
        self.assertEqual(handles,[handles[0]]*2)
        self.assertIn('same held process handle',proof['exit_proof'])

    def test_persistent_live_denial_deadline_and_exit_code_zero_never_prove_exit(self):
        proc=self.child();clock,now=self.clock();starts=[]
        def denied(*args):starts.append(now[0]);C.set_last_error(5);return 0
        def zero_code(handle,value):C.cast(value,C.POINTER(W.DWORD))[0]=0;return 1
        with patch.object(win32,'time',clock), \
                patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=denied), \
                patch.object(win32.kernel,'GetExitCodeProcess',side_effect=zero_code), \
                patch.object(win32.kernel,'OpenProcess',wraps=win32.kernel.OpenProcess) as opened, \
                patch.object(win32.kernel,'CloseHandle',wraps=win32.kernel.CloseHandle) as closed:
            with self.assertRaises(win32.NativeProcessError) as caught:win32.process_sample(proc.pid)
        error=caught.exception
        self.assertNotIsInstance(error,win32.ConfirmedProcessExit)
        self.assertEqual(error.winerror,5);self.assertEqual(opened.call_count,1);self.assertEqual(closed.call_count,1)
        self.assertGreater(len(starts),1);self.assertLessEqual(len(starts),26)
        self.assertLessEqual(now[0]-100,.250);self.assertTrue(all(s<100.250 for s in starts))
        self.assertEqual(len(error.image_query_attempts),len(starts))
        self.assertTrue(all(a['exit_code']==0 and a['wait']==258 for a in error.image_query_attempts))
        self.assertIsNone(proc.poll())

    def test_scheduling_overrun_does_not_start_retry_and_late_success_does_not_recover(self):
        for overrun_during_call in (False,True):
            proc=self.child();clock,now=self.clock();count=[0]
            original=win32.kernel.QueryFullProcessImageNameW
            def query(*args):
                count[0]+=1
                if count[0]==1:C.set_last_error(5);return 0
                now[0]+=.3
                return original(*args)
            if not overrun_during_call:clock.sleep=lambda duration:now.__setitem__(0,now[0]+.3)
            with patch.object(win32,'time',clock),patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=query):
                with self.assertRaises(win32.NativeProcessError) as caught:win32.process_sample(proc.pid)
            self.assertNotIsInstance(caught.exception,win32.ConfirmedProcessExit)
            self.assertEqual(caught.exception.winerror,5)
            self.assertEqual(count[0],2 if overrun_during_call else 1)
            self.assertEqual(len(caught.exception.image_query_attempts),count[0])
            if overrun_during_call:
                self.assertTrue(caught.exception.image_query_attempts[-1]['ok'])
                self.assertGreater(caught.exception.image_query_attempts[-1]['end_monotonic_ms'],100250)

    def test_unrelated_image_errors_and_failed_wait_do_not_retry(self):
        proc=self.child()
        for code,wait_failed in ((87,False),(5,True)):
            def denied(*args):C.set_last_error(code);return 0
            original_wait=win32.kernel.WaitForSingleObject
            def wait(*args):
                if wait_failed:C.set_last_error(6);return 0xffffffff
                return original_wait(*args)
            with patch.object(win32.kernel,'QueryFullProcessImageNameW',side_effect=denied) as query, \
                    patch.object(win32.kernel,'WaitForSingleObject',side_effect=wait):
                with self.assertRaises(win32.NativeProcessError) as caught:win32.process_sample(proc.pid)
            self.assertNotIsInstance(caught.exception,win32.ConfirmedProcessExit)
            self.assertEqual(caught.exception.winerror,code);self.assertEqual(query.call_count,1)
            self.assertEqual(caught.exception.image_query_attempts[0]['wait_error'],6 if wait_failed else None)

    def test_retained_handle_proves_exit_after_successful_ex2_before_tree_reconciliation(self):
        for final_still_lists_pid in (False,True):
            proc=self.child();expected=win32.process_sample(proc.pid)
            class Job:
                calls=0
                def pids(self):
                    self.calls+=1
                    if self.calls==1:return [os.getpid(),proc.pid]
                    proc.terminate();proc.wait(timeout=5)
                    return [os.getpid(),proc.pid] if final_still_lists_pid else [os.getpid()]
                def peak_commit(self):return 0
            row=observe_processes(Job(),win32.process_sample,win32.qpc)
            self.assertEqual(row['owned_tree_complete'],not final_still_lists_pid)
            self.assertEqual(row['confirmed_exits'][0]['creation_ticks'],expected['creation_ticks'])
            self.assertIn('reconciliation',row['confirmed_exits'][0]['call'])
            self.assertEqual(row['process_attempts'][-1]['last_sample_before_exit']['private_working_set_source'],win32.PRIVATE_WS_SOURCE)
            self.assertEqual([p['pid'] for p in row['processes']],[os.getpid()])
            self.assertTrue(all(p.handle is None for p in row['processes']))

    def test_unsupported_ex2_and_unwritten_extension_never_substitute_zero_or_total_ws(self):
        proc=self.child();original=win32.psapi.GetProcessMemoryInfo
        def unsupported(*args): C.set_last_error(87);return 0
        with patch.object(win32.psapi,'GetProcessMemoryInfo',side_effect=unsupported):
            with self.assertRaises(win32.NativeProcessError) as caught:win32.process_sample(proc.pid)
            self.assertEqual(caught.exception.call,'GetProcessMemoryInfo(EX2)')
            self.assertEqual(caught.exception.winerror,87)
        def legacy_only(handle,memory,size):
            return original(handle,memory,C.sizeof(win32.Memory))
        with patch.object(win32.psapi,'GetProcessMemoryInfo',side_effect=legacy_only):
            with self.assertRaisesRegex(win32.NativeProcessError,'EX2 extension absent/invalid'):
                win32.process_sample(proc.pid)
        self.assertIsNone(proc.poll())

    def test_open_denial_has_call_pid_and_no_unproved_exit_recovery(self):
        proc=self.child()
        def denied(*args): C.set_last_error(5);return None
        with patch.object(win32.kernel,'OpenProcess',side_effect=denied):
            with self.assertRaises(win32.NativeProcessError) as caught:win32.process_sample(proc.pid)
        self.assertEqual(caught.exception.call,'OpenProcess');self.assertEqual(caught.exception.pid,proc.pid)
        self.assertNotIsInstance(caught.exception,win32.ConfirmedProcessExit)


if __name__=='__main__':unittest.main()
