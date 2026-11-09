@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Ilk kurulum yapiliyor...
  python -m venv .venv || goto :error
  .venv\Scripts\python.exe -m pip install -r requirements.txt || goto :error
)
start "" http://localhost:8765
.venv\Scripts\python.exe -m server.app
goto :eof

:error
echo Kurulum basarisiz. Python 3.10+ kurulu oldugundan emin olun.
pause
