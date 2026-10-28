@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title osu-render: developer report webhook

rem Sets REPORT_WEBHOOK_URL in .env without touching the other settings.
if not exist "scripts\windows\setup.ps1" goto not_extracted
echo Paste the Discord webhook URL the developer gave you. The input stays hidden.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\setup.ps1" -WebhookOnly
set "EXITCODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXITCODE%

:not_extracted
echo osu-render files are missing. Extract the whole zip first
echo (right-click the zip, Extract All), then run set-webhook.bat from the extracted folder.
pause
exit /b 1
