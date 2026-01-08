' PC Nest Speaker - Silent Launcher
' Double-click this to start the app with NO console window

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get the folder where this script is located
strFolder = fso.GetParentFolderName(WScript.ScriptFullName)

' Run the batch file invisibly (0 = hidden, False = don't wait)
WshShell.Run Chr(34) & strFolder & "\start-app.bat" & Chr(34), 0, False
