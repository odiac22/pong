[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$hairRepo=Split-Path -Parent $PSScriptRoot
$hairService=Join-Path $hairRepo 'Pong Swap\pong_swap_service.py'
$hairPython=Join-Path $hairRepo 'Pong Swap\runtime\venv\Scripts\python.exe'
$hairBefore=(Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 80 -Compress
$hairPreset=(Get-FileHash -LiteralPath (Join-Path $hairRepo 'Pong Swap\presets\current.json')).Hash
$hairFaces=@((Invoke-RestMethod 'http://127.0.0.1:8792/faces').faces).Count
$hairOwners=@(Get-NetTCPConnection -LocalPort 8792 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if($hairOwners.Count -ne 1){throw 'Expected exactly one renderer; nothing stopped.'}
$hairProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($hairOwners[0])"
$hairParent=Get-CimInstance Win32_Process -Filter "ProcessId=$($hairProcess.ParentProcessId)"
$hairRelative=$hairParent.ExecutablePath -ieq $hairPython -and $hairParent.CommandLine -match '(?:^|\s)pong_swap_service[.]py\s*$' -and $hairProcess.CommandLine -match '(?:^|\s)pong_swap_service[.]py\s*$'
if($hairProcess.Name -ne 'python.exe' -or (-not $hairProcess.CommandLine.Contains($hairService) -and -not $hairRelative)){throw 'Renderer identity mismatch; nothing stopped.'}
function Stop-HairRecorded($record) {
  $now=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.ProcessId)"
  if(-not $now){return}
  if($now.CreationDate -ne $record.CreationDate -or $now.CommandLine -cne $record.CommandLine){throw 'Process identity changed; nothing else stopped.'}
  try { Stop-Process -Id $record.ProcessId -ErrorAction Stop }
  catch { if(Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue){throw} }
}
if($hairParent.ExecutablePath -ieq $hairPython -and ($hairRelative -or $hairParent.CommandLine.Contains($hairService))){Stop-HairRecorded $hairParent}
Stop-HairRecorded $hairProcess
# The existing helper owns renderer startup; do not create another supervisor.
$hairDeadline=[DateTime]::UtcNow.AddSeconds(60)
$hairReachable=$false
do {
  try {$null=Invoke-RestMethod 'http://127.0.0.1:8787/pong-swap/health' -TimeoutSec 20;$hairReachable=$true}
  catch {Start-Sleep -Milliseconds 500}
} while(-not $hairReachable -and [DateTime]::UtcNow -lt $hairDeadline)
if(-not $hairReachable){throw 'Renderer restart did not become reachable; no second restart attempted.'}
$hairAfter=(Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 80 -Compress
if($hairAfter -cne $hairBefore -or $hairPreset -ne (Get-FileHash -LiteralPath (Join-Path $hairRepo 'Pong Swap\presets\current.json')).Hash){throw 'Quality settings changed unexpectedly.'}
if(@((Invoke-RestMethod 'http://127.0.0.1:8792/faces').faces).Count -ne $hairFaces){throw 'Approved face count changed unexpectedly.'}
$hairHealth=Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 15
$hairAcceleration=$hairHealth.exactAcceleration
if($hairAcceleration.acceleration){$hairAcceleration=$hairAcceleration.acceleration}
if($hairAcceleration.installed -ne $true){throw 'Renderer is reachable but approved acceleration is not installed; activation is not qualified.'}
Write-Output 'Hair-policy renderer reloaded. Saved quality and approved faces unchanged. Helper/Recall not restarted.'
Write-Output 'Approved exact acceleration is installed.'
