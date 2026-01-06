@echo off
title PC Nest Speaker - Direct WebRTC Test
cd /d "%~dp0"

:: Auto-detect local IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address" ^| findstr "192.168."') do (
    set LOCAL_IP=%%a
    goto :found_ip
)
:found_ip
:: Trim spaces
set LOCAL_IP=%LOCAL_IP: =%

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
