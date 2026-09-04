[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $repoRoot 'local-ai-server.mjs'
$runtimeDir = Join-Path $repoRoot '.pong-local-ai'
$logPath = Join-Path $runtimeDir 'server-watchdog.log'

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

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
  if (Test-PongServerListening) {
    Start-Sleep -Seconds 2
    continue
  }

  Write-WatchdogLog 'Port 8787 is down; starting local-ai-server.mjs.'
  try {
    & $nodeCommand.Source $serverPath *>> $logPath
    $serverExitCode = $LASTEXITCODE
    Write-WatchdogLog "local-ai-server.mjs exited with code $serverExitCode; restarting in 2 seconds."
  } catch {
    Write-WatchdogLog "Server launch failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
}
