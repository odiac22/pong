param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$localDir = Join-Path $RepoRoot '.pong-local-ai'
$venvPython = Join-Path $localDir 'lora-venv\Scripts\python.exe'
$statusPath = Join-Path $localDir 'lora-inference-status.json'
$logPath = Join-Path $localDir 'lora-inference.log'

function Write-Status($status, $message, $extra = @{}) {
  New-Item -ItemType Directory -Force -Path $localDir | Out-Null
  $payload = [ordered]@{
    status = $status
    message = $message
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    logPath = $logPath
  }
  foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $venvPython)) {
  Write-Status 'blocked' 'LoRA environment missing. Run scripts\setup-lora-env.ps1 first.'
  exit 20
}

$env:HF_HOME = if ($env:PONG_HF_HOME) { $env:PONG_HF_HOME } elseif (Test-Path 'E:\') { 'E:\pong-hf-cache' } else { Join-Path $localDir 'hf-cache' }
$env:TRANSFORMERS_CACHE = $env:HF_HOME
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:PONG_REPO_ROOT = $RepoRoot

Write-Status 'starting' 'Starting Qwen LoRA inference service.'
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $venvPython (Join-Path $PSScriptRoot 'lora_inference_server.py') --repo-root $RepoRoot 2>&1 | Tee-Object -FilePath $logPath -Append
$code = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
Write-Status 'stopped' "Qwen LoRA inference service stopped with code $code." @{ exitCode = $code }
exit $code
