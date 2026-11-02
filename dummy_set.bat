@echo off
rem Prepare the dummy shift for MANAGEMENT-2 from "..\ok video" and "..\ng video" (dummy_set.py) and switch it on.
rem Default: tomorrow's shift A, shown as at 10:00, target 15.4 s. Other values, for example:
rem   dummy_set.bat --date 2026-11-03 --shift A --at 10:00 --target 15.4
rem The server can keep running; the open dashboard picks it up by itself.
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul
if not %errorlevel%==0 set "PY=py"
%PY% dummy_set.py %*
if errorlevel 1 echo The dummy shift was NOT changed.
pause
