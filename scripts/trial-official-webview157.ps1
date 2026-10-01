# Manual-only, emulator-5582 WebView provider trial. Never invoked by a build.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Apply','Rollback')][string]$Mode)
$ErrorActionPreference = 'Stop'
$serial = 'emulator-5582'
$avdName = 'pong_receiver_audit_api35'
$trialDir = 'E:\Pong Benchmarks\tiktok-webview-2026-09-29\webview-157-trial'
$manifestPath = Join-Path $trialDir 'artifact.json'
$apkPath = Join-Path $trialDir 'SystemWebView.apk'
$statePath = Join-Path $trialDir 'trial-state.json'
$adbExe = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'

function Invoke-TargetAdb {
    param([string[]]$CommandArgs, [int]$TimeoutSeconds = 20)
    if (-not (Test-Path -LiteralPath $adbExe)) { throw 'Android SDK adb.exe missing.' }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $adbExe
    $all = @('-s', $serial) + $CommandArgs
    # All arguments are fixed locally or strictly validated snapshot names.
    $start.Arguments = (($all | ForEach-Object { '"' + ($_ -replace '"','\"') + '"' }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'adb did not start.' }
        # Drain both pipes concurrently; dumpsys can exceed an OS pipe buffer.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill() # Only the adb CLI for this exact operation, never emulator/app processes.
            throw 'Timed out waiting for target adb operation.'
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or $stdout -match '(?m)^KO\b' -or $stderr -match '(?m)^KO\b') {
            throw ('Target adb operation failed (exit {0}).' -f $process.ExitCode)
        }
        return $stdout
    } finally { $process.Dispose() }
}

function Assert-TargetAvd {
    $state = (Invoke-TargetAdb @('get-state')).Trim()
    if ($state -ne 'device') { throw 'Named emulator is not online.' }
    $reported = @((Invoke-TargetAdb @('emu','avd','name')) -split "`n" | ForEach-Object { $_.Trim() })
    if ($reported -notcontains $avdName) { throw 'Serial does not map to the dedicated audit AVD.' }
    $boot = (Invoke-TargetAdb @('shell','getprop','sys.boot_completed')).Trim()
    $sdk = (Invoke-TargetAdb @('shell','getprop','ro.build.version.sdk')).Trim()
    $abi = (Invoke-TargetAdb @('shell','getprop','ro.product.cpu.abi')).Trim()
    if ($boot -ne '1' -or $sdk -ne '35' -or $abi -ne 'x86_64') {
        throw 'Named emulator is not fully booted Android 15 x86_64.'
    }
}

function Assert-IdleRenderer {
    $health = Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 5
    $sessions = Invoke-RestMethod 'http://127.0.0.1:8792/sessions' -TimeoutSec 5
    $activeStates = @($sessions.sessions | Where-Object {
        $_ -ne $null -and $_.state -in @('created','starting','streaming','stopping')
    })
    if ($health.ready -ne $true -or [int]$health.activeSessions -ne 0 -or
        $activeStates.Count -ne 0) {
        throw 'Renderer has active sessions or is not ready.'
    }
}

function Get-SelectedProvider {
    $report = Invoke-TargetAdb @('shell','dumpsys','webviewupdate')
    $line = @($report -split "`r?`n" | Where-Object { $_ -match 'Current WebView package' })
    if ($line.Count -ne 1) { throw 'Current WebView provider was not reported exactly once.' }
    if ($line[0] -notmatch 'Current WebView package \(name, version\): \((com\.[A-Za-z0-9_.]+),') {
        throw 'Current WebView provider cannot be parsed safely.'
    }
    return $Matches[1]
}

function Assert-SnapshotExists([string]$Name) {
    if ($Name -notmatch '^pong-webview157-before-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$') {
        throw 'Snapshot name is not an owned trial name.'
    }
    $listing = Invoke-TargetAdb @('emu','avd','snapshot','list') -TimeoutSeconds 30
    if (-not (@($listing -split "`r?`n" | Where-Object { $_ -match ('(?<![A-Za-z0-9_-])' + [regex]::Escape($Name) + '(?![A-Za-z0-9_-])') }).Count)) {
        throw 'Named rollback snapshot is absent from this AVD.'
    }
}

function Save-TrialState([psobject]$State) {
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Restore-TrialSnapshot([string]$Name) {
    Assert-TargetAvd
    Assert-SnapshotExists $Name
    $null = Invoke-TargetAdb @('emu','avd','snapshot','load',$Name) -TimeoutSeconds 120
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        Start-Sleep -Seconds 2
        try { Assert-TargetAvd; return }
        catch { if ([DateTime]::UtcNow -ge $deadline) { throw 'Snapshot load did not return the named AVD online.' } }
    } while ($true)
}

if (-not (Test-Path -LiteralPath $trialDir -PathType Container)) { throw 'Trial directory is missing.' }
Assert-TargetAvd
Assert-IdleRenderer

if ($Mode -eq 'Rollback') {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'No saved trial state; no snapshot was loaded.' }
    $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($saved.serial -cne $serial -or $saved.avd -cne $avdName -or
        $saved.status -notin @('snapshot-ready','applied','restore-failed')) {
        throw 'Trial state does not authorize rollback of this named AVD.'
    }
    Restore-TrialSnapshot $saved.snapshot
    $restored = Get-SelectedProvider
    if ($restored -cne $saved.originalProvider) { throw 'Snapshot loaded, but original WebView provider did not return.' }
    $saved.status = 'rolled-back'
    $saved.rolledBackUtc = [DateTime]::UtcNow.ToString('o')
    Save-TrialState $saved
    Write-Output 'Named AVD snapshot restored; original WebView provider verified. Pong 2 data returned to snapshot state.'
    return
}

