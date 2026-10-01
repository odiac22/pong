$ErrorActionPreference = 'Stop'

$swapRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $swapRoot 'runtime\venv\Scripts\python.exe'
$serverPath = Join-Path $swapRoot 'swap_lab.py'
$cachePath = Join-Path $swapRoot 'cache\swap-lab-v1'
$statePath = Join-Path $cachePath 'state.json'
$stdoutPath = Join-Path $cachePath 'server.log'
$stderrPath = Join-Path $cachePath 'server-error.log'
$url = 'http://127.0.0.1:8796'

New-Item -ItemType Directory -Path $cachePath -Force | Out-Null

$ready = $false
try {
  $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
  $ready = [bool]$health.ok
} catch {}

if (-not $ready) {
  $process = Start-Process -FilePath $pythonPath -ArgumentList "`"$serverPath`"" -WorkingDirectory $swapRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  [pscustomobject]@{ Pid = $process.Id; Url = $url; StartedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
      if ($health.ok) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
}

if (-not $ready) {
  throw 'Pong Swap Lab did not start. See cache\swap-lab-v1\server-error.log.'
}

$edgeCandidates = @(
  @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
)

if ($edgeCandidates.Count -gt 0) {
  Start-Process -FilePath $edgeCandidates[0] -ArgumentList @("--app=$url", '--new-window')
} else {
  Start-Process $url
}
