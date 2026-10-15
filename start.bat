@echo off
rem Start the MES demo clone on Windows (port 5000, or the port given as the first argument).
rem Does everything itself: installs the npm packages (first run), builds the frontend,
rem downloads ffmpeg into .\ffmpeg (first run, about 100 MB), then runs the server.
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

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
) else (
  py server.py %*
)
