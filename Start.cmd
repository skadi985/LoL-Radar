@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
where py.exe >nul 2>nul
if not errorlevel 1 (
  py -3 "%~dp0radar_server.py" %*
) else (
  python "%~dp0radar_server.py" %*
)
if errorlevel 1 pause
