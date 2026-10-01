# Manual activation handoff. The agent must not execute the restart path.
# Does not alter presets, execution policy, scheduled tasks, or emulator flags.
[CmdletBinding()]
param([switch]$CheckOnly, [ValidateSet('Both','Helper')][string]$Component = 'Both')
$ErrorActionPreference = 'Stop'
$activationRepo = Split-Path -Parent $PSScriptRoot
$activationSwap = Join-Path $activationRepo 'Pong Swap'
$activationPython = Join-Path $activationSwap 'runtime\venv\Scripts\python.exe'
$activationService = Join-Path $activationSwap 'pong_swap_service.py'
$activationPreset = Join-Path $activationSwap 'presets\current.json'
$activationNodeSource = Join-Path $activationRepo 'local-ai-server.mjs'
$activationLogDir = Join-Path $activationSwap 'logs'

function Get-ActivationListener([int]$Port, [int]$WaitSeconds = 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    do {
        $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -gt 1) { throw "Multiple service owners on port $Port. No process will be stopped." }
        if ($owners.Count -eq 1) {
            $listener = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
            if ($listener) { return $listener }
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 500
    } while ($true)
    throw "Service on port $Port did not finish starting. No further process will be stopped; send this output to the assistant."
}

function Stop-VerifiedActivationProcess($RecordedProcess) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($RecordedProcess.ProcessId)"
    if (-not $current) { return }
    if ($current.CreationDate -ne $RecordedProcess.CreationDate -or
        $current.CommandLine -cne $RecordedProcess.CommandLine) {
        throw 'Process identity changed. Restart stopped; no replacement process was terminated.'
    }
    Stop-Process -Id $current.ProcessId -ErrorAction Stop
}

function Wait-ActivationHttp([string]$Url, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try { return Invoke-RestMethod -Uri $Url -TimeoutSec 3 } catch { Start-Sleep -Milliseconds 500 }
    }
    throw "Service did not become ready at $Url. Leave logs intact and send this error to the assistant."
}

