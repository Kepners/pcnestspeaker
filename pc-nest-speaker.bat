@echo off
setlocal enabledelayedexpansion
title PC Nest Speaker
cd /d "%~dp0"
color 0F

:menu
cls
echo.
echo   ╔══════════════════════════════════════════════════════════════╗
echo   ║            PC NEST SPEAKER - WebRTC Audio Streaming          ║
echo   ║              Sub-second latency to Google Nest!              ║
echo   ╚══════════════════════════════════════════════════════════════╝
echo.
echo   [1] Start Streaming (full pipeline)
echo   [2] Cast to Speaker (after pipeline is running)
echo   [3] Stop All Services
echo   [4] Show Available Speakers
echo   [5] Open Dashboard (HTA app)
echo   [6] Exit
echo.
set /p choice="   Enter choice (1-6): "

if "%choice%"=="1" goto start_pipeline
if "%choice%"=="2" goto cast_menu
if "%choice%"=="3" goto stop_all
if "%choice%"=="4" goto show_speakers
if "%choice%"=="5" goto open_dashboard
if "%choice%"=="6" exit
goto menu

:start_pipeline
cls
echo.
echo   Starting PC Nest Speaker Pipeline...
echo   ════════════════════════════════════
echo.

:: Kill existing processes
echo   [CLEANUP] Stopping old processes...
taskkill /F /IM mediamtx.exe 2>nul
taskkill /F /IM ffmpeg.exe 2>nul
taskkill /F /IM cloudflared.exe 2>nul
timeout /t 1 /nobreak >nul
echo   [OK] Cleanup complete
echo.

:: Start MediaMTX
echo   [1/3] Starting MediaMTX...
start /b /min "" "mediamtx\mediamtx.exe" "mediamtx\mediamtx-audio.yml"
timeout /t 2 /nobreak >nul
echo   [OK] MediaMTX running (RTSP:8554, WebRTC:8889)
echo.

:: Start FFmpeg
echo   [2/3] Starting FFmpeg audio capture...
start /b /min "" ffmpeg -hide_banner -loglevel error -f dshow -i "audio=virtual-audio-capturer" -c:a libopus -b:a 128k -ar 48000 -ac 2 -f rtsp -rtsp_transport tcp rtsp://localhost:8554/pcaudio
timeout /t 2 /nobreak >nul
echo   [OK] FFmpeg streaming Opus audio
echo.

:: Start Cloudflared and capture URL
echo   [3/3] Starting Cloudflare tunnel...
echo   [....] Waiting for tunnel URL (takes ~5 seconds)...

:: Create temp file to capture URL
set "TUNNEL_URL="
set "TEMP_FILE=%TEMP%\cloudflared_output.txt"

:: Start cloudflared in background, redirect stderr to file
start /b "" cmd /c "cloudflared tunnel --url http://localhost:8889 2>&1 | findstr /C:trycloudflare.com > "%TEMP_FILE%""

:: Wait and poll for URL
for /L %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    if exist "%TEMP_FILE%" (
        for /f "tokens=*" %%a in ('type "%TEMP_FILE%" 2^>nul ^| findstr "https://"') do (
            for %%b in (%%a) do (
                echo %%b | findstr "trycloudflare.com" >nul && set "TUNNEL_URL=%%b"
            )
        )
    )
    if defined TUNNEL_URL goto got_url
)

:got_url
if not defined TUNNEL_URL (
    echo   [WARN] Could not capture URL - check cloudflared window
    set "TUNNEL_URL=CHECK_CLOUDFLARED_WINDOW"
)

:: Save URL to file for other scripts
echo %TUNNEL_URL% > "%~dp0tunnel_url.txt"

echo.
echo   ╔══════════════════════════════════════════════════════════════╗
echo   ║                    PIPELINE READY!                           ║
echo   ╚══════════════════════════════════════════════════════════════╝
echo.
echo   Tunnel URL: %TUNNEL_URL%
echo.
echo   The URL has been saved to tunnel_url.txt
echo.
pause
goto menu

:cast_menu
cls
echo.
echo   Cast to Speaker
echo   ════════════════
echo.

:: Read saved tunnel URL
set "TUNNEL_URL="
if exist "%~dp0tunnel_url.txt" (
    set /p TUNNEL_URL=<"%~dp0tunnel_url.txt"
)

if not defined TUNNEL_URL (
    echo   [ERROR] No tunnel URL found. Start the pipeline first!
    echo.
    pause
    goto menu
)

echo   Current Tunnel: %TUNNEL_URL%
echo.
echo   Available Speakers:
echo   -------------------
python src/main/cast-helper.py discover
echo.
set /p speaker="   Enter speaker name (e.g., Den pair): "

if "%speaker%"=="" goto menu

echo.
echo   Casting to "%speaker%"...
python src/main/cast-helper.py webrtc-launch "%speaker%" "%TUNNEL_URL%"
echo.
pause
goto menu

:stop_all
cls
echo.
echo   Stopping all services...
taskkill /F /IM mediamtx.exe 2>nul
taskkill /F /IM ffmpeg.exe 2>nul
taskkill /F /IM cloudflared.exe 2>nul
del "%~dp0tunnel_url.txt" 2>nul
echo   [OK] All services stopped
echo.
pause
goto menu

:show_speakers
cls
echo.
echo   Discovering Speakers...
echo   ════════════════════════
echo.
python src/main/cast-helper.py discover
echo.
pause
goto menu

:open_dashboard
start "" "%~dp0dashboard.hta"
goto menu
