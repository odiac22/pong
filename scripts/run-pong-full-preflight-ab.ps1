[CmdletBinding()]
param(
    [switch]$Apply,
    [ValidateRange(0,1000)][int]$FaceIndex = 0,
    [ValidateRange(256,1920)][int]$MaxEdge = 480,
    [ValidateRange(20,300)][int]$EachTimeoutSeconds = 150
)
$ErrorActionPreference = 'Stop'

$abRepo = Split-Path -Parent $PSScriptRoot
$abSwap = Join-Path $abRepo 'Pong Swap'
$abPython = Join-Path $abSwap 'runtime\venv\Scripts\python.exe'
$abService = Join-Path $abSwap 'pong_swap_service.py'
$abCli = Join-Path $abSwap 'experiment_tiktok_full_preflight_cli.py'
$abPreset = Join-Path $abSwap 'presets\current.json'
$abLogRoot = 'E:\Pong Benchmarks\tiktok-webview-2026-09-29'
foreach ($abPath in @($abPython, $abService, $abCli, $abPreset)) {
    if (!(Test-Path -LiteralPath $abPath -PathType Leaf)) {
        throw "Required local file is missing: $abPath"
    }
}
$abBasePython = (& $abPython -c 'import sys; print(sys._base_executable)').Trim()
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $abBasePython -PathType Leaf)) {
    throw 'Could not resolve the exact venv base Python executable; nothing stopped'
}
$abBasePython = (Resolve-Path -LiteralPath $abBasePython).Path

function Get-AbListener {
    $owners = @(Get-NetTCPConnection -LocalPort 8792 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw 'Expected exactly one ordinary renderer listener; nothing stopped' }
    return Get-CimInstance Win32_Process -Filter "ProcessId=$($owners[0])"
}

function Assert-AbIdentity($process, $expected, [string]$role) {
    if ($null -eq $process) { throw 'Expected renderer process disappeared' }
    $executable = if ($role -eq 'base-child') { $abBasePython } else { $abPython }
    if ($process.Name -ne 'python.exe' -or
        $process.ExecutablePath -ine $executable -or
        !$process.CommandLine.Contains($expected)) {
        throw 'Renderer process identity mismatch; nothing stopped'
    }
}

function Assert-AbSameProcess($snapshot) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($snapshot.ProcessId)"
    if ($null -eq $current -or
        $current.CreationDate -ne $snapshot.CreationDate -or
        $current.CommandLine -cne $snapshot.CommandLine -or
        $current.ExecutablePath -ine $snapshot.ExecutablePath) {
        throw 'Process identity changed; refusing to stop a reused PID'
    }
    return $current
}

function Stop-AbKnownProcess($snapshot) {
    if ($null -eq $snapshot) { return }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($snapshot.ProcessId)"
    if ($null -eq $current) { return }
    $current = Assert-AbSameProcess $snapshot
    Stop-Process -Id $current.ProcessId
}

function Get-AbSettingsJson {
    $settings = Invoke-RestMethod 'http://127.0.0.1:8792/settings' -TimeoutSec 5
    $live = $settings.config | ConvertTo-Json -Depth 80 -Compress
    $baseline = $settings.baselineConfig | ConvertTo-Json -Depth 80 -Compress
    if ($live -cne $baseline) { throw 'Unsaved live settings; nothing stopped' }
    return $live
}

$abOwner = Get-AbListener
Assert-AbIdentity $abOwner $abService 'base-child'
$abParent = Get-CimInstance Win32_Process -Filter "ProcessId=$($abOwner.ParentProcessId)"
Assert-AbIdentity $abParent $abService 'venv-launcher'
if ($abOwner.ParentProcessId -ne $abParent.ProcessId -or
    $abOwner.CreationDate -lt $abParent.CreationDate) {
    throw 'Renderer listener is not the child of the exact venv service launcher'
}
$abOwnerSnapshot = $abOwner
$abParentSnapshot = $abParent
$abSettingsJson = Get-AbSettingsJson
$abSavedHash = (Get-FileHash -LiteralPath $abPreset -Algorithm SHA256).Hash
$abHealth = Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 5
if ($abHealth.exactAcceleration.acceleration.installed -ne $true) {
    throw 'Existing renderer is not running qualified exact acceleration'
}
if (@((Invoke-RestMethod 'http://127.0.0.1:8792/sessions' -TimeoutSec 5).sessions).Count -ne 0) {
    throw 'Renderer still has sessions; nothing stopped'
}
& $abPython -c 'import sys,hashlib,pathlib; sys.path.insert(0,sys.argv[1]); from pong_exact_acceleration import SOURCE_HASHES; root=pathlib.Path(sys.argv[1]); bad=[name for name,digest in SOURCE_HASHES.items() if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest]; print("Frozen-source preflight: "+("matched" if not bad else ", ".join(bad))); sys.exit(bool(bad))' $abSwap
if ($LASTEXITCODE -ne 0) { throw 'Frozen source changed; nothing stopped' }

