@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing local AI dependencies...
  npm install
)
echo Starting Pong local AI on http://127.0.0.1:8787
start "" /min ollama serve
npm run local-ai
