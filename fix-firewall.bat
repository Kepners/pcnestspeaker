@echo off
echo ============================================
echo   PC Nest Speaker - Firewall Fix
echo ============================================
echo.
echo This will add firewall rules for WebRTC streaming.
echo Requires Administrator privileges.
echo.
pause

netsh advfirewall firewall add rule name="MediaMTX WebRTC UDP" dir=in action=allow protocol=UDP localport=8189
netsh advfirewall firewall add rule name="MediaMTX WebRTC TCP" dir=in action=allow protocol=TCP localport=8189
netsh advfirewall firewall add rule name="MediaMTX HTTP" dir=in action=allow protocol=TCP localport=8889
netsh advfirewall firewall add rule name="MediaMTX RTSP" dir=in action=allow protocol=TCP localport=8554

echo.
echo ============================================
echo   Firewall rules added successfully!
echo ============================================
echo.
echo Now restart MediaMTX and try WebRTC casting again.
pause
