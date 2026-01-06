@echo off
:: Stop all PC Nest Speaker processes
echo Stopping PC Nest Speaker...
taskkill /F /IM mediamtx.exe 2>nul
taskkill /F /IM ffmpeg.exe 2>nul
taskkill /F /IM cloudflared.exe 2>nul
echo Done!
