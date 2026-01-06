@echo off
:: Quick cast to a speaker - run after start-app.bat
:: Usage: cast-to-speaker.bat "Den pair" "https://xxx.trycloudflare.com"

cd /d "%~dp0"

if "%~1"=="" (
    echo Usage: cast-to-speaker.bat "Speaker Name" "Tunnel URL"
    echo.
    echo Available speakers:
    python src/main/cast-helper.py discover
    exit /b 1
)

if "%~2"=="" (
    echo Error: Missing tunnel URL
    echo Usage: cast-to-speaker.bat "Speaker Name" "Tunnel URL"
    exit /b 1
)

echo Casting to %~1...
python src/main/cast-helper.py webrtc-launch "%~1" "%~2"
