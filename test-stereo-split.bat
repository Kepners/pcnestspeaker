@echo off
setlocal enabledelayedexpansion
title PC Nest Speaker - Stereo Channel Separation Test
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
echo  STEREO CHANNEL SEPARATION TEST
echo =========================================
echo.
echo Local IP: %LOCAL_IP%
echo Left channel: http://%LOCAL_IP%:8889/left
echo Right channel: http://%LOCAL_IP%:8889/right
echo.

:: Kill old processes
taskkill /F /IM mediamtx.exe 2>nul
taskkill /F /IM ffmpeg.exe 2>nul
timeout /t 1 /nobreak >nul

echo [1/3] Starting MediaMTX...
start /b /min "" "mediamtx\mediamtx.exe" "mediamtx\mediamtx-audio.yml"
timeout /t 3 /nobreak >nul
echo [OK] MediaMTX running

echo.
echo [2/3] Starting FFmpeg LEFT channel...
start /b /min "" ffmpeg -hide_banner -loglevel error -f dshow -i "audio=virtual-audio-capturer" -af "pan=mono|c0=c0" -c:a libopus -b:a 128k -ar 48000 -ac 1 -f rtsp -rtsp_transport tcp rtsp://localhost:8554/left
timeout /t 2 /nobreak >nul
echo [OK] Left channel streaming

echo.
echo [3/3] Starting FFmpeg RIGHT channel...
start /b /min "" ffmpeg -hide_banner -loglevel error -f dshow -i "audio=virtual-audio-capturer" -af "pan=mono|c0=c1" -c:a libopus -b:a 128k -ar 48000 -ac 1 -f rtsp -rtsp_transport tcp rtsp://localhost:8554/right
timeout /t 2 /nobreak >nul
echo [OK] Right channel streaming

echo.
echo =========================================
echo  READY! Now cast to speakers:
echo =========================================
echo.
echo python src/main/cast-helper.py webrtc-launch "Left" "http://%LOCAL_IP%:8889" "" "left"
echo python src/main/cast-helper.py webrtc-launch "Right speaker" "http://%LOCAL_IP%:8889" "" "right"
echo.
echo (Note: empty string "" for speaker_ip, "left"/"right" for stream name)
echo.
pause
