param(
 [Parameter(Mandatory=$true)][string]$Suffix,
 [string]$Cells='grass-c1,grass-c4a,fitness-c1,fitness-c4a,clinical-adapt,car-c4a',
 [string]$Config='F:\CodexProjects\pong\Pong Swap\presets\current.json',
 [string]$Overlay='',
 [int]$IdleSeconds=90,
 [switch]$NoIdleWait,
 [switch]$UnloadLive,
 [hashtable]$Env=@{}
)
# perf-audit-20261101 matched benchmark matrix. Waits for the live renderer to be idle
# (no sessions for IdleSeconds) before each cell, optionally takes the benchmark lease
# and unloads the live renderers for a quiet GPU, then restores (removes lease, warms main).
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'run-perf-audit.ps1'
$stock=@{grass='4769378';fitness='5389506';dance='mixkit16117'}
$car='F:\CodexProjects\pong\artifacts\current-quality-20261026\original.mp4'
$lease='F:\CodexProjects\pong\Pong Swap\cache\renderer-benchmark-lease.json'
$owner='perf-audit-20261101'
$leaseJob=$null
function Active-Sessions {
 $n=0
 foreach($p in 8814,8792){ try { $h=Invoke-RestMethod "http://127.0.0.1:$p/health" -TimeoutSec 5; $n+=[int]$h.activeSessions } catch { } }
 return $n
}
function Wait-Idle {
 if($NoIdleWait){return}
 $quietSince=$null
 while($true){
  $n=Active-Sessions
  if($n -eq 0){ if(-not $quietSince){$quietSince=Get-Date}; if(((Get-Date)-$quietSince).TotalSeconds -ge $IdleSeconds){return} }
  else { $quietSince=$null }
  Start-Sleep 5
 }
}
try{
 if($UnloadLive){
  Wait-Idle
  if(Test-Path $lease){ throw "lease already present" }
  $leaseJob=Start-Job -ScriptBlock { param($lease,$owner) while($true){ Set-Content -LiteralPath $lease -Value ('{"expiresAt": '+([string]([int64]((Get-Date).ToUniversalTime()-[datetime]'1970-01-01').TotalSeconds+120))+', "owner": "'+$owner+'"}'); Start-Sleep 30 } } -ArgumentList $lease,$owner
  Start-Sleep 2
  foreach($p in 8814,8792){ try { Invoke-RestMethod -Method Post "http://127.0.0.1:$p/unload" -TimeoutSec 60 | Out-Null } catch { "unload $p failed: $($_.Exception.Message)" } }
 }
 foreach($cell in ($Cells -split ',' | Where-Object { $_ })){
  $cell=$cell.Trim()
  if(-not $UnloadLive){ Wait-Idle }
  $label=('perf'+$Suffix+($cell -replace '[^a-z0-9]','')).ToLower()
  $args=@('-Label',$label,'-Config',$Config)
  if($Overlay){ $args+=@('-Overlay',$Overlay) }
  switch -Regex ($cell){
   '^grass'    { $args+=@('-Stock',$stock.grass) }
   '^fitness'  { $args+=@('-Stock',$stock.fitness) }
   '^dance'    { $args+=@('-Stock',$stock.dance) }
   '^car'      { $args+=@('-Source',$car,'-Faces','approved-8-f7bf754ac81f') }
   '^clinical' { }
  }
  if($cell -match 'c1'){ $args+=@('-Cadence','1','-Adapt','0') }
  elseif($cell -match 'c4a'){ $args+=@('-Cadence','4','-Adapt','1') }
  elseif($cell -match 'c3a'){ $args+=@('-Cadence','3','-Adapt','1') }
  elseif($cell -match 'adapt'){ $args+=@('-Cadence','4','-Adapt','1') }
  $started=Get-Date
  & pwsh -NoProfile -File $runner @args -Env $Env
  $code=$LASTEXITCODE
  $busyAfter=Active-Sessions
  $json="F:\CodexProjects\pong\artifacts\perf-audit-20261101\runs\$label.json"
  if($code -eq 0 -and (Test-Path $json)){
   $r=Get-Content -LiteralPath $json -Raw | ConvertFrom-Json; $s=$r.summary
   [pscustomobject]@{cell=$cell;label=$label;liveSessionsAfter=$busyAfter;fps=[math]::Round($s.renderFps,2);p50=[math]::Round($s.p50Ms,1);p95=[math]::Round($s.p95Ms,1);frames=$s.frames;faceEvents=$s.faceEvents;empty=$s.noSwapFrames.Count;reused=$s.reused;fresh=$s.freshFrames;reuseFrames=$s.reuseFrames;freshMs=[math]::Round($s.freshFrameMs.p50,1);reuseMs=[math]::Round($s.reuseFrameMs.p50,1);cpuMs=[math]::Round($s.processCpuMs.p50,1);syncWaitMs=[math]::Round($s.gpuSyncWaitMs.p50,2);readbackMs=[math]::Round($s.readbackMs.p50,2);gpen=($s.gpenModes -join '/');levels=($s.qualityLevels -join ',');seconds=[int]((Get-Date)-$started).TotalSeconds} | ConvertTo-Json -Compress
  } else { "FAILED cell=$cell exit=$code (see runs\$label.log)" }
 }
}finally{
 if($leaseJob){ Stop-Job $leaseJob -ErrorAction SilentlyContinue; Remove-Job $leaseJob -Force -ErrorAction SilentlyContinue }
 if(Test-Path $lease){ try { $d=Get-Content $lease -Raw | ConvertFrom-Json; if($d.owner -eq $owner){ Remove-Item $lease -Force } } catch { Remove-Item $lease -Force -ErrorAction SilentlyContinue } }
 if($UnloadLive){ try { Invoke-RestMethod -Method Post 'http://127.0.0.1:8814/warm?profile=tiktok-3x-adapt' -TimeoutSec 300 | Out-Null; 'main warmed' } catch { "warm failed: $($_.Exception.Message)" } }
}
