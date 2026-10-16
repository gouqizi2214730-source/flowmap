param([string]$IdentityFile, [string]$OutputFile, [string]$StopFile, [switch]$Inventory)
$ErrorActionPreference = 'Stop'
function Open-IdentitySnapshot {
    param([string]$Path)
    # Atomic replacement must remain possible while this snapshot is open.
    [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
}
function Read-IdentitySnapshot {
    param([string]$Path)
    $stream = $null; $reader = $null
    try {
        $stream = Open-IdentitySnapshot -Path $Path
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $true)
        $snapshot = $reader.ReadToEnd() | ConvertFrom-Json
        foreach ($identity in $snapshot) { $identity }
    } finally {
        if ($reader) { $reader.Dispose() }
        elseif ($stream) { $stream.Dispose() }
    }
}
if ($Inventory) {
    @{ timestamp_utc=(Get-Date).ToUniversalTime().ToString('o');
       os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,TotalVisibleMemorySize,FreePhysicalMemory);
       cpu=@(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,ProcessorId);
       memory=@(Get-CimInstance Win32_PhysicalMemory | Select-Object Manufacturer,PartNumber,Capacity,Speed,ConfiguredClockSpeed);
       adapters=@(Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate);
       host_processes=@(Get-Process | Select-Object Id,ProcessName,CPU,PrivateMemorySize64);
       notes='WMI display modes are inventory, not proof of the active presentation display. AdapterRAM intentionally omitted.'
    } | ConvertTo-Json -Depth 9 -Compress
    exit
}
$writer = [IO.StreamWriter]::new($OutputFile, $true, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
    while (-not (Test-Path -LiteralPath $StopFile)) {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $sampleStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $errors = [Collections.Generic.List[string]]::new()
        $privateErrors = [Collections.Generic.List[string]]::new()
        $identities = @()
        try { $identities = Read-IdentitySnapshot -Path $IdentityFile } catch { $errors.Add($_.Exception.Message) }
        $owned = @{}; $requested = @{}
        foreach ($identity in $identities) {
            $requested[[int]$identity.pid] = $identity
            $process = Get-Process -Id $identity.pid -ErrorAction SilentlyContinue
            if ($process) {
                try { if ($process.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [long]$identity.creation_ticks) { $owned[[int]$identity.pid] = $identity } } catch { $privateErrors.Add($_.Exception.Message) }
            }
        }
        $private = @()
        try {
            $private = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $owned.ContainsKey([int]$_.IDProcess) } | ForEach-Object {
                $identity = $owned[[int]$_.IDProcess]
                $process = Get-Process -Id $_.IDProcess -ErrorAction SilentlyContinue
                if ($process -and $process.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [long]$identity.creation_ticks) {
                    @{pid=[int]$_.IDProcess;creation_ticks=$identity.creation_ticks;private_working_set_bytes=[long]$_.WorkingSetPrivate}
                }
            })
        } catch { $privateErrors.Add('Private working set: ' + $_.Exception.Message) }
        $gpuProcess = @(); $gpuAdapter = @(); $gpuEngines = @(); $gpuCandidates = @()
        try {
            $gpuProcess = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -match '^pid_(\d+)_' -and $requested.ContainsKey([int]$Matches[1]) } | ForEach-Object {
                $null = $_.Name -match '^pid_(\d+)_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)'
                $gpuPid = [int]$Matches[1]
                $candidate = @{kind='allocation';instance=$_.Name;pid=$gpuPid;expected_creation_ticks=$requested[$gpuPid].creation_ticks;
                  creation_ticks=$null;identity_verified_at_start=$owned.ContainsKey($gpuPid);
                  luid=([Convert]::ToInt32($Matches[2],16).ToString()+','+[Convert]::ToUInt32($Matches[3],16).ToString());
                  dedicated_bytes=$_.DedicatedUsage;shared_bytes=$_.SharedUsage;committed_bytes=$_.TotalCommitted}
                if ($owned.ContainsKey($gpuPid)) { $candidate.creation_ticks=$owned[$gpuPid].creation_ticks }
                $gpuCandidates += $candidate
                if ($candidate.identity_verified_at_start) {
                    @{instance=$candidate.instance;pid=$gpuPid;creation_ticks=$candidate.creation_ticks;luid=$candidate.luid;
                      dedicated_bytes=$candidate.dedicated_bytes;shared_bytes=$candidate.shared_bytes;committed_bytes=$candidate.committed_bytes}
                }
            })
            $gpuAdapter = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {
                $null = $_.Name -match '^luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)'
                @{instance=$_.Name;luid=([Convert]::ToInt32($Matches[1],16).ToString()+','+[Convert]::ToUInt32($Matches[2],16).ToString());
                  dedicated_bytes=[long]$_.DedicatedUsage;shared_bytes=[long]$_.SharedUsage;committed_bytes=[long]$_.TotalCommitted}
            })
            $gpuEngines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -match '^pid_(\d+)_' -and $requested.ContainsKey([int]$Matches[1]) } | ForEach-Object {
                $null = $_.Name -match '^pid_(\d+)_'
                $gpuPid = [int]$Matches[1]
                $candidate = @{kind='engine';instance=$_.Name;pid=$gpuPid;expected_creation_ticks=$requested[$gpuPid].creation_ticks;
                  creation_ticks=$null;identity_verified_at_start=$owned.ContainsKey($gpuPid);utilization_percent=$_.UtilizationPercentage}
                if ($owned.ContainsKey($gpuPid)) { $candidate.creation_ticks=$owned[$gpuPid].creation_ticks }
                $gpuCandidates += $candidate
                if ($candidate.identity_verified_at_start) {
                    @{instance=$candidate.instance;pid=$gpuPid;creation_ticks=$candidate.creation_ticks;utilization_percent=$candidate.utilization_percent}
                }
            })
        } catch { $errors.Add('GPU: ' + $_.Exception.Message) }
        $system = $null
        try { $system = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableBytes,CommittedBytes,CommitLimit,PagesInputPersec,PagesOutputPersec,PageReadsPersec,PageWritesPersec } catch { $errors.Add($_.Exception.Message) }
        $cpu = @(); $paging = @()
        try { $cpu = @(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object { $_.Name -match '^\d+,\d+$' } | Select-Object Name,PercentProcessorTime,PercentUserTime,PercentPrivilegedTime,PercentIdleTime,ProcessorFrequency,ParkingStatus) } catch { $errors.Add('Per-core CPU: '+$_.Exception.Message) }
        try { $paging = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_PagingFile | Select-Object Name,PercentUsage,PercentUsagePeak) } catch { $errors.Add('Paging file: '+$_.Exception.Message) }
        # Every PID attribution must survive the complete query interval. A PID
        # reused during the slow CIM queries is unavailable, never attributed.
        $stillOwned = @{}
        $attributedGpu = @{}
        foreach ($item in @($gpuProcess) + @($gpuEngines)) { $attributedGpu[[int]$item.pid] = $true }
        foreach ($gpuPid in $owned.Keys) {
            $process = Get-Process -Id $gpuPid -ErrorAction SilentlyContinue
            try {
                if ($process -and $process.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [long]$owned[$gpuPid].creation_ticks) { $stillOwned[$gpuPid]=$true }
                else {
                    $privateErrors.Add('Process identity disappeared during CIM WS diagnostic: '+$gpuPid)
                    if ($attributedGpu.ContainsKey([int]$gpuPid)) { $errors.Add('GPU identity disappeared during full query: '+$gpuPid) }
                }
            } catch {
                $privateErrors.Add('End identity: '+$_.Exception.Message)
                if ($attributedGpu.ContainsKey([int]$gpuPid)) { $errors.Add('GPU end identity: '+$_.Exception.Message) }
            }
        }
        $private = @($private | Where-Object { $stillOwned.ContainsKey([int]$_.pid) })
        $gpuProcess = @($gpuProcess | Where-Object { $stillOwned.ContainsKey([int]$_.pid) })
        $gpuEngines = @($gpuEngines | Where-Object { $stillOwned.ContainsKey([int]$_.pid) })
        foreach ($candidate in $gpuCandidates) {
            $candidate.identity_verified_at_end=$stillOwned.ContainsKey([int]$candidate.pid)
            $positive = if ($candidate.kind -eq 'allocation') {
                $candidate.dedicated_bytes -gt 0 -or $candidate.shared_bytes -gt 0 -or $candidate.committed_bytes -gt 0
            } else { $candidate.utilization_percent -gt 0 }
            if ($positive -and (-not $candidate.identity_verified_at_start -or -not $candidate.identity_verified_at_end)) {
                $errors.Add('Positive owned GPU '+$candidate.kind+' candidate has unproven full-query identity: '+$candidate.pid)
            }
        }
        $writer.WriteLine((@{schema=3;unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();sample_start_unix_ms=$sampleStart;
            timestamp_utc=(Get-Date).ToUniversalTime().ToString('o');private_working_sets=$private;
            gpu_process_allocations_unsummed=$gpuProcess;gpu_adapter_host_totals=$gpuAdapter;owned_gpu_engines=$gpuEngines;
            owned_gpu_candidates=$gpuCandidates;
            system_memory=$system;per_core_cpu=$cpu;paging_file=$paging;
            precision_notes='CIM CPU/pagefile values are integral; zero pagefile PercentUsage does not prove zero occupancy.';
            errors=@($errors);private_ws_diagnostic_errors=@($privateErrors);sampler_ms=$clock.Elapsed.TotalMilliseconds} | ConvertTo-Json -Depth 9 -Compress))
        $remaining = 1000 - $clock.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
    }
} finally { $writer.Dispose() }
