@echo off
rem MANAGEMENT-2 / SUPERVISOR: show the dummy line from dummy_set.bat again (live on the real clock, or held).
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul
if not %errorlevel%==0 set "PY=py"
%PY% -c "import json,sys;p='data/dummy/dummy.json';d=json.load(open(p));d['enabled']=True;json.dump(d,open(p,'w'));print('Dummy on:', 'live on the real clock' if d.get('live') else 'clock held at '+str(d.get('now')))" || echo No dummy shift yet: run dummy_set.bat first.