function Test-ActivationWatchdogProcess($Process, [string]$ExpectedPath) {
    if (-not $Process -or $Process.Name -notin @('powershell.exe','pwsh.exe') -or
        -not $Process.CommandLine) { return $false }
    $absolute = [regex]::Escape($ExpectedPath)
    $relative = '([.]?[\\/])?scripts[\\/]run-pong-server-watchdog[.]ps1'
    return $Process.CommandLine -match "(?i)(?:^|\s)-File\s+`"?(?:$absolute|$relative)`"?(?=\s|$)"
}

function Wait-ActivationRendererViaHelper([string]$ServicePath) {
    # The helper owns renderer startup. Its proxy shares an in-flight launch,
    # so a second direct python.exe process cannot race for port 8792.
    $null = Wait-ActivationHttp 'http://127.0.0.1:8787/pong-swap/health' -Seconds 90
    $listener = Get-ActivationListener 8792 -WaitSeconds 15
    if ($listener.Name -ne 'python.exe' -or -not $listener.CommandLine.Contains($ServicePath)) {
        throw 'Port 8792 is not the expected Pong renderer after helper startup. No process will be stopped.'
    }
    return $listener
}

foreach ($requiredPath in @($activationPython, $activationService, $activationPreset, $activationNodeSource, $activationLogDir)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required path missing: $requiredPath" }
}
$activationNode = (Get-Command node.exe -ErrorAction Stop).Source
$activationHelper = Get-ActivationListener 8787
$activationRenderer = Get-ActivationListener 8792
$activationHelperParent = Get-CimInstance Win32_Process -Filter "ProcessId = $($activationHelper.ParentProcessId)"
$activationWatchdogPath = Join-Path $PSScriptRoot 'run-pong-server-watchdog.ps1'
$activationWatchdogOwned = Test-ActivationWatchdogProcess $activationHelperParent $activationWatchdogPath
if (-not $activationWatchdogOwned) {
    $activationWatchdogOwned = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
        Where-Object { Test-ActivationWatchdogProcess $_ $activationWatchdogPath }).Count -gt 0
}
if ($activationHelper.Name -ne 'node.exe' -or $activationHelper.CommandLine -notmatch 'local-ai-server\.mjs') {
    throw 'Port 8787 is not the expected Pong helper. Nothing stopped.'
}
if ($activationRenderer.Name -ne 'python.exe' -or
    -not $activationRenderer.CommandLine.Contains($activationService)) {
    throw 'Port 8792 is not the expected Pong renderer. Nothing stopped.'
}
$activationParent = Get-CimInstance Win32_Process -Filter "ProcessId = $($activationRenderer.ParentProcessId)"
$activationOwnedParent = $null
if ($activationParent -and $activationParent.Name -eq 'python.exe' -and
    $activationParent.CommandLine.Contains($activationService) -and
    $activationParent.ExecutablePath -ieq $activationPython) {
    $activationOwnedParent = $activationParent
}
$activationSettings = Invoke-RestMethod 'http://127.0.0.1:8792/settings' -TimeoutSec 8
$activationConfigJson = $activationSettings.config | ConvertTo-Json -Depth 80 -Compress
if ($activationConfigJson -cne ($activationSettings.baselineConfig | ConvertTo-Json -Depth 80 -Compress)) {
    throw 'Live quality differs from the saved baseline. Nothing stopped; ask the assistant to preserve the live settings first.'
}
$activationPresetHash = (Get-FileHash -LiteralPath $activationPreset -Algorithm SHA256).Hash
$activationSessions = @( (Invoke-RestMethod 'http://127.0.0.1:8792/sessions' -TimeoutSec 5).sessions )
if (@($activationSessions | Where-Object { -not $_.complete -and $_.playbackPaused -ne $true }).Count -gt 0) {
    throw 'Pong has an unpaused rendering session. Pause playback and try again; nothing stopped.'
}
$activationVersion = (Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 5).serviceVersion
if ($Component -eq 'Both') {
    Push-Location $activationSwap
    try {
        & $activationPython -m unittest test_pong_exact_acceleration.ExactAccelerationTests.test_release_sources_match_reviewed_qualification
        if ($LASTEXITCODE -ne 0) { throw 'Exact acceleration sources are not qualified. Nothing stopped.' }
        & $activationPython 'pong_exact_runtime\build_frozen.py' --check | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Frozen renderer methods are stale. Nothing stopped.' }
    } finally { Pop-Location }
}
Write-Output "Preflight passed. Renderer $activationVersion; saved quality matches live quality."
if ($Component -eq 'Helper') {
    Write-Output 'Helper-only activation briefly interrupts Recall. No explicit renderer restart is requested, but its owner may restart it automatically. Emulators and saved quality are not changed.'
} else {
    Write-Output 'Activation briefly interrupts Pong and clears paused in-memory render sessions. Videos and approved faces are not deleted.'
}
if ($CheckOnly) { Write-Output 'Check only: no processes stopped or started.'; return }

# End only the exact validated helper. Its existing watchdog may restart it.
Stop-VerifiedActivationProcess $activationHelper
$activationHelperDeadline = [DateTime]::UtcNow.AddSeconds($(if ($activationWatchdogOwned) { 60 } else { 12 }))
do {
    $activationNewListener = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
    if ($activationNewListener.Count -gt 0) { break }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $activationHelperDeadline)
if ($activationNewListener.Count -eq 0) {
    # The helper may have exited before its watchdog parent could be identified.
    # An active validated watchdog still owns the replacement path.
    if (-not $activationWatchdogOwned) {
        $activationWatchdogOwned = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
            Where-Object { Test-ActivationWatchdogProcess $_ $activationWatchdogPath }).Count -gt 0
        if ($activationWatchdogOwned) {
            $null = Get-ActivationListener 8787 -WaitSeconds 48
            $activationNewListener = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
        }
    }
    if ($activationWatchdogOwned) {
        $activationNewListener = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
        if ($activationNewListener.Count -eq 0) {
            throw 'The existing watchdog has not made the helper ready yet. No duplicate helper was launched. Send this output to the assistant.'
        }
    } else {
        Start-Process -FilePath $activationNode -ArgumentList ('"' + $activationNodeSource + '"') `
            -WorkingDirectory $activationRepo -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $activationLogDir 'activation-helper-stdout.log') `
            -RedirectStandardError (Join-Path $activationLogDir 'activation-helper-stderr.log') | Out-Null
    }
}
$null = Wait-ActivationHttp 'http://127.0.0.1:8787/pong-tiktok-remote.html'
Write-Output 'Updated Pong helper is responding; TikTok panel route is available.'

if ($Component -eq 'Helper') {
    $activationRendererAfter = Get-ActivationListener 8792 -WaitSeconds 45
    if ($activationRendererAfter.Name -ne 'python.exe' -or
        -not $activationRendererAfter.CommandLine.Contains($activationService)) {
        throw 'Port 8792 is not the expected renderer after reload. No process will be stopped.'
    }
    $activationHealthAfter = Wait-ActivationHttp 'http://127.0.0.1:8792/health'
    $activationSettingsAfter = Invoke-RestMethod 'http://127.0.0.1:8792/settings' -TimeoutSec 8
    if ($activationHealthAfter.serviceVersion -ne $activationVersion -or
        $activationConfigJson -cne ($activationSettingsAfter.config | ConvertTo-Json -Depth 80 -Compress) -or
        $activationPresetHash -ne (Get-FileHash -LiteralPath $activationPreset -Algorithm SHA256).Hash) {
        throw 'Renderer version or quality changed unexpectedly. No further action will be taken; send this output to the assistant.'
    }
    if ($activationRendererAfter.ProcessId -ne $activationRenderer.ProcessId -or
        $activationRendererAfter.CreationDate -ne $activationRenderer.CreationDate) {
        Write-Output 'The renderer was automatically replaced during helper reload; expected renderer version and unchanged quality verified.'
    }
    Write-Output "Helper-only activation complete. Renderer ready: $($activationHealthAfter.ready). Quality unchanged. Send this output to the assistant for receipt testing."
    return
}

Stop-VerifiedActivationProcess $activationRenderer
if ($activationOwnedParent) { Stop-VerifiedActivationProcess $activationOwnedParent }
$null = Wait-ActivationRendererViaHelper $activationService
$activationHealth = Wait-ActivationHttp 'http://127.0.0.1:8792/health'
if ($activationHealth.serviceVersion -ne '30.38') { throw 'Renderer is not 30.38. Send this error; do not keep restarting.' }
$activationAfter = Invoke-RestMethod 'http://127.0.0.1:8792/settings' -TimeoutSec 8
if ($activationConfigJson -cne ($activationAfter.config | ConvertTo-Json -Depth 80 -Compress) -or
    $activationPresetHash -ne (Get-FileHash -LiteralPath $activationPreset -Algorithm SHA256).Hash) {
    throw 'Quality verification differs after restart. No settings were written by this script. Stop testing and report this.'
}
$null = Invoke-RestMethod 'http://127.0.0.1:8792/detection-learning' -TimeoutSec 8
Write-Output 'Renderer 30.38 active. Quality unchanged. Detection calibration route available.'
Write-Output 'Warming the existing models (no media or audio playback)...'
$null = Invoke-RestMethod 'http://127.0.0.1:8792/warm' -Method Post -TimeoutSec 180
$activationHealth = Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 5
if (-not $activationHealth.ready) { throw 'Warmup returned but renderer is not ready. Send this output.' }
$activationExact = $activationHealth.exactAcceleration
if ($activationExact.acceleration) { $activationExact = $activationExact.acceleration }
if ($activationExact.installed -ne $true) {
    throw "Renderer is ready but exact acceleration is NOT installed ($($activationExact.reason)). Performance qualification failed; do not report activation successful."
}
Write-Output 'Exact acceleration installed and qualified.'
Write-Output 'Activation complete. Renderer ready. Refresh Pong once; send this output to the assistant.'
