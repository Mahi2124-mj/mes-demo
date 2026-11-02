@echo off
rem Show the 50-cycle demo set on MANAGEMENT-2 in the current shift, then start the server.
rem Stops the server, moves the live data to data\live\backup_<time>\, stages the set (demo_set.py),
rem and runs start.bat. Run it again whenever the shift has changed.
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5000"

call "%~dp0stop.bat" %PORT%
if errorlevel 1 goto failed
rem give Windows a moment to release the port and the files
ping -n 3 127.0.0.1 >nul

where python >nul 2>nul
if %errorlevel%==0 (
  python demo_set.py %PORT%
) else (
  py demo_set.py %PORT%
)
if errorlevel 1 goto failed

call "%~dp0start.bat" %PORT%
exit /b

:failed
echo.
echo The demo set was NOT staged and the server was NOT started.
pause
exit /b 1
