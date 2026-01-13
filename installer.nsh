; PC Nest Speaker - Custom NSIS Installer Script
; Adds Windows Firewall rules for mediamtx.exe to prevent popup on every launch

!macro customInstall
  ; Add inbound firewall rule for mediamtx
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PC Nest Speaker - MediaMTX" dir=in action=allow program="$INSTDIR\resources\mediamtx\mediamtx.exe" enable=yes profile=any'

  ; Add outbound firewall rule for mediamtx
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PC Nest Speaker - MediaMTX Out" dir=out action=allow program="$INSTDIR\resources\mediamtx\mediamtx.exe" enable=yes profile=any'

  ; Add firewall rules for ffmpeg (used for audio streaming)
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PC Nest Speaker - FFmpeg" dir=in action=allow program="$INSTDIR\resources\ffmpeg\ffmpeg.exe" enable=yes profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PC Nest Speaker - FFmpeg Out" dir=out action=allow program="$INSTDIR\resources\ffmpeg\ffmpeg.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  ; Remove all firewall rules on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PC Nest Speaker - MediaMTX"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PC Nest Speaker - MediaMTX Out"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PC Nest Speaker - FFmpeg"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PC Nest Speaker - FFmpeg Out"'
!macroend
