$ErrorActionPreference = 'Stop'

$swapRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudflaredPath = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$pythonPath = Join-Path $swapRoot 'runtime\venv\Scripts\python.exe'
$uploadScriptPath = Join-Path $swapRoot 'face_upload.py'
$token = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')).Substring(0, 40)

if (-not (Test-Path -LiteralPath $cloudflaredPath)) { throw 'cloudflared is not installed' }

$env:PONG_SWAP_FACE_UPLOAD_TOKEN = $token
$env:PONG_SWAP_FACE_UPLOAD_PORT = '8794'
$logDir = Join-Path $swapRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$serverOutput = Join-Path $logDir 'face-upload-server.log'
$serverError = Join-Path $logDir 'face-upload-server-error.log'
$tunnelOutput = Join-Path $logDir 'face-upload-tunnel.log'
$tunnelError = Join-Path $logDir 'face-upload-tunnel-error.log'
$statePath = Join-Path $logDir 'face-upload-state.json'

$serverProcess = Start-Process -FilePath $pythonPath -ArgumentList "`"$uploadScriptPath`"" -WorkingDirectory $swapRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverOutput -RedirectStandardError $serverError
$localUrl = "http://127.0.0.1:8794/$token"
$localReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try { if ((Invoke-WebRequest -Uri $localUrl -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $localReady = $true; break } } catch {}
  Start-Sleep -Milliseconds 200
}
if (-not $localReady) { throw 'face upload server did not start' }

$tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList @('tunnel','--url','http://127.0.0.1:8794','--no-autoupdate','--loglevel','info') -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunnelOutput -RedirectStandardError $tunnelError
$baseUrl = ''
for ($attempt = 0; $attempt -lt 80; $attempt++) {
  $logText = ((Get-Content -LiteralPath $tunnelOutput, $tunnelError -Raw -ErrorAction SilentlyContinue) -join "`n")
  $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $baseUrl = $match.Value; break }
  if ($tunnelProcess.HasExited) { break }
  Start-Sleep -Milliseconds 350
}
if (-not $baseUrl) { throw 'secure face upload tunnel did not start' }

$publicUrl = "$baseUrl/$token"
$state = [pscustomobject]@{ Url=$publicUrl; HttpsStatus=$null; UploadServerPid=$serverProcess.Id; TunnelPid=$tunnelProcess.Id }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  try { $state.HttpsStatus = (Invoke-WebRequest -Uri $publicUrl -UseBasicParsing -TimeoutSec 5).StatusCode; break } catch {}
  Start-Sleep -Milliseconds 500
}
if ($state.HttpsStatus -ne 200) { throw 'secure face upload URL did not pass its HTTPS check' }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
$state | ConvertTo-Json -Compress
