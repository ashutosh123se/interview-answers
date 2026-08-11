@echo off
cd /d "%~dp0"

echo.
echo  Interview Assistant - Setup
echo.

if not exist .env (
    copy .env.example .env >nul
    echo  Created .env file - open it and paste your OpenAI API key.
) else (
    echo  .env already exists.
)

python -m pip install -r requirements.txt -q

echo.
echo  Setup done. Run start.bat to launch the server.
echo.
pause
