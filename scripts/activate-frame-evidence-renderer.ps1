$ErrorActionPreference='Stop'
$evidenceRepo=Split-Path -Parent $PSScriptRoot
$evidenceService=Join-Path $evidenceRepo 'Pong Swap\pong_swap_service.py'
$evidenceBefore=(Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 30 -Compress
$evidenceOwners=@(Get-NetTCPConnection -LocalPort 8792 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if($evidenceOwners.Count -ne 1){throw 'Expected one renderer; nothing stopped'}
$evidenceProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($evidenceOwners[0])"
if($evidenceProcess.Name -ne 'python.exe' -or -not $evidenceProcess.CommandLine.Contains($evidenceService)){throw 'Renderer ownership mismatch; nothing stopped'}
$evidenceParent=Get-CimInstance Win32_Process -Filter "ProcessId=$($evidenceProcess.ParentProcessId)"
if($evidenceParent.Name -eq 'python.exe' -and $evidenceParent.CommandLine.Contains($evidenceService)){Stop-Process -Id $evidenceParent.ProcessId -ErrorAction SilentlyContinue}
Stop-Process -Id $evidenceProcess.ProcessId -ErrorAction SilentlyContinue
$evidenceHealth=Invoke-RestMethod 'http://127.0.0.1:8787/pong-swap/health' -TimeoutSec 45
$evidenceAfter=(Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 30 -Compress
if($evidenceBefore -ne $evidenceAfter){throw 'Settings differ after restart; investigate before testing'}
Write-Output 'Renderer restarted with frame evidence. Saved quality unchanged.'
