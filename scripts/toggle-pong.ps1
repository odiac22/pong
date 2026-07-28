[CmdletBinding()]
param(
  [ValidateSet('Toggle', 'Start', 'Stop', 'Status')]
  [string]$Action = 'Toggle',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeServerPath = Join-Path $repoRoot 'local-ai-server.mjs'
$preferenceLauncherPath = Join-Path $PSScriptRoot 'run-preference-ai.ps1'
$pongPorts = @(8787, 8790, 8791)
$allDependencyPorts = @(8787, 8790, 8791, 11434)
$ollamaProcessNames = @('ollama.exe', 'ollama app.exe', 'llama-server.exe')

function Get-ProcessSnapshot {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Get-ListeningProcessIds {
  param([int[]]$Ports)

  try {
    return @(
      Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -in $Ports } |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($line in @(netstat.exe -ano -p TCP 2>$null)) {
      if ($line -notmatch '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
        continue
      }
      if ([int]$Matches[1] -in $Ports) {
        $null = $ids.Add([int]$Matches[2])
      }
    }
    return @($ids)
  }
}

function Test-IsPongProcess {
  param($ProcessInfo)

  if (-not $ProcessInfo -or [int]$ProcessInfo.ProcessId -eq $PID) {
    return $false
  }

  $commandLine = [string]$ProcessInfo.CommandLine
  if (-not $commandLine) {
    return $false
  }

  $repoPattern = [regex]::Escape($repoRoot)
  if ($commandLine -match $repoPattern -and $commandLine -match '(?i)(local-ai-server\.mjs|preference_ai_service\.py|lora_inference_server\.py|run-preference-ai\.ps1|run-lora-infer\.ps1|start-local-ai\.bat)') {
    return $true
  }

  return $commandLine -match '(?i)(^|[\\/"\s])local-ai-server\.mjs([/"\s]|$)'
}

function Test-PongRunning {
  if (@(Get-ListeningProcessIds -Ports $pongPorts).Count -gt 0) {
    return $true
  }

  foreach ($processInfo in Get-ProcessSnapshot) {
    if (Test-IsPongProcess -ProcessInfo $processInfo) {
      return $true
    }
  }

  return $false
}

function Show-PongNotice {
  param(
    [string]$Message,
    [int]$Icon = 64
  )

  if ($Quiet) {
    return
  }

  try {
    $shell = New-Object -ComObject WScript.Shell
    $null = $shell.Popup($Message, 3, 'Pong', $Icon)
  } catch {
    # The toggle still works when Windows notifications are unavailable.
  }
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
    return
  }

  & taskkill.exe /PID $ProcessId /T /F *> $null
}

function Stop-Pong {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/workload/reset' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 2 | Out-Null
  } catch {
    # A hard stop below is intentional when the API is busy or unavailable.
  }

  for ($pass = 0; $pass -lt 3; $pass++) {
    $snapshot = Get-ProcessSnapshot
    $targetIds = [System.Collections.Generic.HashSet[int]]::new()

    foreach ($processId in Get-ListeningProcessIds -Ports $allDependencyPorts) {
      if ([int]$processId -ne $PID) {
        $null = $targetIds.Add([int]$processId)
      }
    }

    foreach ($processInfo in $snapshot) {
      if (Test-IsPongProcess -ProcessInfo $processInfo) {
        $null = $targetIds.Add([int]$processInfo.ProcessId)
      }
      if ([string]$processInfo.Name -in $ollamaProcessNames) {
        $null = $targetIds.Add([int]$processInfo.ProcessId)
      }
    }

    if ($targetIds.Count -eq 0) {
      break
    }

    $rootIds = @(
      $targetIds | ForEach-Object {
        $candidateId = [int]$_
        $candidate = $snapshot |
          Where-Object { [int]$_.ProcessId -eq $candidateId } |
          Select-Object -First 1
        if (-not $candidate -or -not $targetIds.Contains([int]$candidate.ParentProcessId)) {
          $candidateId
        }
      }
    )

    if ($rootIds.Count -eq 0) {
      $rootIds = @($targetIds)
    }

    foreach ($processId in $rootIds) {
      try {
        Stop-ProcessTree -ProcessId ([int]$processId)
      } catch {
        # Processes can exit naturally while the tree is being stopped.
      }
    }

    Start-Sleep -Milliseconds 350
  }

  $remainingPorts = @(Get-ListeningProcessIds -Ports $allDependencyPorts)
  $remainingProcesses = @(
    Get-ProcessSnapshot | Where-Object {
      (Test-IsPongProcess -ProcessInfo $_) -or ([string]$_.Name -in $ollamaProcessNames)
    }
  )

  if ($remainingPorts.Count -gt 0 -or $remainingProcesses.Count -gt 0) {
    throw 'Some Pong services did not terminate. Run the toggle again.'
  }
}

function Start-Pong {
  if (-not (Test-Path -LiteralPath $nodeServerPath)) {
    throw "Pong server was not found at $nodeServerPath"
  }
  if (-not (Test-Path -LiteralPath $preferenceLauncherPath)) {
    throw "Pong preference launcher was not found at $preferenceLauncherPath"
  }

  $listeningPorts = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in $allDependencyPorts } |
      Select-Object -ExpandProperty LocalPort -Unique
  )

  if (11434 -notin $listeningPorts) {
    $ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
    $ollamaPath = if ($ollamaCommand) {
      $ollamaCommand.Source
    } else {
      Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    }
    if (-not (Test-Path -LiteralPath $ollamaPath)) {
      throw 'Ollama was not found.'
    }
    Start-Process -FilePath $ollamaPath -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
  }

  $env:PONG_LORA_PRELOAD = '0'
  $env:PONG_LORA_AUTOTRAIN = '0'

  if (8791 -notin $listeningPorts) {
    Start-Process `
      -FilePath (Join-Path $PSHOME 'powershell.exe') `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$preferenceLauncherPath`"" `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden | Out-Null
  }

  if (8787 -notin $listeningPorts) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    Start-Process `
      -FilePath $nodeCommand.Source `
      -ArgumentList "`"$nodeServerPath`"" `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden | Out-Null
  }

  Start-Sleep -Milliseconds 700
}

try {
  $wasRunning = Test-PongRunning

  switch ($Action) {
    'Status' {
      if ($wasRunning) {
        Write-Output 'Running'
        exit 0
      }
      Write-Output 'Stopped'
      exit 1
    }
    'Start' {
      if (-not $wasRunning) {
        Start-Pong
      }
      Write-Output 'Pong is starting.'
      Show-PongNotice -Message 'Pong is starting in the background.'
    }
    'Stop' {
      Stop-Pong
      Write-Output 'Pong is fully stopped.'
      Show-PongNotice -Message 'Pong is fully stopped. Gaming resources are free.'
    }
    'Toggle' {
      if ($wasRunning) {
        Stop-Pong
        Write-Output 'Pong is fully stopped.'
        Show-PongNotice -Message 'Pong is fully stopped. Gaming resources are free.'
      } else {
        Start-Pong
        Write-Output 'Pong is starting.'
        Show-PongNotice -Message 'Pong is starting in the background.'
      }
    }
  }
} catch {
  Write-Error $_
  Show-PongNotice -Message "Pong toggle failed:`n$($_.Exception.Message)" -Icon 16
  exit 1
}
