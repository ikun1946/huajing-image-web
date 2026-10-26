@echo off
cd /d "%~dp0"
title Huajing Server
node "scripts/launch-server.mjs" %*
if errorlevel 1 (
  echo.
  echo [Failed] Startup did not complete. See the message above.
  pause
)