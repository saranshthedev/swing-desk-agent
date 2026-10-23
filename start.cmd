@echo off
rem Swing Desk Agent - start the app and open it in your browser. Double-click this file.
rem Keep the window open while you use the app. Close it (or press Ctrl + C) to stop.
setlocal
cd /d "%~dp0"
title Swing Desk - keep this window open

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Double-click setup.cmd first.
  pause
  exit /b 1
)

node "%~dp0bin\desk.js" start --open
if errorlevel 1 pause
