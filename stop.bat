@echo off
rem Stop the MES demo clone on Windows (port 5000, or the port given as the first argument).
rem Stops only the program listening on that port, together with its ffmpeg (camera) processes.
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5000"

set "FOUND="
set "FAILED="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    set "FOUND=1"
    taskkill /PID %%p /T /F >nul 2>nul && (
      echo Stopped the MES demo ^(pid %%p^) on port %PORT%.
    ) || (
      tasklist /FI "PID eq %%p" 2>nul | findstr /r /c:" %%p " >nul && (
        set "FAILED=1"
        echo Could not stop pid %%p on port %PORT%: run this window as Administrator.
      )
    )
  )
)
if not defined FOUND echo Not running on port %PORT%.
if defined FAILED exit /b 1
exit /b 0
