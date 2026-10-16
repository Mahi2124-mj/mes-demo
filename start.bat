@echo off
rem Start the MES demo clone on Windows (port 5000, or the port given as the first argument).
rem Does everything itself: installs the npm packages (first run), builds the frontend,
rem downloads ffmpeg into .\ffmpeg (first run, about 100 MB), opens the port in Windows Firewall
rem (first run, as Administrator), then runs the server.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing npm packages...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Building the frontend...
call npx vite build
if errorlevel 1 exit /b 1

if exist ffmpeg\bin\ffmpeg.exe goto ffmpeg_ok
where ffmpeg >nul 2>nul
if %errorlevel%==0 goto ffmpeg_ok
echo Downloading ffmpeg, about 100 MB, one time only...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile ffmpeg.zip; Expand-Archive ffmpeg.zip -DestinationPath ffmpeg-tmp -Force; Move-Item (Get-ChildItem ffmpeg-tmp)[0].FullName ffmpeg; Remove-Item ffmpeg.zip, ffmpeg-tmp -Recurse -Force"
if not exist ffmpeg\bin\ffmpeg.exe echo ffmpeg download failed: the live preview uses camera snapshots and no cycle clips are recorded.
:ffmpeg_ok

rem Let other PCs on the LAN open the dashboard: allow the port in Windows Firewall (one time, needs Administrator).
set "PORT=%~1"
if "%PORT%"=="" set "PORT=5000"
netsh advfirewall firewall show rule name="MES demo %PORT%" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="MES demo %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>nul
  if errorlevel 1 (
    echo NOTE: could not open port %PORT% in Windows Firewall ^(run this window as Administrator once^).
    echo       Other PCs on the LAN cannot open the dashboard until the port is allowed.
  ) else (
    echo Windows Firewall: port %PORT% opened for other PCs on the LAN.
  )
)

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
) else (
  py server.py %*
)
