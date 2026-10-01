$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root 'runtime\venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Pong Swap environment is missing: $python"
}

Set-Location -LiteralPath $root
& $python -m uvicorn pong_swap_service:app --host 127.0.0.1 --port 8792

