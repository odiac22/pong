$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repo '.pong-local-ai\lora-venv\Scripts\python.exe'
$service = Join-Path $PSScriptRoot 'preference_ai_service.py'

if (-not (Test-Path $venvPython)) {
  & (Join-Path $PSScriptRoot 'setup-lora-env.ps1') -RepoRoot $repo
}

if (-not (Test-Path $venvPython)) {
  throw 'The Pong local AI Python environment could not be created.'
}

& $venvPython -c 'import ultralytics' 2>$null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $PSScriptRoot 'setup-preference-ai.ps1')
}

& $venvPython $service
