$ErrorActionPreference = 'Stop'
$swapRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8874
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw 'Grouped uploader port is already in use; inspect grouped-face-upload-state.json rather than starting a duplicate.'
}
$env:PONG_SWAP_FACE_UPLOAD_TOKEN = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
$env:PONG_SWAP_FACE_UPLOAD_PORT = [string]$port
$uploadScript = Join-Path $swapRoot 'face_upload.py'
$logDir = Join-Path $swapRoot 'logs'
$server = Start-Process -FilePath (Join-Path $swapRoot 'runtime\venv\Scripts\python.exe') -ArgumentList ('"' + $uploadScript + '"') -WorkingDirectory $swapRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'grouped-face-upload.stdout.log') -RedirectStandardError (Join-Path $logDir 'grouped-face-upload.stderr.log')
$state = [pscustomobject]@{Url='';LocalUrl="http://127.0.0.1:$port/$env:PONG_SWAP_FACE_UPLOAD_TOKEN";UploadServerPid=$server.Id;TunnelPid=0;HttpsStatus=$null;Inbox='E:\Pong Face References\inbox'}
$statePath = Join-Path $logDir 'grouped-face-upload-state.json'
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
$ready = $false
for ($attempt=0; $attempt -lt 40; $attempt++) {
    try { if ((Invoke-WebRequest -Uri $state.LocalUrl -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ready=$true; break } } catch {}
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw 'Uploader did not become ready; process IDs are saved for inspection' }
$tunnelOut = Join-Path $logDir 'grouped-face-upload-tunnel.stdout.log'
$tunnelErr = Join-Path $logDir 'grouped-face-upload-tunnel.stderr.log'
$tunnel = Start-Process -FilePath 'C:\Program Files (x86)\cloudflared\cloudflared.exe' -ArgumentList @('tunnel','--url',"http://127.0.0.1:$port",'--no-autoupdate','--loglevel','info') -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr
$state.TunnelPid=$tunnel.Id
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
for ($attempt=0; $attempt -lt 80; $attempt++) {
    $logText=((Get-Content -LiteralPath $tunnelOut,$tunnelErr -Raw -ErrorAction SilentlyContinue) -join "`n")
    $match=[regex]::Match($logText,'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { $state.Url=$match.Value+'/'+$env:PONG_SWAP_FACE_UPLOAD_TOKEN; break }
    Start-Sleep -Milliseconds 350
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
if (-not $state.Url) { throw 'Tunnel hostname unavailable; inspect saved processes and logs' }
$state | ConvertTo-Json -Compress
