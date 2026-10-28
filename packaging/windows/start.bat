@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title osu-render

if not exist "runtime\node.exe" goto not_extracted
if not exist "dist\src\main.js" goto not_extracted

if exist ".env" goto configured
echo First run: osu-render needs your osu! API credentials.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\setup.ps1"
if not exist ".env" goto setup_failed

:configured
rem Exit code 2 = the configured port is already taken (most likely osu-render is already running).
"runtime\node.exe" -e "try{process.loadEnvFile('.env')}catch{};const s=require('net').createServer();s.once('error',e=>process.exit(e.code==='EADDRINUSE'?2:0));s.listen(Number(process.env.PORT||3030),process.env.HOST||'127.0.0.1',()=>s.close())"
if errorlevel 2 goto port_in_use

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\open-browser.ps1"
echo.
echo osu-render is starting. The browser opens by itself when it is ready.
echo Keep this window open while you use osu-render. Close it or press Ctrl+C to stop.
echo.
"runtime\node.exe" "dist\src\main.js"
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="0" exit /b 0
echo.
echo osu-render stopped with an error, exit code %EXITCODE%.
echo If the text above says EADDRINUSE, another program is using the port. Change PORT in .env.
echo Run doctor.bat to create a diagnostics report you can send for help.
pause
exit /b %EXITCODE%

:port_in_use
echo.
echo The osu-render port is already in use. osu-render is probably already running
echo in another window, so the web page will open now.
echo If it shows something else, change PORT in .env and run start.bat again.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\open-browser.ps1" -Now
pause
exit /b 2

:setup_failed
echo.
echo Setup did not finish, so no .env file was written. Run start.bat again to retry.
pause
exit /b 1

:not_extracted
echo.
echo osu-render files are missing. Extract the whole zip first
echo (right-click the zip, Extract All), then run start.bat from the extracted folder.
pause
exit /b 1
