@echo off
REM One-click launcher for Windows. Double-click this file to run.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org (v18+).
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3000
echo Starting Meeting Notes at http://127.0.0.1:%PORT%
start "" http://127.0.0.1:%PORT%
node server.js
pause
