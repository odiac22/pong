$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repo '.pong-local-ai\lora-venv\Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
  throw 'The Pong local AI Python environment is missing. Run scripts\setup-lora-env.ps1 first.'
}

& $venvPython -m pip install --upgrade 'ultralytics>=8.3,<9' 'gallery-dl==1.32.2'
if ($LASTEXITCODE -ne 0) { throw 'Could not install preference AI dependencies.' }

Write-Host 'Pong preference AI dependencies are ready.'
