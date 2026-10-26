@echo off
cd /d "%~dp0"
title Stop Huajing Server
echo Stopping Huajing server on port 8787...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do (
  taskkill /f /pid %%p >nul 2>&1
)
echo Done. Port 8787 released.