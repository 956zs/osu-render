@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title osu-render

if not exist "runtime\node.exe" goto not_extracted
if not exist "dist\src\main.js" goto not_extracted

rem Notepad and hidden file extensions often produce .env.txt instead of .env; osu-render only reads .env.
for %%F in (".env.txt" ".env.env" "env" "env.txt" ".env.example.txt") do if exist "%%~F" echo WARNING: Found %%~F - Windows hid the extension. Rename it to .env, osu-render ignores it.

if exist ".env" goto configured
echo First run: osu-render needs your osu! API credentials.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\setup.ps1"
if not exist ".env" goto setup_failed

:configured
rem Tells osu-render that start.bat installs updates when it exits with code 75.
set "OSU_RENDER_LAUNCHER=start.bat"
set "PORT_TRIES=0"

:port_check
rem Exit code 2 = the configured port is already taken (most likely osu-render is already running).
"runtime\node.exe" -e "try{process.loadEnvFile('.env')}catch{};const s=require('net').createServer();s.once('error',e=>process.exit(e.code==='EADDRINUSE'?2:0));s.listen(Number(process.env.PORT||3030),process.env.HOST||'127.0.0.1',()=>s.close())"
if not errorlevel 2 goto port_free
rem Right after an update the old server may still be releasing the port, so wait a little.
if /i not "%~1"=="--updated" goto port_in_use
set /a PORT_TRIES+=1
if %PORT_TRIES% geq 15 goto port_in_use
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
goto port_check

:port_free
rem After an update the web page that started it reloads by itself, so no new browser tab.
if /i not "%~1"=="--updated" start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\open-browser.ps1"
echo.
echo osu-render is starting. The browser opens by itself when it is ready.
echo Keep this window open while you use osu-render. Close it or press Ctrl+C to stop.
echo.
"runtime\node.exe" "dist\src\main.js"
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="0" exit /b 0
rem Exit code 75 = an update was downloaded and verified. cmd reads the whole ( ) block before running it, so the
rem block keeps working after apply-update.ps1 replaces this file, and then hands over to the (new) start.bat.
rem If installing fails, apply-update.ps1 restores the previous files and the old version starts again.
if "%EXITCODE%"=="75" (
  echo.
  echo Installing the update. Do not close this window.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\apply-update.ps1"
  "%~f0" --updated
)
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
