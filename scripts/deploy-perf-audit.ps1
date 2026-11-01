#requires -Version 7.0
# perf-audit-20261101 deployment: checkpoint, install the qualified worktree files into the
# live tree, restart ONLY the ownership-verified renderers (8814 via helper 8787, 8792 uvicorn),
# wait for version 30.41.0, warm main. The saved preset is the configuration of record; the
# restart reloads it (the pre-restart 8814 in-memory config is archived, not restored).
param([string]$Worktree='F:\CodexProjects\pong\.claude\worktrees\perf-audit-20261101',[string]$Root='F:\CodexProjects\pong',[string]$Version='30.41.0')
$ErrorActionPreference='Stop'
$swap=Join-Path $Root 'Pong Swap'
$out=Join-Path $Root 'artifacts\perf-audit-20261101\deployment'
if(Test-Path -LiteralPath "$out\receipt.json"){throw 'Deployment already recorded'}
$null=New-Item -ItemType Directory -Path $out -Force
$files=@('pong_three_x.py','pong_tiktok_restorer.py','pong_swap_engine.py','pong_prefetch_boost.py','pong_deferred_readback.py','pong_swap_service.py',
 'test_restorer_ladder.py','test_deferred_readback.py','test_pong_adapt.py','test_pong_prefetch_boost.py')
$records=@()
foreach($port in @(8814,8792)){
 $base="http://127.0.0.1:$port"
 $settings=(Invoke-RestMethod "$base/settings" -NoProxy -TimeoutSec 10).config
 $settings|ConvertTo-Json -Depth 90|Set-Content -LiteralPath "$out\settings-before-$port.json"
 Invoke-RestMethod "$base/sessions" -NoProxy -TimeoutSec 10|ConvertTo-Json -Depth 90|Set-Content -LiteralPath "$out\sessions-before-$port.json"
 $h=Invoke-RestMethod "$base/health" -NoProxy -TimeoutSec 10
 if([int]$h.activeSessions -gt 0){throw "Renderer $port has active sessions; not restarting"}
 $listener=Get-NetTCPConnection -LocalPort $port -State Listen|Select-Object -First 1
 $child=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
 $parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ParentProcessId)"
 if($child.CommandLine -notmatch 'pong_swap_service'){throw "Renderer ownership mismatch:$port"}
 if($child.ExecutablePath -notlike '*\uv\python\cpython-3.12-windows-x86_64-none\python.exe'){throw "Unexpected renderer executable:$port"}
 $records+=@{port=$port;child=$child;parent=$parent}
}
Copy-Item -LiteralPath "$swap\presets\current.json" -Destination "$out\preset-before.json"
$presetHash=(Get-FileHash -LiteralPath "$swap\presets\current.json" -Algorithm SHA256).Hash
$null=New-Item -ItemType Directory -Path "$out\source-before" -Force
foreach($f in $files){ if(Test-Path -LiteralPath "$swap\$f"){ Copy-Item -LiteralPath "$swap\$f" -Destination "$out\source-before\$f" } }
$failure=$null
try{
 foreach($r in $records){
  try{$null=Invoke-RestMethod "http://127.0.0.1:$($r.port)/sessions" -Method Delete -NoProxy -TimeoutSec 25}catch{}
  try{$null=Invoke-RestMethod "http://127.0.0.1:$($r.port)/unload" -Method Post -NoProxy -TimeoutSec 60}catch{}
 }
 foreach($f in $files){ Copy-Item -LiteralPath "$Worktree\Pong Swap\$f" -Destination "$swap\$f" -Force }
 foreach($r in $records){Stop-Process -Id $r.child.ProcessId -ErrorAction SilentlyContinue; if($r.parent.CommandLine -match 'pong_swap_service'){Stop-Process -Id $r.parent.ProcessId -ErrorAction SilentlyContinue}}
 Start-Sleep -Milliseconds 800
 $null=Invoke-RestMethod 'http://127.0.0.1:8787/pong-swap/settings' -NoProxy -TimeoutSec 60
 $null=Start-Process -FilePath "$swap\runtime\venv\Scripts\python.exe" -ArgumentList @('-m','uvicorn','pong_swap_service:app','--host','127.0.0.1','--port','8792') -WorkingDirectory $swap -WindowStyle Hidden -PassThru -RedirectStandardOutput "$out\legacy-stdout.log" -RedirectStandardError "$out\legacy-stderr.log"
 foreach($port in @(8814,8792)){
  $ready=$false
  for($attempt=0;$attempt -lt 120;$attempt++){
   try{$h=Invoke-RestMethod "http://127.0.0.1:$port/health" -NoProxy -TimeoutSec 2;if($h.serviceVersion -eq $Version){$ready=$true;break}}catch{}
   Start-Sleep -Milliseconds 500
  }
  if(-not $ready){throw "Service $port did not report $Version"}
  if(-not $h.realtimeAcceleration.enabled -or $h.realtimeAcceleration.error){throw "Acceleration not ready:$port"}
  (Invoke-RestMethod "http://127.0.0.1:$port/settings" -NoProxy -TimeoutSec 10).config|ConvertTo-Json -Depth 90|Set-Content -LiteralPath "$out\settings-after-$port.json"
 }
 if((Get-FileHash -LiteralPath "$swap\presets\current.json" -Algorithm SHA256).Hash -ne $presetHash){throw 'Saved preset changed during deployment'}
}catch{$failure=$_;$_.ToString()|Set-Content -LiteralPath "$out\deployment-error.txt"}
finally{
 try{Invoke-RestMethod 'http://127.0.0.1:8814/warm?profile=tiktok-3x-adapt' -Method Post -NoProxy -TimeoutSec 300|ConvertTo-Json -Depth 90|Set-Content -LiteralPath "$out\warm.json"}catch{if(-not $failure){$failure=$_};$_.ToString()|Set-Content -LiteralPath "$out\warm-error.txt"}
}
if($failure){throw $failure}
$receipt=foreach($port in @(8814,8792)){
 $h=Invoke-RestMethod "http://127.0.0.1:$port/health" -NoProxy -TimeoutSec 10
 $h|ConvertTo-Json -Depth 90|Set-Content -LiteralPath "$out\health-$port.json"
 [pscustomobject]@{port=$port;version=$h.serviceVersion;ready=$h.runtimeReady;error=$h.lastError;restorers=($h.restorerHostTimings.PSObject.Properties.Name -join ',')}
}
if(-not $receipt[0].ready -or $receipt[0].error){throw 'Main renderer did not warm cleanly'}
$receipt|ConvertTo-Json -Depth 10|Set-Content -LiteralPath "$out\receipt.json"
$receipt|ConvertTo-Json -Depth 10
