[CmdletBinding()]
param([string]$RecallRestoreFile = '')

$ErrorActionPreference = 'Continue'

# Task Scheduler and a manual startup used to be able to leave two watchdogs
# alive. They could race whenever port 8787 restarted. Hold one machine-wide
# mutex so exactly one owner can supervise Pong.
$watchdogMutex = New-Object System.Threading.Mutex($false, 'Global\Odiac22PongServerWatchdog')
try {
  $watchdogMutexOwned = $watchdogMutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
  $watchdogMutexOwned = $true
}
if (-not $watchdogMutexOwned) { exit 0 }

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $repoRoot 'local-ai-server.mjs'
$runtimeDir = Join-Path $repoRoot '.pong-local-ai'
$logPath = Join-Path $runtimeDir 'server-watchdog.log'
$reportDir = Join-Path $runtimeDir 'node-reports'
$restoreOnNextLaunch = $RecallRestoreFile
if ($restoreOnNextLaunch -and -not (Test-Path -LiteralPath $restoreOnNextLaunch -PathType Leaf)) {
  throw 'The requested idle Recall snapshot is missing.'
}
$vpsTunnelPort = 18791
$vpsSshKey = 'C:\Users\arian\Documents\New project\vps-private-input\codex_vps_temp'
$firefoxScraperPort = 18801
$firefoxScraperScript = Join-Path $PSScriptRoot 'firefox_scraper_service.py'
$firefoxScraperPython = Join-Path $runtimeDir 'firefox-venv\Scripts\python.exe'

# Local1 keeps only 15-video eligibility in volatile memory. AI approval is
# always performed fresh after the user presses the button.
$env:PONG_RANDOM40_RESERVOIR_ENABLED = '1'
$env:PONG_RANDOM40_ACCEPTED_PREAPPROVAL_ENABLED = '0'
$env:PONG_RANDOM40_RESERVOIR_TARGET = '16'
$env:PONG_RANDOM40_RESERVOIR_VERIFIED_TARGET = '8'
$env:PONG_RANDOM40_RESERVOIR_READY_MIN = '3'
$env:PONG_RANDOM40_RESERVOIR_CONCURRENCY = '2'

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null

function Write-WatchdogLog {
  param([string]$Message)

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
  Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Test-PongServerListening {
  try {
    return $null -ne (
      Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction Stop |
        Select-Object -First 1
    )
  } catch {
    foreach ($line in @(netstat.exe -ano -p TCP 2>$null)) {
      if ($line -match '^\s*TCP\s+\S+:8787\s+\S+\s+LISTENING\s+\d+\s*$') {
        return $true
      }
    }
    return $false
  }
}

function Test-VpsScraperTunnelListening {
  try {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $vpsTunnelPort -ErrorAction Stop | Select-Object -First 1)
  } catch { return $false }
}

function Start-VpsScraperTunnelIfNeeded {
  if ((Test-VpsScraperTunnelListening) -or -not (Test-Path -LiteralPath $vpsSshKey)) { return }
  $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $ssh) { return }
  $arguments = "-N -L 127.0.0.1:${vpsTunnelPort}:127.0.0.1:8791 -i `"$vpsSshKey`" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 root@217.77.13.143"
  try {
    Start-Process -FilePath $ssh.Source -ArgumentList $arguments -WindowStyle Hidden
    Write-WatchdogLog 'Started private VPS scraper tunnel.'
  } catch {
    Write-WatchdogLog "VPS scraper tunnel launch failed: $($_.Exception.Message)"
  }
}

function Start-FirefoxScraperIfNeeded {
  try {
    $listening = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $firefoxScraperPort -ErrorAction Stop | Select-Object -First 1)
  } catch { $listening = $false }
  if ($listening -or -not (Test-Path -LiteralPath $firefoxScraperPython) -or -not (Test-Path -LiteralPath $firefoxScraperScript)) { return }
  try {
    Start-Process -FilePath $firefoxScraperPython -ArgumentList "`"$firefoxScraperScript`"" -WorkingDirectory $repoRoot -WindowStyle Hidden
    Write-WatchdogLog 'Started hidden private Firefox scraper service.'
  } catch {
    Write-WatchdogLog "Firefox scraper launch failed: $($_.Exception.Message)"
  }
}

function Start-CaptureCompanionIfNeeded {
  try {
    if (Get-NetTCPConnection -State Listen -LocalPort 8797 -ErrorAction Stop | Select-Object -First 1) { return }
  } catch {}
  $captureScript = Join-Path $PSScriptRoot 'detection-feedback-receiver.mjs'
  if (-not (Test-Path -LiteralPath $captureScript)) { return }
  try {
    Start-Process -FilePath $nodeCommand.Source -ArgumentList "`"$captureScript`"" -WorkingDirectory $repoRoot -WindowStyle Hidden
    Write-WatchdogLog 'Started hidden Pong capture companion on 8797.'
  } catch { Write-WatchdogLog "Capture companion launch failed: $($_.Exception.Message)" }
}

if (-not (Test-Path -LiteralPath $serverPath)) {
  Write-WatchdogLog "Server file is missing: $serverPath"
  exit 1
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-WatchdogLog 'node.exe was not found on PATH.'
  exit 1
}

Write-WatchdogLog "Watchdog started (PID $PID)."

while ($true) {
  Start-CaptureCompanionIfNeeded
  Start-VpsScraperTunnelIfNeeded
  Start-FirefoxScraperIfNeeded
  if (Test-PongServerListening) {
    Start-Sleep -Seconds 2
    continue
  }

  Write-WatchdogLog 'Port 8787 is down; starting local-ai-server.mjs.'
  try {
    $reportDirectoryArgument = "--report-directory=$reportDir"
    # A controlled activation restores exactly once. Never replay an old
    # snapshot on subsequent automatic restarts after the user imports more.
    $restoreEnvironmentBefore = $env:PONG_RECALL_RESTORE_FILE
    try {
      if ($restoreOnNextLaunch) { $env:PONG_RECALL_RESTORE_FILE = $restoreOnNextLaunch }
      $restoreOnNextLaunch = ''
      & $nodeCommand.Source '--report-on-fatalerror' '--report-uncaught-exception' $reportDirectoryArgument $serverPath *>> $logPath
    } finally {
      $env:PONG_RECALL_RESTORE_FILE = $restoreEnvironmentBefore
    }
    $serverExitCode = $LASTEXITCODE
    Write-WatchdogLog "local-ai-server.mjs exited with code $serverExitCode; restarting in 2 seconds."
  } catch {
    Write-WatchdogLog "Server launch failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
}
