# Manual activation only. Restarts the TikTok sidecar, not Pong or its renderer.
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$remoteRepo=Split-Path -Parent $PSScriptRoot
$remoteVersionSource=Get-Content -Raw -LiteralPath (Join-Path $remoteRepo 'scripts\tiktok_remote\core.py')
if($remoteVersionSource -notmatch '(?m)^VERSION = "([0-9.]+)"'){throw 'Cannot determine the staged TikTok service version. Nothing was stopped.'}
$remoteExpectedVersion=$Matches[1]
$remotePython=Join-Path $remoteRepo 'Pong Swap\runtime\venv\Scripts\python.exe'
$remoteDiscoveryRoot=Join-Path $env:LOCALAPPDATA 'Temp\avd\running'
$remoteDiscovery=@(Get-ChildItem -LiteralPath $remoteDiscoveryRoot -Filter '*.ini' | Where-Object {
    $remoteIni=Get-Content -Raw -LiteralPath $_.FullName
    $remoteIni -match '(?m)^port.serial=5580\r?$' -and
    $remoteIni -match '(?m)^grpc.port=8556\r?$' -and
    $remoteIni -match '(?m)^grpc.token=\S+' -and $remoteIni.Contains('-no-audio') -and $remoteIni.Contains('-no-window')
})
if($remoteDiscovery.Count -ne 1){throw 'The silent TikTok source emulator must be running first. Nothing was stopped.'}
$remoteIds=@(Get-NetTCPConnection -LocalPort 8820 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if($remoteIds.Count -ne 1){throw 'Expected one TikTok service on 8820. Nothing was stopped.'}
$remoteOld=Get-CimInstance Win32_Process -Filter "ProcessId=$($remoteIds[0])"
if(-not $remoteOld.CommandLine){throw 'Run this command in Administrator PowerShell so the existing administrator-owned TikTok service can be verified. Nothing was stopped.'}
if($remoteOld.CommandLine -notmatch 'scripts[/\\]tiktok_remote[/\\]server.py'){throw 'Unknown service on 8820. Nothing was stopped.'}
$remoteKey=(Get-Content -Raw -LiteralPath (Join-Path $remoteRepo 'Pong Swap\cache\tiktok-remote-pairing-token')).Trim()
$remoteHeaders=@{Authorization=('Bearer '+$remoteKey)}
$remoteStatus=Invoke-RestMethod 'http://127.0.0.1:8820/status' -Headers $remoteHeaders -TimeoutSec 3
if(@($remoteStatus.sessions | Where-Object {$_.connection -notin @('closed','failed')}).Count){throw 'Close TikTok Remote in Pong first. Nothing was stopped.'}
if($CheckOnly){Write-Output 'TikTok-only activation preflight passed. Renderer and quality settings will remain unchanged.';return}
$remoteCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$($remoteOld.ProcessId)"
if($remoteCurrent.CreationDate -ne $remoteOld.CreationDate -or $remoteCurrent.CommandLine -cne $remoteOld.CommandLine){throw 'Service ownership changed. Nothing was stopped.'}
$remoteLogDir=Join-Path $remoteRepo 'Pong Swap\logs'
$remoteOldPath=$env:PYTHONPATH
try {
    Stop-Process -Id $remoteOld.ProcessId -ErrorAction Stop
    $env:PYTHONPATH='E:\Pong Benchmarks\tiktok-remote\deps'
    $remoteArgs=@('scripts/tiktok_remote/server.py','--bindings','"E:\Pong Benchmarks\tiktok-remote\bindings"',
        '--emulator-discovery',('"'+$remoteDiscovery[0].FullName+'"'),
        '--pairing-token-file','"Pong Swap\cache\tiktok-remote-pairing-token"',
        '--renderer-token-file','"Pong Swap\cache\remote-bridge-token"')
    $remoteNew=Start-Process -FilePath $remotePython -ArgumentList $remoteArgs -WorkingDirectory $remoteRepo -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $remoteLogDir 'tiktok-integrated.log') -RedirectStandardError (Join-Path $remoteLogDir 'tiktok-integrated.err')
    $remoteDeadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 400
        try {
            $remoteNewStatus=Invoke-RestMethod 'http://127.0.0.1:8820/status' -Headers $remoteHeaders -TimeoutSec 2
            if($remoteNewStatus.automaticVideoRegion -eq $true -and $remoteNewStatus.version -eq $remoteExpectedVersion){Write-Output "TikTok Remote $($remoteNewStatus.version) is ready. Pong renderer and saved quality unchanged.";return}
        } catch {}
    } while([DateTime]::UtcNow -lt $remoteDeadline)
    throw 'TikTok sidecar did not become ready. Send this output; do not stop other services.'
} finally { $env:PYTHONPATH=$remoteOldPath }