Write-Output "Verified ordinary renderer PID $($abOwner.ProcessId), parent $($abParent.ProcessId), zero sessions, unchanged saved/live settings, and frozen sources."
Write-Output "A/B will use two fresh Python processes, approved-face index $FaceIndex, max edge $MaxEdge, timeout $EachTimeoutSeconds seconds each."
if (!$Apply) { return }

function Wait-AbPortReleased {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $owners = @(Get-NetTCPConnection -LocalPort 8792 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Port 8792 did not release after stopping the owned renderer'
}

function Stop-AbTrialTree($snapshot) {
    if ($null -eq $snapshot) { return }
    $root = Get-CimInstance Win32_Process -Filter "ProcessId=$($snapshot.ProcessId)"
    if ($null -eq $root) { return }
    $root = Assert-AbSameProcess $snapshot
    # The CLI normally creates no child process. If it does, collect only
    # descendants of this validated process, checking creation times to avoid
    # attaching an unrelated process to a reused ancestor PID.
    $owned = [System.Collections.Generic.List[object]]::new()
    $frontier = @($root)
    while ($frontier.Count -gt 0) {
        $next = [System.Collections.Generic.List[object]]::new()
        foreach ($parent in $frontier) {
            foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.ProcessId)")) {
                if ($child.ParentProcessId -eq $parent.ProcessId -and
                    $child.CreationDate -ge $parent.CreationDate) {
                    $owned.Add($child)
                    $next.Add($child)
                }
            }
        }
        $frontier = $next.ToArray()
    }
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
        $child = $owned[$index]
        $now = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
        if ($now -and $now.ParentProcessId -eq $child.ParentProcessId -and
            $now.CreationDate -eq $child.CreationDate) {
            Stop-Process -Id $now.ProcessId -ErrorAction SilentlyContinue
        }
    }
    Stop-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
}

function Invoke-AbTrial([string]$mode, [string]$directory) {
    $result = Join-Path $directory "$mode.json"
    $stdout = Join-Path $directory "$mode.log"
    $stderr = Join-Path $directory "$mode.err"
    $arguments = '"' + $abCli + '" --mode ' + $mode +
        ' --output "' + $result + '" --face-index ' + $FaceIndex +
        ' --max-edge ' + $MaxEdge
    $process = Start-Process -FilePath $abPython -ArgumentList $arguments -WorkingDirectory $abSwap -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $abTrialProcesses.Add($process) | Out-Null
    $snapshot = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    if ($null -eq $snapshot) {
        if (!$process.WaitForExit($EachTimeoutSeconds * 1000)) {
            # The Process object is the exact handle returned by Start-Process;
            # no unverified PID or unrelated process is targeted.
            Stop-Process -InputObject $process -ErrorAction SilentlyContinue
        }
        throw "The $mode CLI exited before its identity could be verified; inspect scoped logs"
    }
    Assert-AbIdentity $snapshot $abCli 'venv-launcher'
    if (!$process.WaitForExit($EachTimeoutSeconds * 1000)) {
        Stop-AbTrialTree $snapshot
        if (!$process.WaitForExit(5000)) {
            Stop-Process -InputObject $process -ErrorAction SilentlyContinue
        }
        throw "The $mode CLI exceeded its $EachTimeoutSeconds-second limit; only its validated process tree was stopped"
    }
    if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $result -PathType Leaf)) {
        throw "The $mode CLI failed; inspect scoped logs. Exit code: $($process.ExitCode)"
    }
    return Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
}

$abStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$abDirectory = Join-Path $abLogRoot "full-preflight-ab-$abStamp"
New-Item -ItemType Directory -Path $abDirectory -ErrorAction Stop | Out-Null
$abTrialProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$abStopped = $false
$abRestoreError = $null
try {
    # Mark restoration required before the first stop, including partial stop.
    $abStopped = $true
    Stop-AbKnownProcess $abOwnerSnapshot
    Stop-AbKnownProcess $abParentSnapshot
    Wait-AbPortReleased
    $abControl = Invoke-AbTrial 'control' $abDirectory
    $abPreflight = Invoke-AbTrial 'preflight' $abDirectory
    if ($abControl.measured.frameSha256 -cne $abPreflight.measured.frameSha256 -or
        $abControl.measured.embeddingSha256 -cne $abPreflight.measured.embeddingSha256 -or
        $abControl.measured.outputSha256 -cne $abPreflight.measured.outputSha256) {
        throw 'Cold control and preflight output/input hashes differ; reject experiment'
    }
    Write-Output "A/B parity passed. Cold first frame: $($abControl.measured.elapsedMs) ms; after preflight: $($abPreflight.measured.elapsedMs) ms. Reports: $abDirectory"
} finally {
    if ($abStopped) {
        try {
            foreach ($trialProcess in $abTrialProcesses) {
                if (!$trialProcess.HasExited) {
                    Stop-Process -InputObject $trialProcess -ErrorAction SilentlyContinue
                    if (!$trialProcess.WaitForExit(5000)) {
                        throw 'An owned A/B process did not exit; refusing concurrent baseline restart'
                    }
                }
            }
            $listeners = @(Get-NetTCPConnection -LocalPort 8792 -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
            if ($listeners.Count -ne 0) {
                throw 'Port 8792 has an unexpected listener; refusing to start a duplicate renderer'
            }
            $restoreVars = @('PONG_EXACT_ACCELERATION','PONG_MASK_OVERLAP_POLICY',
                'PONG_TIKTOK_SCHEDULER_OBSERVE_ONLY','PONG_TIKTOK_COLD_PRIORITY_ONLY',
                'PONG_TIKTOK_SOURCE_READY_ADMISSION','PONG_TIKTOK_STAGE_DIAGNOSTICS',
                'PONG_TIKTOK_ACQUISITION_TRIAL')
            $previous = @{}
            foreach ($name in $restoreVars) {
                $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
            }
            try {
                $env:PONG_EXACT_ACCELERATION = '1'
                $env:PONG_MASK_OVERLAP_POLICY = 'guarded'
                foreach ($name in $restoreVars[2..($restoreVars.Count-1)]) {
                    [Environment]::SetEnvironmentVariable($name,'0','Process')
                }
                $restoreOut = Join-Path $abDirectory 'ordinary-restored.log'
                $restoreErr = Join-Path $abDirectory 'ordinary-restored.err'
                $restored = Start-Process -FilePath $abPython -ArgumentList ('"' + $abService + '"') -WorkingDirectory $abSwap -WindowStyle Hidden -RedirectStandardOutput $restoreOut -RedirectStandardError $restoreErr -PassThru
            } finally {
                foreach ($name in $restoreVars) {
                    [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')
                }
            }
            $deadline = [DateTime]::UtcNow.AddSeconds(40)
            $restoredHealth = $null
            do {
                try {
                    $restoredHealth = Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 2
                    break
                } catch { Start-Sleep -Milliseconds 300 }
            } while ([DateTime]::UtcNow -lt $deadline)
            if ($null -eq $restoredHealth) { throw 'Ordinary renderer did not become healthy; inspect dedicated restore logs' }
            $restoredListener = Get-AbListener
            Assert-AbIdentity $restoredListener $abService 'base-child'
            $restoredLauncher = Get-CimInstance Win32_Process -Filter "ProcessId=$($restored.Id)"
            Assert-AbIdentity $restoredLauncher $abService 'venv-launcher'
            if ($restoredListener.ParentProcessId -ne $restoredLauncher.ProcessId -or
                $restoredListener.CreationDate -lt $restoredLauncher.CreationDate) {
                throw 'Restored renderer listener is not the child of the owned launch'
            }
            if ((Get-FileHash -LiteralPath $abPreset -Algorithm SHA256).Hash -cne $abSavedHash) {
                throw 'Saved preset hash changed'
            }
            if ((Get-AbSettingsJson) -cne $abSettingsJson) { throw 'Live quality settings changed' }
            if ($restoredHealth.exactAcceleration.acceleration.installed -ne $true) {
                throw 'Restored ordinary renderer lacks exact acceleration'
            }
            Write-Output "Ordinary renderer restored with PID $($restoredListener.ProcessId); saved/live quality and exact acceleration verified. Logs: $abDirectory"
        } catch {
            $abRestoreError = $_
        }
    }
    if ($abRestoreError) { throw "A/B cleanup failed: $($abRestoreError.Exception.Message)" }
}
