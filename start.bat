@echo off
REM One-click launcher for Windows. Double-click this file to run.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org (v18+).
  pause
  exit /b 1
)

if "%DATA_DIR%"=="" set DATA_DIR=.\data

REM First run: offer to pick a durable local domain for this instance.
if not exist "%DATA_DIR%\instance.json" if "%PORT%"=="" (
  set /p NAME="Pick a durable local domain for this instance [meeting-notes]: "
  if "%NAME%"=="" set NAME=meeting-notes
  node server.js --set-domain "%NAME%"
)

echo Starting Daymark...
REM Extra args (e.g. --port 8080) are forwarded to the server.
node server.js --print-config %*
node server.js %*
pause
