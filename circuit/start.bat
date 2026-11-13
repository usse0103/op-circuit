@echo off
rem Hydraulic circuit designer (hydraulics/circuit)
rem   1. Create .venv and install requirements on the first run
rem   2. Start the Flask server on port 5010 (skipped if it is already running)
rem   3. Open http://127.0.0.1:5010 in the browser
rem      (skipped when HC_NO_BROWSER is set: the work control panel opens the tab itself)
setlocal
cd /d "%~dp0"
set "PORT=5010"
set "URL=http://127.0.0.1:%PORT%"

if not exist ".venv\Scripts\python.exe" (
  echo Creating .venv and installing requirements...
  python -m venv .venv
  if errorlevel 1 (
    echo [ERROR] Python was not found. Install Python 3.11 or later.
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
)

netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo The server is already running.
) else (
  echo Starting the server...
  start "hydraulics-circuit" /min "%~dp0.venv\Scripts\python.exe" app.py %PORT%
)

rem Wait until the server answers (30 s at most), then open the browser
set /a n=0
:wait
curl.exe -s -o nul "%URL%" && goto open
set /a n+=1
if %n% geq 30 goto open
ping -n 2 127.0.0.1 >nul
goto wait

:open
if defined HC_NO_BROWSER goto done
start "" "%URL%"
echo Opened %URL%  -  close the "hydraulics-circuit" window to stop the server.
ping -n 4 127.0.0.1 >nul
:done
endlocal
