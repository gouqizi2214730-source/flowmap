"""Execute the actual PowerShell sampler with isolated counter/identity mocks."""
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from core import resource_evidence
from test_observation import bounded


HERE=Path(__file__).resolve().parent
WRAPPER=r'''
param([string]$SourceScript,[string]$IdentityFile,[string]$OutputFile,[string]$StopFile,[string]$Mode)
$ErrorActionPreference='Stop'
$script:stopPath=$StopFile; $script:caseMode=$Mode; $script:counts=@{}
$script:birth=[DateTime]::SpecifyKind([DateTime]::Parse('2026-01-01T00:00:00'),[DateTimeKind]::Utc)
function Get-Process {
    param([int]$Id)
    $script:counts[$Id]=1+$script:counts[$Id]
    if ($Id -eq 2) {
        if ($script:caseMode -eq 'missing') { return $null }
        if ($script:caseMode -eq 'mismatch') { return [PSCustomObject]@{Id=2;StartTime=$script:birth.AddSeconds(1)} }
        if ($script:caseMode -in @('denial','utility','zero') -or ($script:caseMode -eq 'end-denial' -and $script:counts[$Id] -ge 3)) {
            $item=[PSCustomObject]@{Id=2}
            $item | Add-Member -MemberType ScriptProperty -Name StartTime -Value {throw [UnauthorizedAccessException]::new('owned StartTime denial')}
            return $item
        }
    }
    [PSCustomObject]@{Id=$Id;StartTime=$script:birth}
}
function Get-CimInstance {
    param([string]$ClassName)
    $gpuIds=if ($script:caseMode -eq 'utility') { @(1) } else { @(1,2) }
    switch ($ClassName) {
        'Win32_PerfFormattedData_PerfProc_Process' { foreach ($n in 1,2) { [PSCustomObject]@{IDProcess=$n;WorkingSetPrivate=20} } }
        'Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory' {
            foreach ($n in $gpuIds) {
                $value=if ($script:caseMode -eq 'zero' -and $n -eq 2) { 0 } else { 10 }
                [PSCustomObject]@{Name="pid_${n}_luid_0x00000000_0x00000001_phys_0";DedicatedUsage=$value;SharedUsage=$value;TotalCommitted=2*$value}
            }
        }
        'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory' {
            [PSCustomObject]@{Name='luid_0x00000000_0x00000001_phys_0';DedicatedUsage=20;SharedUsage=20;TotalCommitted=40}
        }
        'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine' {
            foreach ($n in $gpuIds) {
                $value=if ($script:caseMode -eq 'zero' -and $n -eq 2) { 0 } else { 1 }
                [PSCustomObject]@{Name="pid_${n}_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D";UtilizationPercentage=$value}
            }
        }
        'Win32_PerfFormattedData_PerfOS_Memory' {
            [PSCustomObject]@{AvailableBytes=100;CommittedBytes=100;CommitLimit=100;PagesInputPersec=0;PagesOutputPersec=0;PageReadsPersec=0;PageWritesPersec=0}
        }
        'Win32_PerfFormattedData_Counters_ProcessorInformation' { [PSCustomObject]@{Name='0,0';PercentProcessorTime=10} }
        'Win32_PerfFormattedData_PerfOS_PagingFile' {
            [IO.File]::WriteAllText($script:stopPath,'stop')
            [PSCustomObject]@{Name='_Total';PercentUsage=0}
        }
        default { throw "Unexpected CIM class: $ClassName" }
    }
}
. $SourceScript -IdentityFile $IdentityFile -OutputFile $OutputFile -StopFile $StopFile
'''


