@echo off
REM Stop the running Cove server (via scripts\cove.js): a graceful terminate,
REM then a forced kill only if it won't exit, plus a tidy-up of the lock file.
REM DATA_DIR is read from a local .env if present.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org ^(v18+^).
  pause
  exit /b 1
)

node "%~dp0scripts\cove.js" stop
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
