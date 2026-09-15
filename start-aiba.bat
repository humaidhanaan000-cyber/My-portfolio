@echo off
REM ===========================================================================
REM  AIBA - one-click start for Windows
REM
REM  Double-click this file. It will:
REM    1. check that Node.js is installed
REM    2. create .env from .env.example the first time (with a random AUTH_SECRET)
REM    3. install dependencies the first time
REM    4. start the web app together with the agents in its own window
REM    5. wait until the server answers, then open your browser
REM
REM  Leave the "AIBA server" window open while you use the app.
REM  Close it (or press Ctrl+C in it) to stop AIBA.
REM ===========================================================================
setlocal EnableExtensions
title AIBA launcher
cd /d "%~dp0"

set "PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" set "PORT=%%B"
  )
)
set "URL=http://localhost:%PORT%"

echo.
echo  ============================================
echo   AIBA - Autonomous Internet Business Agent
echo  ============================================
echo.

REM ---------------------------------------------------------------- 1. Node
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js was not found.
  echo.
  echo      Install Node.js 22 or newer from https://nodejs.org
  echo      then double-click this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%V in ('node -v') do echo  [1/5] Node.js %%V

REM ----------------------------------------------------- 2. Already running?
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',%PORT%) ; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo  [i] AIBA is already running - opening %URL%
  start "" "%URL%"
  echo.
  echo      Nothing else to do. Close this window.
  timeout /t 4 >nul
  exit /b 0
)

REM ------------------------------------------------------------------ 3. env
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  [2/5] Created .env from .env.example
  powershell -NoProfile -Command ^
    "$secret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) });" ^
    "(Get-Content -Raw .env) -replace 'AUTH_SECRET=.*', ('AUTH_SECRET=' + $secret) | Set-Content -NoNewline .env"
  echo        generated a random AUTH_SECRET
) else (
  echo  [2/5] Using the existing .env
)

REM -------------------------------------------------------------- 4. install
if not exist "node_modules\" (
  echo  [3/5] Installing dependencies ^(first run, a few minutes^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [X] npm install failed. Scroll up for the reason.
    pause
    exit /b 1
  )
) else (
  echo  [3/5] Dependencies already installed
)

REM ----------------------------------------------------------------- 5. start
echo  [4/5] Starting the web app and the agents...
start "AIBA server" cmd /k "npm run agent"

echo  [5/5] Waiting for %URL% ...
powershell -NoProfile -Command ^
  "for ($i=0; $i -lt 90; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%URL%/api/health'; if ($r.StatusCode -eq 200) { Start-Process '%URL%'; exit 0 } } catch { Start-Sleep -Seconds 2 } }; Start-Process '%URL%'"

echo.
echo  Browser opened at %URL%
echo.
echo  Useful pages:
echo    %URL%/dashboard        command centre
echo    %URL%/dashboard/approvals   approve or reject what the agents propose
echo    %URL%/dashboard/revenue     money in
echo    %URL%/api-docs         REST API reference
echo.
echo  To stop AIBA: close the "AIBA server" window.
echo.
pause
endlocal
