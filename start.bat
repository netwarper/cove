@echo off
REM One-click launcher for Windows. Double-click this file to run.
REM
REM Starts Cove as a DETACHED background server (via scripts\cove.js) so it keeps
REM running after you close this window. It waits until the server is answering,
REM opens your browser, and prints the URL. Stop it later with stop.bat.
REM
REM Extra args (e.g. --port 8080) are forwarded. DATA_DIR / PORT are read from a
REM local .env if present.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org ^(v18+^).
  pause
  exit /b 1
)

node "%~dp0scripts\cove.js" start %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
