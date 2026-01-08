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

echo [1/2] Starting MediaMTX...
start /b /min "" "mediamtx\mediamtx.exe" "mediamtx\mediamtx-audio.yml"
timeout /t 3 /nobreak >nul
echo [OK] MediaMTX running

echo.
echo [2/2] Starting FFmpeg stereo split (SINGLE capture, DUAL output)...
:: CRITICAL: DirectShow can only be opened ONCE!
:: Use filter_complex to split L/R and output to two RTSP streams
start /b /min "" ffmpeg -hide_banner -loglevel error -f dshow -i "audio=virtual-audio-capturer" -filter_complex "[0:a]pan=mono|c0=c0[left];[0:a]pan=mono|c0=c1[right]" -map "[left]" -c:a libopus -b:a 128k -ar 48000 -ac 1 -f rtsp -rtsp_transport tcp rtsp://localhost:8554/left -map "[right]" -c:a libopus -b:a 128k -ar 48000 -ac 1 -f rtsp -rtsp_transport tcp rtsp://localhost:8554/right
timeout /t 3 /nobreak >nul
echo [OK] Left + Right channels streaming

echo.
echo =========================================
echo  READY! Now cast to speakers:
echo =========================================
echo.
echo python src/main/cast-helper.py webrtc-launch "Left speaker" "http://%LOCAL_IP%:8889" "" "left"
echo python src/main/cast-helper.py webrtc-launch "Right speaker" "http://%LOCAL_IP%:8889" "" "right"
echo.
echo (Note: empty string "" for speaker_ip, "left"/"right" for stream name)
echo.
pause
