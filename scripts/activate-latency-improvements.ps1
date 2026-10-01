[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$latencyRepo=Split-Path -Parent $PSScriptRoot
$latencySwap=Join-Path $latencyRepo 'Pong Swap'
$latencyService=Join-Path $latencySwap 'pong_swap_service.py'
$latencyPython=Join-Path $latencySwap 'runtime\venv\Scripts\python.exe'
$latencyWatchdogPath=Join-Path $PSScriptRoot 'run-pong-server-watchdog.ps1'
function Listener([int]$Port) {
  $owners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  if($owners.Count -ne 1){throw "Expected exactly one listener on $Port; no broad process cleanup permitted."}
  Get-CimInstance Win32_Process -Filter "ProcessId=$($owners[0])"
}
function Stop-Recorded($Recorded) {
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Recorded.ProcessId)"
  if(-not $current){return}
  if($current.CreationDate -ne $Recorded.CreationDate -or $current.CommandLine -cne $Recorded.CommandLine){throw 'Process identity changed; no replacement stopped.'}
  Stop-Process -Id $Recorded.ProcessId
}
$latencyHelper=Listener 8787
if($latencyHelper.Name -ne 'node.exe' -or -not $latencyHelper.CommandLine.Contains((Join-Path $latencyRepo 'local-ai-server.mjs'))){throw 'Helper ownership mismatch.'}
$latencyWatchdog=Get-CimInstance Win32_Process -Filter "ProcessId=$($latencyHelper.ParentProcessId)"
if($latencyWatchdog.Name -notin @('powershell.exe','pwsh.exe') -or
  $latencyWatchdog.CommandLine -notmatch '(?i)-File\s+"?(?:[^"\r\n]*[\\/])?scripts[\\/]run-pong-server-watchdog[.]ps1"?(?:\s|$)'){throw 'Expected the known Pong watchdog parent.'}
$latencyRenderer=Listener 8792
$latencyRendererParent=Get-CimInstance Win32_Process -Filter "ProcessId=$($latencyRenderer.ParentProcessId)"
$latencyAbsolute=$latencyRenderer.CommandLine.Contains($latencyService)
$latencyRelativeOwned=$latencyRendererParent.ExecutablePath -ieq $latencyPython -and
  $latencyRendererParent.CommandLine -match '(?:^|\s)pong_swap_service[.]py\s*$' -and
  $latencyRenderer.CommandLine -match '(?:^|\s)pong_swap_service[.]py\s*$'
if($latencyRenderer.Name -ne 'python.exe' -or (-not $latencyAbsolute -and -not $latencyRelativeOwned)){throw 'Renderer ownership mismatch.'}
$latencySettings=(Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 80 -Compress
$latencyPresetHash=(Get-FileHash -LiteralPath (Join-Path $latencySwap 'presets\current.json')).Hash
$latencyFaces=@((Invoke-RestMethod 'http://127.0.0.1:8792/faces').faces).Count
$latencySessions=@((Invoke-RestMethod 'http://127.0.0.1:8792/sessions').sessions)
if(@($latencySessions | Where-Object {-not $_.complete -and $_.playbackPaused -ne $true}).Count){throw 'An active render is playing; nothing restarted.'}
Push-Location $latencySwap
try {
  & $latencyPython -m unittest test_pong_activity_warmth test_pong_exact_acceleration.ExactAccelerationTests.test_release_sources_match_reviewed_qualification
  if($LASTEXITCODE){throw 'Renderer preflight failed.'}
  & $latencyPython 'pong_exact_runtime\build_frozen.py' --check | Out-Null
  if($LASTEXITCODE){throw 'Frozen runtime is stale.'}
} finally {Pop-Location}
Write-Output 'Preflight passed: validated process identities, idle renderer, frozen quality unchanged.'
if($CheckOnly){return}
Push-Location $latencyRepo
try {$latencySnapshot=(& node 'scripts/snapshot-idle-recall.mjs' | ConvertFrom-Json);if($LASTEXITCODE){throw 'Idle Recall snapshot failed.'}}
finally {Pop-Location}
# Stop only the verified supervisor and helper, then the verified renderer.
Stop-Recorded $latencyWatchdog
Stop-Recorded $latencyHelper
Stop-Recorded $latencyRenderer
if($latencyRendererParent.ExecutablePath -ieq $latencyPython -and
 ($latencyRelativeOwned -or $latencyRendererParent.CommandLine.Contains($latencyService))){Stop-Recorded $latencyRendererParent}
$latencyArgs=@('-NoProfile','-File',('"'+$latencyWatchdogPath+'"'),'-RecallRestoreFile',('"'+$latencySnapshot.file+'"'))
Start-Process -FilePath 'powershell.exe' -ArgumentList $latencyArgs -WorkingDirectory $latencyRepo -WindowStyle Hidden | Out-Null
$latencyDeadline=[DateTime]::UtcNow.AddSeconds(120)
$latencyHealthy=$false
do {
  try {
    $latencyHealth=Invoke-RestMethod 'http://127.0.0.1:8787/pong-swap/health' -TimeoutSec 3
    $latencyHealthy=$latencyHealth.serviceVersion -eq '30.38.6' -and $latencyHealth.ready
  } catch {}
  if(-not $latencyHealthy){Start-Sleep -Milliseconds 500}
} while(-not $latencyHealthy -and [DateTime]::UtcNow -lt $latencyDeadline)
if(-not $latencyHealthy){throw 'Restart did not qualify; preserve logs, do not repeatedly restart.'}
$latencyAfter=(Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 80 -Compress
if($latencyAfter -cne $latencySettings -or $latencyPresetHash -ne (Get-FileHash -LiteralPath (Join-Path $latencySwap 'presets\current.json')).Hash){throw 'Quality state changed unexpectedly.'}
if(@((Invoke-RestMethod 'http://127.0.0.1:8792/faces').faces).Count -ne $latencyFaces){throw 'Approved-face count changed unexpectedly.'}
$latencySavedSnapshot=Get-Content -Raw -LiteralPath $latencySnapshot.file | ConvertFrom-Json
foreach($channel in $latencySavedSnapshot.channels){
  $restored=Invoke-RestMethod ('http://127.0.0.1:8787/simpcity/recall?channel='+$channel.channel)
  if(($restored.recall | ConvertTo-Json -Depth 80 -Compress) -cne ($channel.recall | ConvertTo-Json -Depth 80 -Compress)){throw 'Recall restoration mismatch.'}
}
Write-Output 'Live latency update ready. Quality/preset hash and approved faces unchanged. Idle Recall restored. No emulator restarted.'
