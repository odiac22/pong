# Manual handoff only: the agent's service-launch attempts were denied.
# Does not restart/stop production, alter presets, launch a visible window,
# change execution policy, or expose the emulator control port to the LAN.
param([ValidateSet('Recall','Remote','Both')][string]$Component='Both')
$ErrorActionPreference='Stop'
$auditRepo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$auditOutput='E:\Pong Benchmarks\v3037-flow-audit'
$auditSnapshot=Join-Path $auditOutput 'server'
$auditPython=Join-Path $auditRepo 'Pong Swap\runtime\venv\Scripts\python.exe'
function Assert-FreeAuditPort([int]$Port) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is already in use. Nothing was stopped."
    }
}
if ($Component -in @('Recall','Both')) {
    if (-not (Test-Path -LiteralPath (Join-Path $auditSnapshot 'local-ai-server.mjs'))) { throw 'Audit snapshot is missing' }
    foreach ($auditPort in @(17929,17933,17935)) { Assert-FreeAuditPort $auditPort }
}
if ($Component -in @('Remote','Both')) {
    Assert-FreeAuditPort 8820
    $auditDiscovery='C:\Users\arian\AppData\Local\Temp\avd\running\pid_112024.ini'
    if (-not (Test-Path -LiteralPath $auditDiscovery)) { throw 'The recorded emulator is no longer running. Request a fresh discovery path.' }
    $auditDiscoveryText=Get-Content -Raw -LiteralPath $auditDiscovery
    foreach ($requiredFlag in @('-grpc-use-token','-no-window','-no-audio')) {
        if (-not $auditDiscoveryText.Contains($requiredFlag)) { throw "Emulator is missing required flag $requiredFlag" }
    }
}
$auditVariables=@('PONG_LOCAL_AI_HOST','PONG_LOCAL_AI_PORT','PONG_SWAP_CONTROL_PORT','PONG_SWAP_BACKGROUND_CONTROL_PORT','PONG_VIDEO_FILE_CACHE_DIR','PYTHONPATH')
$auditSavedEnvironment=@{}
foreach ($auditName in $auditVariables) { $auditSavedEnvironment[$auditName]=[Environment]::GetEnvironmentVariable($auditName,'Process') }
try {
    if ($Component -in @('Recall','Both')) {
        $env:PONG_LOCAL_AI_HOST='127.0.0.1'
        $env:PONG_LOCAL_AI_PORT='17929'
        $env:PONG_SWAP_CONTROL_PORT='17933'
        $env:PONG_SWAP_BACKGROUND_CONTROL_PORT='17935'
        $env:PONG_VIDEO_FILE_CACHE_DIR='F:\Pong-Audit-v3037\.pong-ephemeral-video-cache'
        $auditProcess=Start-Process -FilePath (Get-Command node).Source -ArgumentList 'local-ai-server.mjs' -WorkingDirectory $auditSnapshot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $auditOutput 'manual-recall.log') -RedirectStandardError (Join-Path $auditOutput 'manual-recall.err') -PassThru
        Write-Output "Isolated Recall helper start requested, PID $($auditProcess.Id). Verify health before testing."
    }
    if ($Component -in @('Remote','Both')) {
        & $auditPython (Join-Path $auditRepo 'scripts\tiktok_remote\prepare_runtime.py')
        if ($LASTEXITCODE -ne 0) { throw 'Pairing setup failed' }
        $env:PYTHONPATH='E:\Pong Benchmarks\tiktok-remote\deps'
        $auditRemoteArguments=@('scripts/tiktok_remote/server.py','--bindings','"E:\Pong Benchmarks\tiktok-remote\bindings"','--emulator-discovery',('"'+$auditDiscovery+'"'),'--pairing-token-file','"Pong Swap\cache\tiktok-remote-pairing-token"','--renderer-token-file','"Pong Swap\cache\remote-bridge-token"')
        $auditRemote=Start-Process -FilePath $auditPython -ArgumentList $auditRemoteArguments -WorkingDirectory $auditRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $auditOutput 'manual-remote.log') -RedirectStandardError (Join-Path $auditOutput 'manual-remote.err') -PassThru
        Write-Output "TikTok Remote start requested, PID $($auditRemote.Id). Keys remain private; no key values printed."
    }
} finally {
    foreach ($auditName in $auditVariables) { [Environment]::SetEnvironmentVariable($auditName,$auditSavedEnvironment[$auditName],'Process') }
}
