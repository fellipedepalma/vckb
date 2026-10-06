@echo off
rem Double-click to start VCKB with YOUR boards (the folder in %USERPROFILE%\.vckb\config.json):
rem builds it, starts it on 127.0.0.1 and opens the browser. Close this window (or press Ctrl+C) to stop.
rem Settings, token and log live in %USERPROFILE%\.vckb, never in this repository.
cd /d "%~dp0"
title VCKB

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install Node.js 22.12 or newer from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(npm ci^), only needed the first time...
  call npm ci
  if errorlevel 1 (
    echo.
    echo npm ci failed. See the messages above.
    pause
    exit /b 1
  )
)

call npm run start:local -- %*
echo.
pause
