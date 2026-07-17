@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing local AI dependencies...
  npm install
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  echo Stopping existing Pong local AI server on port 8787 ^(PID %%P^)...
  taskkill /PID %%P /F >nul 2>nul
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8790" ^| findstr "LISTENING"') do (
  echo Stopping existing Pong LoRA inference server on port 8790 ^(PID %%P^)...
  taskkill /PID %%P /F >nul 2>nul
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8791" ^| findstr "LISTENING"') do (
  echo Stopping existing Pong preference AI server on port 8791 ^(PID %%P^)...
  taskkill /PID %%P /F >nul 2>nul
)
echo Starting Pong local AI on http://127.0.0.1:8787
set "PONG_LORA_PRELOAD=0"
set "PONG_LORA_AUTOTRAIN=0"
start "" /min ollama serve
echo Starting personal face/body preference service on http://127.0.0.1:8791
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-preference-ai.ps1"
npm run local-ai
