@echo off
cd /d "%~dp0"

if not exist .env (
    echo.
    echo  ERROR: .env file missing.
    echo  Run setup.bat first, then add your OpenAI API key to .env
    echo.
    pause
    exit /b 1
)

python -m pip install -r requirements.txt -q 2>nul
python server.py
