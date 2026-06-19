@echo off
REM ============================================================================
REM  Swim Gala Timing System - Windows launcher
REM  Double-click this file to start the server and open the dashboard.
REM
REM  EDIT THE LINE BELOW: set DOLPHIN_DIR to Sport Systems' Colorado Dolphin
REM  folder (SS -> Tools -> Support File Locations -> "Colorado Dolphin Database
REM  Directory"). Each finalised heat is written there as a .do3 SS can capture.
REM  Leave it commented out to just export into the local .\exports folder.
REM ============================================================================

set "DOLPHIN_DIR=C:\MeetOrg53\MeetSupport"

REM --- you shouldn't need to change anything below this line ---
cd /d "%~dp0"

echo ============================================================
echo   Swim Gala Timing System
echo   Dashboard:        http://localhost:8000
echo   Phone remote:     http://localhost:8000/remote
echo   Dolphin export -^> %DOLPHIN_DIR%
echo ============================================================
echo.

REM Open the dashboard a few seconds after the server starts (runs in parallel).
start "" cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:8000"

REM Start the server (this window stays open and shows the log).
call npm start

echo.
echo Server stopped. Close this window, or press a key to exit.
pause >nul
