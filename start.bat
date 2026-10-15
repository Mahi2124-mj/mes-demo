@echo off
rem Start the MES demo clone on Windows (port 5000, or the port given as the first argument).
cd /d "%~dp0"
if not exist dist\index.html (
  echo Building the frontend...
  call npx vite build || exit /b 1
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
) else (
  py server.py %*
)
