@echo off
rem Swing Desk Agent - first-time setup. Double-click this file.
setlocal
cd /d "%~dp0"
title Swing Desk setup

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed yet. It is free.
  echo Opening the download page now. Install version 24,
  echo then double-click setup.cmd again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

node "%~dp0bin\desk.js" setup
echo.
pause
