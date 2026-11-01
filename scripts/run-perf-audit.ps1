param(
 [Parameter(Mandatory=$true)][string]$Label,
 [string]$Stock='',
 [string]$Source='',
 [int]$Cadence=1,
 [string]$Profile='',
 [string]$Adapt='',
 [string]$Config='',
 [string]$Seconds='10',
 [int]$Frames=629,
 [string]$Restorer='',
 [string]$Attachment='',
 [string]$Faces='',
 [string]$Overlay='',
 [string]$Root='F:\CodexProjects\pong',
 [string]$OutputDir='F:\CodexProjects\pong\artifacts\perf-audit-20261101\runs',
 [string]$MediaDir='E:\Pong Benchmarks\perf-audit-20261101\renders',
 [hashtable]$Env=@{}
)
# perf-audit-20261101: offline render benchmark against the LIVE Pong Swap tree, with the
# exact environment of the live acceleration manifest (Pong Swap/cache/realtime-acceleration.json).
$ErrorActionPreference='Stop'
$harness=Join-Path $PSScriptRoot 'benchmark-perf-audit.py'
$manifest=Get-Content -LiteralPath (Join-Path $Root 'Pong Swap\cache\realtime-acceleration.json') -Raw | ConvertFrom-Json
if($manifest.enabled){
 foreach($p in $manifest.environment.PSObject.Properties){ if(-not (Test-Path "Env:$($p.Name)")){ Set-Item -Path "Env:$($p.Name)" -Value ([string]$p.Value) } }
 if($manifest.dependencies){ $env:PYTHONPATH=[string]$manifest.dependencies }
 if($manifest.cudaPath){ $env:CUDA_PATH=[string]$manifest.cudaPath }
 if($manifest.kernelCache){ $env:CUPY_CACHE_DIR=[string]$manifest.kernelCache }
}
foreach($k in $Env.Keys){ Set-Item -Path "Env:$k" -Value ([string]$Env[$k]) }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $MediaDir | Out-Null
$env:PONG_AUDIT_ROOT=$Root
$env:PONG_AUDIT_OUTPUT=$OutputDir
$env:PONG_AUDIT_MEDIA=$MediaDir
$env:PONG_AUDIT_CADENCE=[string]$Cadence
$env:PONG_AUDIT_SECONDS=$Seconds
$env:PONG_AUDIT_TELEMETRY='1'
$env:PONG_AUDIT_PIXEL_HASH='1'
$env:PONG_AUDIT_PREWARM_APPEARANCE='1'
if($Stock){$env:PONG_AUDIT_STOCK=$Stock}else{Remove-Item Env:PONG_AUDIT_STOCK -ErrorAction SilentlyContinue}
if($Source){$env:PONG_AUDIT_SOURCE=$Source}else{Remove-Item Env:PONG_AUDIT_SOURCE -ErrorAction SilentlyContinue}
if($Profile){$env:PONG_AUDIT_PROFILE=$Profile}else{Remove-Item Env:PONG_AUDIT_PROFILE -ErrorAction SilentlyContinue}
if($Adapt -ne ''){$env:PONG_AUDIT_ADAPT=$Adapt}else{Remove-Item Env:PONG_AUDIT_ADAPT -ErrorAction SilentlyContinue}
if($Config){$env:PONG_AUDIT_CONFIG=$Config}else{Remove-Item Env:PONG_AUDIT_CONFIG -ErrorAction SilentlyContinue}
if($Restorer){$env:PONG_AUDIT_RESTORER=$Restorer}else{Remove-Item Env:PONG_AUDIT_RESTORER -ErrorAction SilentlyContinue}
if($Attachment -ne ''){$env:PONG_AUDIT_ATTACHMENT=$Attachment}else{Remove-Item Env:PONG_AUDIT_ATTACHMENT -ErrorAction SilentlyContinue}
if($Faces){$env:PONG_AUDIT_FACES=$Faces}else{Remove-Item Env:PONG_AUDIT_FACES -ErrorAction SilentlyContinue}
if($Overlay){$env:PONG_AUDIT_OVERLAY=$Overlay;$env:PONG_SWAP_HOME=(Join-Path $Root 'Pong Swap')}else{Remove-Item Env:PONG_AUDIT_OVERLAY -ErrorAction SilentlyContinue;Remove-Item Env:PONG_SWAP_HOME -ErrorAction SilentlyContinue}
$python=Join-Path $Root 'Pong Swap\runtime\venv\Scripts\python.exe'
Push-Location -LiteralPath $Root
try{
 $ErrorActionPreference='Continue' # native inference libraries write diagnostics to stderr
 & $python $harness $Label $Frames *> (Join-Path $OutputDir ($Label+'.log'))
 $code=$LASTEXITCODE
}finally{Pop-Location}
exit $code