@unittest.skipUnless(os.name=='nt','Actual Windows PowerShell sampler')
class WindowsGpuSamplerTests(unittest.TestCase):
    def sample(self,mode):
        creation=int((datetime(2026,1,1,tzinfo=timezone.utc)-datetime(1601,1,1,tzinfo=timezone.utc)).total_seconds()*10_000_000)
        with tempfile.TemporaryDirectory(prefix='gpu-sampler-owned-') as directory:
            root=Path(directory);script=root/'wrapper.ps1';identity=root/'identity.json';output=root/'system.ndjson'
            script.write_text(WRAPPER,encoding='utf-8-sig')
            identity.write_text(json.dumps([{'pid':n,'creation_ticks':creation} for n in (1,2)]),encoding='utf-8')
            result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(script),
                str(HERE/'sample.ps1'),str(identity),str(output),str(root/'stop'),mode],capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            rows=[json.loads(line) for line in output.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(len(rows),1)
            return rows[0],creation

    def assess(self,sample,creation):
        lo,hi=sample['sample_start_unix_ms'],sample['unix_ms']
        process=[]
        for at in (lo-1000,lo-500,hi+500,hi+1000):
            row=bounded(at,at,creation)
            row['processes'].append(row['processes'][0]|{'pid':2})
            row.update(job_pids_start=[1,2],job_pids_end=[1,2],private_commit_bytes=200,private_working_set_bytes=40)
            process.append(row)
        other=copy.deepcopy(sample);other['unix_ms']+=1
        return resource_evidence(process,[sample,other],lo-500,hi+500,1,'0,1')

    def test_start_denial_missing_and_reused_owned_gpu_candidates_cannot_disappear(self):
        for mode in ('denial','missing','mismatch','end-denial'):
            with self.subTest(mode=mode):
                sample,creation=self.sample(mode)
                self.assertEqual([g['pid'] for g in sample['gpu_process_allocations_unsummed']],[1])
                self.assertEqual([g['pid'] for g in sample['owned_gpu_engines']],[1])
                candidates=[g for g in sample['owned_gpu_candidates'] if g['pid']==2]
                self.assertEqual({g['kind'] for g in candidates},{'allocation','engine'})
                self.assertTrue(all(g['expected_creation_ticks']==creation for g in candidates))
                if mode!='end-denial': self.assertTrue(all(g['creation_ticks'] is None for g in candidates))
                self.assertTrue(any('Positive owned GPU' in e for e in sample['errors']))
                self.assertFalse(self.assess(sample,creation)['available'])
                sample['errors']=[]  # Assessment must also reject retained uncertainty independently.
                assessed=self.assess(sample,creation)
                self.assertFalse(assessed['available'])
                self.assertIn('Positive owned GPU candidate has unproven/omitted full-query identity or counters.',assessed['missing'])
                self.assertEqual(assessed['peak_private_working_set_bytes'],40)

    def test_unrelated_non_gpu_utility_denial_stays_private_diagnostic_only(self):
        for mode in ('utility','zero'):
            with self.subTest(mode=mode):
                sample,creation=self.sample(mode)
                self.assertEqual(sample['errors'],[])
                self.assertTrue(sample['private_ws_diagnostic_errors'])
                self.assertEqual({g['pid'] for g in sample['owned_gpu_candidates']},{1} if mode=='utility' else {1,2})
                assessed=self.assess(sample,creation)
                self.assertTrue(assessed['available'],assessed['missing'])
                self.assertFalse(assessed['cim_private_ws_diagnostics']['available'])

    def test_verified_candidates_pass_but_positive_candidate_omission_or_missing_schema_does_not(self):
        sample,creation=self.sample('valid')
        self.assertEqual(sample['errors'],[])
        self.assertEqual({g['pid'] for g in sample['owned_gpu_candidates']},{1,2})
        self.assertTrue(self.assess(sample,creation)['available'])
        omitted=copy.deepcopy(sample)
        for field in ('gpu_process_allocations_unsummed','owned_gpu_engines'):
            omitted[field]=[g for g in omitted[field] if g['pid']==1]
        self.assertFalse(self.assess(omitted,creation)['available'])
        for key,value in (('owned_gpu_candidates',None),('owned_gpu_candidates',[]),('schema',2)):
            bad=copy.deepcopy(sample);bad[key]=value
            self.assertFalse(self.assess(bad,creation)['available'])


if __name__=='__main__':unittest.main()
