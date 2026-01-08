@echo off
setlocal enabledelayedexpansion
title PC Nest Speaker - Direct WebRTC Test
cd /d "%~dp0"

:: Auto-detect local IP (supports 192.168.x, 10.x, 172.16-31.x)
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set "TEMP_IP=%%a"
    set "TEMP_IP=!TEMP_IP: =!"
    echo !TEMP_IP! | findstr /r "^192\.168\. ^10\. ^172\.1[6-9]\. ^172\.2[0-9]\. ^172\.3[0-1]\." >nul && (
        set LOCAL_IP=!TEMP_IP!
        goto :found_ip
    )
)
:found_ip
if not defined LOCAL_IP set LOCAL_IP=localhost

echo =========================================
echo  PC Nest Speaker - Direct Pipeline Test
echo =========================================
echo.
echo Your local IP: %LOCAL_IP%
echo MediaMTX WebRTC: http://%LOCAL_IP%:8889
echo.

:: Kill old processes
taskkill /F /IM mediamtx.exe 2>nul
taskkill /F /IM ffmpeg.exe 2>nul
timeout /t 1 /nobreak >nul

echo [1/2] Starting MediaMTX...
start /b /min "" "mediamtx\mediamtx.exe" "mediamtx\mediamtx-audio.yml"
timeout /t 3 /nobreak >nul
echo [OK] MediaMTX running on port 8889
echo.

echo [2/2] Starting FFmpeg audio capture...
start /b /min "" ffmpeg -hide_banner -loglevel error -f dshow -i "audio=virtual-audio-capturer" -c:a libopus -b:a 128k -ar 48000 -ac 2 -f rtsp -rtsp_transport tcp rtsp://localhost:8554/pcaudio
timeout /t 2 /nobreak >nul
echo [OK] FFmpeg streaming to MediaMTX
echo.

echo =========================================
echo  Pipeline Ready!
echo =========================================
echo.
echo Now cast to your speaker using:
echo   python src/main/cast-helper.py webrtc-launch "Green TV" "http://%LOCAL_IP%:8889"
echo.
echo Or run discovery:
echo   python src/main/cast-helper.py discover
echo.
pause
