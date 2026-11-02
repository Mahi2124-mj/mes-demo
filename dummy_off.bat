@echo off
rem MANAGEMENT-2: back to the live PLC data and the real clock (the dummy shift is kept for dummy_on.bat).
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul
if not %errorlevel%==0 set "PY=py"
%PY% -c "import json,os;p='data/dummy/dummy.json';d=json.load(open(p)) if os.path.exists(p) else {};d['enabled']=False;json.dump(d,open(p,'w'));print('Dummy shift off: MANAGEMENT-2 shows the live data.')"
