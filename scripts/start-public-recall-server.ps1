param([Parameter(Mandatory=$true)][string]$Snapshot,[Parameter(Mandatory=$true)][int]$Port)
$resolved = (Resolve-Path -LiteralPath $Snapshot).Path
if (-not $resolved.StartsWith('E:\Pong Benchmarks\v3006-public-recall\')) { throw 'Unexpected benchmark workspace' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Test port is already occupied' }
$env:PONG_LOCAL_AI_PORT="$Port"
$env:PONG_LOCAL_AI_HOST='127.0.0.1'
$env:PONG_SWAP_CONTROL_PORT="$($Port+100)"
$env:PONG_SWAP_BACKGROUND_CONTROL_PORT="$($Port+200)"
$env:PONG_VIDEO_FILE_CACHE_DIR=Join-Path $resolved "cache-$Port/.pong-ephemeral-video-cache"
$testProcess=Start-Process -FilePath (Get-Command node).Source -ArgumentList 'local-ai-server.mjs' -WorkingDirectory $resolved -WindowStyle Hidden -RedirectStandardOutput (Join-Path $resolved "server-$Port.log") -RedirectStandardError (Join-Path $resolved "server-$Port.err") -PassThru
[pscustomobject]@{pid=$testProcess.Id;port=$Port;snapshot=$resolved}|ConvertTo-Json -Compress