if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $prior = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($prior.status -ne 'rolled-back') { throw 'An unrolled trial state already exists; use Rollback first.' }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.source.snapshotRevision -ne 1707869 -or
    $manifest.apk.packageName -cne 'com.android.webview' -or
    $manifest.apk.versionName -cne '157.0.8080.0' -or
    $manifest.apk.sha256 -cne '55d8f1feb690ab4210da5d973e550c8b94f05662bd4244b206aceeb51425dbf6') {
    throw 'Official allowlisted artifact manifest differs from the verified trial.'
}
$apk = Get-Item -LiteralPath $apkPath
if ($apk.Length -ne [long]$manifest.apk.sizeBytes -or
    (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.apk.sha256) {
    throw 'Official APK size/hash verification failed.'
}
$freeE = [System.IO.DriveInfo]::new('E:\').AvailableFreeSpace
if ($freeE -lt 2GB) { throw 'E: needs at least 2 GiB free for this trial and logs.' }
$avdRoot = if ($env:ANDROID_AVD_HOME) { $env:ANDROID_AVD_HOME }
           else { Join-Path $env:USERPROFILE '.android\avd' }
$avdFolder = Join-Path $avdRoot ($avdName + '.avd')
if (-not (Test-Path -LiteralPath $avdFolder -PathType Container)) {
    $avdPointer = Join-Path $avdRoot ($avdName + '.ini')
    $pathLines = @(Get-Content -LiteralPath $avdPointer | Where-Object { $_ -cmatch '^path=' })
    if ($pathLines.Count -ne 1) { throw 'Named AVD storage pointer is ambiguous.' }
    $avdFolder = [System.IO.Path]::GetFullPath($pathLines[0].Substring(5))
    if ($avdFolder -ine 'E:\Pong Benchmarks\v3038-detect\pong_receiver_audit_api35.avd') {
        throw 'Named AVD storage pointer differs from the verified audit location.'
    }
}
if (-not (Test-Path -LiteralPath $avdFolder -PathType Container)) { throw 'Named AVD storage is missing.' }
$avdDrive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($avdFolder))
if ($avdDrive.AvailableFreeSpace -lt 2GB) { throw 'AVD storage drive needs at least 2 GiB free for snapshot rollback.' }
$original = Get-SelectedProvider
if ($original -cne 'com.google.android.webview') { throw 'Expected original Google WebView provider is not selected.' }
$pongPath = Invoke-TargetAdb @('shell','pm','path','com.odiac22.pong2')
if ($pongPath -notmatch '(?m)^package:') { throw 'Pong 2 is not installed on the named audit AVD.' }
# Only Pong 2 is stopped. No other package, AVD, service, or phone is touched.
$null = Invoke-TargetAdb @('shell','am','force-stop','com.odiac22.pong2')
$snapshot = 'pong-webview157-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' +
    ([guid]::NewGuid().ToString('N').Substring(0,8))
$null = Invoke-TargetAdb @('emu','avd','snapshot','save',$snapshot) -TimeoutSeconds 120
Assert-SnapshotExists $snapshot
$trialState = [pscustomobject]@{
    status = 'snapshot-ready'; serial = $serial; avd = $avdName
    snapshot = $snapshot; originalProvider = $original
    targetProvider = 'com.android.webview'; apkSha256 = $manifest.apk.sha256
    createdUtc = [DateTime]::UtcNow.ToString('o')
    appliedUtc = $null; rolledBackUtc = $null
}
Save-TrialState $trialState
try {
    $installOutput = Invoke-TargetAdb @('install','-r', $apkPath) -TimeoutSeconds 180
    if ($installOutput -notmatch '(?m)^Success\s*$') { throw 'Official APK install did not report success.' }
    $selectOutput = Invoke-TargetAdb @('shell','cmd','webviewupdate',
        'set-webview-implementation','com.android.webview') -TimeoutSeconds 30
    if ($selectOutput -notmatch '(?m)^Success\s*$' -or
        (Get-SelectedProvider) -cne 'com.android.webview') {
        throw 'Official WebView provider was not selected.'
    }
    $trialState.status = 'applied'
    $trialState.appliedUtc = [DateTime]::UtcNow.ToString('o')
    Save-TrialState $trialState
    Write-Output 'Official WebView 157 selected on emulator-5582 only. Snapshot state saved; use Rollback mode after the trial.'
} catch {
    $failure = $_.Exception.Message
    try {
        Restore-TrialSnapshot $snapshot
        if ((Get-SelectedProvider) -cne $original) { throw 'Original provider verification failed after restore.' }
        $trialState.status = 'rolled-back'
        $trialState.rolledBackUtc = [DateTime]::UtcNow.ToString('o')
        Save-TrialState $trialState
        throw ('Apply failed and snapshot was restored: ' + $failure)
    } catch {
        if ($trialState.status -ne 'rolled-back') {
            $trialState.status = 'restore-failed'; Save-TrialState $trialState
            throw ('Apply failed; automatic snapshot restore needs manual attention: ' + $failure)
        }
        throw
    }
}
