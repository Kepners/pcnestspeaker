@echo off
:: Clear the env var that breaks Electron when run from Claude Code
set ELECTRON_RUN_AS_NODE=

:: Change to the project directory
cd /d "%~dp0"

:: Launch Electron in the background WITHOUT a console window
:: The /B flag runs the command without creating a new window
start "" /B npx electron . --dev

:: Exit immediately (don't keep CMD window open)
exit
