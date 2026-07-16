param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$localDir = Join-Path $RepoRoot '.pong-local-ai'
$venvDir = Join-Path $localDir 'lora-venv'
$pythonExe = Join-Path $venvDir 'Scripts\python.exe'
$statusPath = Join-Path $localDir 'finetune-status.json'

function Write-Status($status, $message) {
  New-Item -ItemType Directory -Force -Path $localDir | Out-Null
  [ordered]@{
    status = $status
    message = $message
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

Write-Status 'setup' 'Preparing Python 3.11 LoRA environment.'

$py311 = $null
try {
  $py311 = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null)
} catch {}

if (-not $py311) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Status 'blocked' 'Python 3.11 is missing and winget is not available.'
    throw 'Python 3.11 is missing and winget is not available.'
  }
  winget install --id Python.Python.3.11 -e --silent --accept-source-agreements --accept-package-agreements
  $py311 = (& py -3.11 -c "import sys; print(sys.executable)" 2>$null)
}

if (-not (Test-Path -LiteralPath $pythonExe)) {
  & py -3.11 -m venv $venvDir
}

& $pythonExe -m pip install --upgrade pip setuptools wheel
& $pythonExe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
& $pythonExe -m pip install "git+https://github.com/huggingface/transformers" accelerate peft pillow qwen-vl-utils datasets safetensors

Write-Status 'ready' 'LoRA Python environment is ready.'
