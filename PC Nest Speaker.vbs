' PC Nest Speaker - Silent Launcher
' This VBS script launches the app with absolutely NO console window

Set WshShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Change to project directory and launch Electron invisibly
' 0 = Hidden window, False = Don't wait for completion
WshShell.CurrentDirectory = strPath
WshShell.Run "cmd /c set ELECTRON_RUN_AS_NODE= && npx electron . --dev", 0, False
