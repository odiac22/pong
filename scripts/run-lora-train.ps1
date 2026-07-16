param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$localDir = Join-Path $RepoRoot '.pong-local-ai'
$venvPython = Join-Path $localDir 'lora-venv\Scripts\python.exe'
$statusPath = Join-Path $localDir 'finetune-status.json'
$logPath = Join-Path $localDir 'lora-train.log'
$datasetPath = Join-Path $localDir 'qwen-lora-dataset.jsonl'

function Write-Status($status, $message, $extra = @{}) {
  New-Item -ItemType Directory -Force -Path $localDir | Out-Null
  $payload = [ordered]@{
    status = $status
    message = $message
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    datasetPath = $datasetPath
    logPath = $logPath
  }
  foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path $localDir | Out-Null

if (-not (Test-Path -LiteralPath $datasetPath)) {
  Write-Status 'no_data' 'No LoRA dataset exists yet.'
  exit 0
}

if (-not (Test-Path -LiteralPath $venvPython)) {
  Write-Status 'blocked' 'LoRA environment missing. Run scripts\setup-lora-env.ps1 first.'
  exit 20
}

$env:HF_HOME = if ($env:PONG_HF_HOME) { $env:PONG_HF_HOME } elseif (Test-Path 'E:\') { 'E:\pong-hf-cache' } else { Join-Path $localDir 'hf-cache' }
$env:TRANSFORMERS_CACHE = $env:HF_HOME
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:PONG_REPO_ROOT = $RepoRoot

Write-Status 'running' 'Starting Qwen LoRA training.'
$output = & $venvPython (Join-Path $PSScriptRoot 'train_qwen_lora.py') --repo-root $RepoRoot 2>&1
$code = $LASTEXITCODE
$output | Tee-Object -FilePath $logPath -Append

if ($code -eq 0) {
  Write-Status 'complete' 'Qwen LoRA training completed.' @{ exitCode = $code }
} else {
  Write-Status 'blocked' "Qwen LoRA training exited with code $code. See lora-train.log." @{ exitCode = $code }
}

exit $code
