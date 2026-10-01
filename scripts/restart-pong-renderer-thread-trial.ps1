[CmdletBinding()]
param([ValidateSet(0,1,2,4)][int]$Threads=0,[switch]$BootstrapScheduler,[switch]$ObserveScheduler,[switch]$ColdPriority,[switch]$SourceReadyScheduler,[switch]$DepartureScheduler,[switch]$ColorGraphTrial,[switch]$MultiFaceDecisions,[switch]$StageDiagnostics,[switch]$StageOnly,[switch]$EncoderHandoffTrace,[switch]$AcquisitionTrial,[switch]$HairPrecheck,[switch]$PrefetchPriority,[switch]$RemoteFrameDiagnostics,[switch]$FullPathWarmup,[switch]$DecodeAhead,[switch]$WaitForWarm,[switch]$Apply)
$ErrorActionPreference='Stop'
if($DecodeAhead -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $ColorGraphTrial -or $MultiFaceDecisions -or $StageDiagnostics -or $StageOnly -or $EncoderHandoffTrace -or $AcquisitionTrial -or $HairPrecheck -or $PrefetchPriority -or $RemoteFrameDiagnostics -or $FullPathWarmup -or $Threads -gt 0)){throw 'DecodeAhead must run without other experiments'}
if($FullPathWarmup -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $ColorGraphTrial -or $MultiFaceDecisions -or $StageDiagnostics -or $StageOnly -or $EncoderHandoffTrace -or $AcquisitionTrial -or $HairPrecheck -or $PrefetchPriority -or $Threads -gt 0)){throw 'Startup full-path warmup must run without other behavior experiments'}
if($RemoteFrameDiagnostics -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $ColorGraphTrial -or $MultiFaceDecisions -or $StageDiagnostics -or $StageOnly -or $AcquisitionTrial -or $HairPrecheck -or $PrefetchPriority -or $Threads -gt 0)){throw 'Raw-frame host diagnostics must run without other experiments'}
if($EncoderHandoffTrace -and !$StageOnly){throw 'EncoderHandoffTrace requires isolated StageOnly diagnostics'}
if($PrefetchPriority -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $ColorGraphTrial -or $MultiFaceDecisions -or $StageDiagnostics -or $StageOnly -or $AcquisitionTrial -or $HairPrecheck -or $Threads -gt 0)){throw 'PrefetchPriority must run without other behavior or scheduler experiments'}
if($StageOnly -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $ColorGraphTrial -or $MultiFaceDecisions -or $StageDiagnostics -or $AcquisitionTrial -or $HairPrecheck -or $Threads -gt 0)){throw 'StageOnly must run without behavior or scheduler experiments'}
if($HairPrecheck -and !$AcquisitionTrial){throw 'HairPrecheck requires AcquisitionTrial'}
if($AcquisitionTrial -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $ColorGraphTrial -or $MultiFaceDecisions -or $StageDiagnostics)){throw 'AcquisitionTrial must run separately from other experiments'}
if(($ColorGraphTrial -or $MultiFaceDecisions) -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler -or $DepartureScheduler -or $StageDiagnostics)){throw 'ColorGraphTrial/MultiFaceDecisions must run separately from scheduler/stage diagnostics trials'}
if($DepartureScheduler -and ($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler)){throw 'DepartureScheduler must run as a separate isolated trial'}
if($SourceReadyScheduler -and ($BootstrapScheduler -or $ColdPriority)){throw 'SourceReadyScheduler must run separately from GPU scheduling experiments'}
if($StageDiagnostics -and !$DepartureScheduler){throw 'StageDiagnostics requires DepartureScheduler'}
$trialRepo=Split-Path -Parent $PSScriptRoot
$trialSwap=Join-Path $trialRepo 'Pong Swap'
$trialPython=Join-Path $trialSwap 'runtime\venv\Scripts\python.exe'
$trialService=Join-Path $trialSwap 'pong_swap_service.py'
$trialBootstrap=Join-Path $trialSwap 'experiment_tiktok_bootstrap_scheduler.py'
$trialDeparture=Join-Path $trialSwap 'experiment_tiktok_departure.py'
$trialColor=Join-Path $trialSwap 'experiment_tiktok_color_service.py'
$trialAcquisition=Join-Path $trialSwap 'experiment_tiktok_acquisition_service.py'
$trialStage=Join-Path $trialSwap 'experiment_tiktok_stage_service.py'
$trialPriority=Join-Path $trialSwap 'experiment_tiktok_priority_service.py'
$trialDecode=Join-Path $trialSwap 'experiment_tiktok_decode_ahead_service.py'
$trialEntrypoint=if($DecodeAhead){$trialDecode}elseif($PrefetchPriority){$trialPriority}elseif($StageOnly){$trialStage}elseif($AcquisitionTrial){$trialAcquisition}elseif($ColorGraphTrial -or $MultiFaceDecisions){$trialColor}elseif($DepartureScheduler){$trialDeparture}elseif($BootstrapScheduler -or $ObserveScheduler -or $ColdPriority -or $SourceReadyScheduler){$trialBootstrap}else{$trialService}
if(!(Test-Path -LiteralPath $trialEntrypoint)){throw 'Trial entrypoint is missing; nothing stopped'}
$trialPreset=Join-Path $trialSwap 'presets\current.json'
$trialHash=(Get-FileHash -LiteralPath $trialPreset -Algorithm SHA256).Hash
$trialOwners=@(Get-NetTCPConnection -LocalPort 8792 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if($trialOwners.Count -ne 1){throw 'Expected one renderer listener; nothing stopped'}
$trialOwner=Get-CimInstance Win32_Process -Filter "ProcessId=$($trialOwners[0])"
if($trialOwner.Name -ne 'python.exe' -or !($trialOwner.CommandLine.Contains($trialService) -or $trialOwner.CommandLine.Contains($trialBootstrap) -or $trialOwner.CommandLine.Contains($trialDeparture) -or $trialOwner.CommandLine.Contains($trialColor) -or $trialOwner.CommandLine.Contains($trialAcquisition) -or $trialOwner.CommandLine.Contains($trialStage) -or $trialOwner.CommandLine.Contains($trialPriority) -or $trialOwner.CommandLine.Contains($trialDecode))){throw 'Renderer identity mismatch; nothing stopped'}
$trialParent=Get-CimInstance Win32_Process -Filter "ProcessId=$($trialOwner.ParentProcessId)"
if($trialParent -and ($trialParent.Name -ne 'python.exe' -or $trialParent.ExecutablePath -ine $trialPython -or !($trialParent.CommandLine.Contains($trialService) -or $trialParent.CommandLine.Contains($trialBootstrap) -or $trialParent.CommandLine.Contains($trialDeparture) -or $trialParent.CommandLine.Contains($trialColor) -or $trialParent.CommandLine.Contains($trialAcquisition) -or $trialParent.CommandLine.Contains($trialStage) -or $trialParent.CommandLine.Contains($trialPriority) -or $trialParent.CommandLine.Contains($trialDecode)))){$trialParent=$null}
$trialSettings=Invoke-RestMethod 'http://127.0.0.1:8792/settings' -TimeoutSec 5
$trialConfig=$trialSettings.config | ConvertTo-Json -Depth 80 -Compress
if($trialConfig -cne ($trialSettings.baselineConfig | ConvertTo-Json -Depth 80 -Compress)){throw 'Unsaved live settings; nothing stopped'}
if(@((Invoke-RestMethod 'http://127.0.0.1:8792/sessions').sessions).Count -ne 0){throw 'Renderer still has sessions; nothing stopped'}
& $trialPython -c 'import sys,hashlib,pathlib; sys.path.insert(0,sys.argv[1]); from pong_exact_acceleration import SOURCE_HASHES; root=pathlib.Path(sys.argv[1]); bad=[name for name,digest in SOURCE_HASHES.items() if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest]; print("Frozen-source preflight: "+("matched" if not bad else ", ".join(bad))); sys.exit(bool(bad))' $trialSwap
if($LASTEXITCODE -ne 0){throw 'Frozen source changed; existing renderer was not stopped. Restore or fully requalify before activation.'}
if($DecodeAhead){
 & $trialPython -c 'import sys,inspect; sys.path.insert(0,sys.argv[1]); from pong_exact_runtime import frozen_methods as m; import experiment_tiktok_decode_ahead as d; d.transformed_producer_source(inspect.getsource(m._produce_session)); print("Decode-ahead qualified producer preflight: matched")' $trialSwap
 if($LASTEXITCODE -ne 0){throw 'Decode-ahead producer qualification failed; nothing stopped'}
}
Write-Output "Verified idle renderer. CPU threads: $Threads (0 inherits defaults). TikTok bootstrap scheduler trial: $BootstrapScheduler. Departure scheduler trial: $DepartureScheduler. Color graph trial: $ColorGraphTrial. Multi Face decisions: $MultiFaceDecisions. Stage diagnostics: $StageDiagnostics."
if(!$Apply){return}
foreach($trialProcess in @($trialOwner,$trialParent)){
 if(!$trialProcess){continue}
 $trialNow=Get-CimInstance Win32_Process -Filter "ProcessId=$($trialProcess.ProcessId)"
 if(!$trialNow){continue}
 if($trialNow.CreationDate -ne $trialProcess.CreationDate -or $trialNow.CommandLine -cne $trialProcess.CommandLine){throw 'Process identity changed'}
 Stop-Process -Id $trialNow.ProcessId
}
$trialVars=@('OPENCV_FOR_THREADS_NUM','OMP_NUM_THREADS','MKL_NUM_THREADS','PONG_TIKTOK_SCHEDULER_OBSERVE_ONLY','PONG_TIKTOK_COLD_PRIORITY_ONLY','PONG_TIKTOK_STAGE_DIAGNOSTICS','PONG_TIKTOK_SOURCE_READY_ADMISSION','PONG_TIKTOK_ACQUISITION_TRIAL','PONG_REMOTE_FRAME_DIAGNOSTICS','PONG_REMOTE_FULL_PATH_WARMUP')
$trialPrevious=@{}
foreach($trialVar in $trialVars){$trialPrevious[$trialVar]=[Environment]::GetEnvironmentVariable($trialVar,'Process')}
try{
 if($Threads -gt 0){foreach($trialVar in @('OPENCV_FOR_THREADS_NUM','OMP_NUM_THREADS','MKL_NUM_THREADS')){[Environment]::SetEnvironmentVariable($trialVar,[string]$Threads,'Process')}}
 $env:PONG_TIKTOK_SCHEDULER_OBSERVE_ONLY=if($ObserveScheduler -and !$BootstrapScheduler){'1'}else{'0'}
 $env:PONG_TIKTOK_COLD_PRIORITY_ONLY=if($ColdPriority){'1'}else{'0'}
 $env:PONG_TIKTOK_SOURCE_READY_ADMISSION=if($SourceReadyScheduler){'1'}else{'0'}
 $env:PONG_TIKTOK_STAGE_DIAGNOSTICS=if($StageDiagnostics){'1'}else{'0'}
 $env:PONG_TIKTOK_ACQUISITION_TRIAL=if($AcquisitionTrial){'1'}else{'0'}
 $env:PONG_REMOTE_FRAME_DIAGNOSTICS=if($RemoteFrameDiagnostics){'1'}else{'0'}
 $env:PONG_REMOTE_FULL_PATH_WARMUP=if($FullPathWarmup){'1'}else{'0'}
 $trialStamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 $trialLogs='E:\Pong Benchmarks\tiktok-webview-2026-09-29'
 $trialArguments='"'+$trialEntrypoint+'"'
 if($DecodeAhead){$trialArguments+=' --live-trial --port 8792 --output-dir "'+(Join-Path $trialLogs "decode-ahead-$trialStamp")+'"'}
 if($PrefetchPriority){$trialArguments+=' --live-priority --port 8792 --output-dir "'+(Join-Path $trialLogs "prefetch-priority-$trialStamp")+'"'}
 if($StageOnly){$trialArguments+=' --live-attribution --port 8792 --output-dir "'+(Join-Path $trialLogs "stage-only-$trialStamp")+'"'}
 if($EncoderHandoffTrace){$trialArguments+=' --encoder-handoff-trace'}
 if($MultiFaceDecisions){$trialArguments+=' --multi-face-decisions'}
 if($MultiFaceDecisions -and !$ColorGraphTrial){$trialArguments+=' --no-color-graph'}
 if($HairPrecheck){$trialArguments+=' --hair-precheck'}
 $trialStarted=Start-Process -FilePath $trialPython -ArgumentList $trialArguments -WorkingDirectory $trialSwap -WindowStyle Hidden -RedirectStandardOutput (Join-Path $trialLogs "cpu-$Threads-bootstrap-$BootstrapScheduler-$trialStamp.log") -RedirectStandardError (Join-Path $trialLogs "cpu-$Threads-bootstrap-$BootstrapScheduler-$trialStamp.err") -PassThru
}finally{foreach($trialVar in $trialVars){[Environment]::SetEnvironmentVariable($trialVar,$trialPrevious[$trialVar],'Process')}}
$trialDeadline=[DateTime]::UtcNow.AddSeconds($(if($FullPathWarmup){120}else{40}))
do{
 try{$trialHealth=Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 2;break}catch{Start-Sleep -Milliseconds 300}
}while([DateTime]::UtcNow -lt $trialDeadline)
if(!$trialHealth){throw 'Replacement renderer did not become healthy; inspect scoped trial logs'}
$trialListener=Get-CimInstance Win32_Process -Filter "ProcessId=$((Get-NetTCPConnection -LocalPort 8792 -State Listen | Select-Object -First 1).OwningProcess)"
if($trialListener.ProcessId -ne $trialStarted.Id -and $trialListener.ParentProcessId -ne $trialStarted.Id){throw 'Another launcher won the listener; trial not established'}
if($trialHash -ne (Get-FileHash -LiteralPath $trialPreset -Algorithm SHA256).Hash){throw 'Saved quality changed unexpectedly'}
if($trialConfig -cne ((Invoke-RestMethod 'http://127.0.0.1:8792/settings').config | ConvertTo-Json -Depth 80 -Compress)){throw 'Live quality changed unexpectedly'}
if($trialHealth.exactAcceleration.acceleration.installed -ne $true){throw 'Exact acceleration not installed'}
if($DecodeAhead -and !$trialHealth.decodeAheadTrial.active){throw 'Decode-ahead integration is not active'}
if($FullPathWarmup -and !$trialHealth.remoteFullPathWarmup.ready){throw 'Startup full-path preflight did not complete; trial not qualified'}
if($PrefetchPriority -and $trialHealth.prefetchPriorityTrial.active -ne $true){throw 'Prefetch priority trial not installed'}
if($StageOnly -and $trialHealth.stageDiagnosticsTrial.active -ne $true){throw 'Stage-only diagnostics not installed'}
if($EncoderHandoffTrace -and $trialHealth.encoderHandoffTrace.active -ne $true){throw 'Encoder handoff diagnostics not installed'}
if($AcquisitionTrial -and $trialHealth.acquisitionTrial.installed -ne $true){throw 'Acquisition trial not installed'}
if($AcquisitionTrial -and [bool]$trialHealth.acquisitionTrial.hairPrecheck -ne [bool]$HairPrecheck){throw 'Hair precheck mode mismatch'}
if($ColorGraphTrial -and $trialHealth.colorGraphTrial.installed -ne $true){throw 'Color graph trial not installed'}
if($MultiFaceDecisions -and $trialHealth.multiFaceDecisionTrial.installed -ne $true){throw 'Multi Face diagnostics not installed'}
if($MultiFaceDecisions -and !$ColorGraphTrial -and $trialHealth.colorGraphTrial.installed -eq $true){throw 'Unexpected color graph trial in Multi Face-only mode'}
if($DepartureScheduler -and $trialHealth.departureTrial.installed -ne $true){throw 'Departure scheduler trial not installed'}
if($DepartureScheduler -and [bool]$trialHealth.departureTrial.stageDiagnostics -ne [bool]$StageDiagnostics){throw 'Stage diagnostics mode mismatch'}
Write-Output "Trial renderer PID $($trialListener.ProcessId) is healthy. Exact acceleration installed; quality unchanged."
if($StageDiagnostics -or $StageOnly){Write-Output 'CUDA stage diagnostics enabled for TikTok sessions only; timing/FPS from this run is diagnostic, not performance qualification.'}
if($RemoteFrameDiagnostics){Write-Output 'Raw-frame host diagnostics enabled; no CUDA instrumentation or settings changes.'}
if($FullPathWarmup){Write-Output ('Startup full-path preflight: '+($trialHealth.remoteFullPathWarmup | ConvertTo-Json -Compress))}
if($WaitForWarm){
 $trialWarmDeadline=[DateTime]::UtcNow.AddSeconds(120)
 do{
  $trialHealth=Invoke-RestMethod 'http://127.0.0.1:8792/health' -TimeoutSec 5
  if($trialHealth.ready -and !$trialHealth.embeddingPrimerActive){break}
  Start-Sleep -Milliseconds 500
 }while([DateTime]::UtcNow -lt $trialWarmDeadline)
 if(!$trialHealth.ready -or $trialHealth.embeddingPrimerActive){throw 'Renderer API is healthy but model/identity warm-up is not finished; do not score this as a warm benchmark'}
 if($trialHealth.lastError -or $trialHealth.embeddingPrimeError){throw 'Renderer warm-up reported an error; inspect health before benchmarking'}
 Write-Output 'Renderer models ready; identity primer idle. This is warm readiness, not a playback-latency pass.'
}
