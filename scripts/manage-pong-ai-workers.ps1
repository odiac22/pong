[CmdletBinding()]
param(
  [ValidateSet('Start', 'Stop', 'Status')]
  [string]$Action = 'Status',
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$preferenceLauncher = Join-Path $PSScriptRoot 'run-preference-ai.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$workerPorts = @(8790, 8791, 11434)

function Get-ListeningOwner {
  param([int]$Port)
  return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Get-WorkerStatus {
  $ports = [ordered]@{}
  foreach ($port in $workerPorts) {
    $ports[[string]$port] = [bool](Get-ListeningOwner -Port $port)
  }
  return [ordered]@{
    ok = $true
    action = $Action.ToLowerInvariant()
    ollama = $ports['11434']
    preference = $ports['8791']
    lora = $ports['8790']
    ports = $ports
  }
}

function Start-PongAiWorkers {
  if (-not (Get-ListeningOwner -Port 11434)) {
    $ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
    $ollamaPath = if ($ollamaCommand) {
      $ollamaCommand.Source
    } else {
      Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    }
    if (-not (Test-Path -LiteralPath $ollamaPath)) {
      throw 'Ollama was not found.'
    }
    Start-Process -FilePath $ollamaPath -ArgumentList 'serve' -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
  }

  if (-not (Get-ListeningOwner -Port 8791)) {
    if (-not (Test-Path -LiteralPath $preferenceLauncher)) {
      throw 'The Pong preference worker launcher was not found.'
    }
    Start-Process `
      -FilePath $windowsPowerShell `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$preferenceLauncher`"" `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden | Out-Null
  }

  $deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
  do {
    if ((Get-ListeningOwner -Port 11434) -and (Get-ListeningOwner -Port 8791)) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  throw 'Pong AI workers did not open their ports before the startup timeout.'
}

function Stop-PongAiWorkers {
  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $targets = [System.Collections.Generic.HashSet[int]]::new()

  foreach ($port in $workerPorts) {
    $listener = Get-ListeningOwner -Port $port
    if (-not $listener) { continue }
    $processInfo = $snapshot | Where-Object { [int]$_.ProcessId -eq [int]$listener.OwningProcess } | Select-Object -First 1
    $commandLine = [string]$processInfo.CommandLine
    $safeOwner =
      ($port -eq 11434 -and [string]$processInfo.Name -ieq 'ollama.exe') -or
      ($commandLine -match '(?i)preference_ai_service\.py') -or
      ($commandLine -match '(?i)lora_inference_server\.py')
    if ($safeOwner) { $null = $targets.Add([int]$listener.OwningProcess) }
  }

  $repoPattern = [regex]::Escape($repoRoot)
  foreach ($processInfo in $snapshot) {
    $commandLine = [string]$processInfo.CommandLine
    if (-not $commandLine -or $commandLine -notmatch $repoPattern) { continue }
    if ($commandLine -match '(?i)(run-preference-ai\.ps1|preference_ai_service\.py|run-lora-infer\.ps1|lora_inference_server\.py)') {
      $null = $targets.Add([int]$processInfo.ProcessId)
    }
  }

  # Kill only roots inside the verified worker set; taskkill then removes their
  # child interpreters without touching the always-on Pong server.
  $rootIds = @($targets | Where-Object {
    $candidate = [int]$_
    $processInfo = $snapshot | Where-Object { [int]$_.ProcessId -eq $candidate } | Select-Object -First 1
    -not $processInfo -or -not $targets.Contains([int]$processInfo.ParentProcessId)
  })
  foreach ($processId in $rootIds) {
    & taskkill.exe /PID ([int]$processId) /T /F *> $null
  }

  $deadline = (Get-Date).AddSeconds([Math]::Max(1, [Math]::Min(15, $WaitSeconds)))
  do {
    $remaining = @($workerPorts | Where-Object { Get-ListeningOwner -Port $_ })
    if (-not $remaining.Count) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  throw "Pong AI worker ports are still active: $($remaining -join ', ')"
}

switch ($Action) {
  'Start' { Start-PongAiWorkers }
  'Stop' { Stop-PongAiWorkers }
}

Get-WorkerStatus | ConvertTo-Json -Compress
