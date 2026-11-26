@echo off
chcp 65001 >nul
title Reel Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required: https://nodejs.org/
  start https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo First launch: installing ^(npm run setup^)...
  call npm run setup
  if errorlevel 1 (
    echo Setup failed.
    pause
    exit /b 1
  )
)
start "" http://127.0.0.1:4301/
node server.mjs
pause
