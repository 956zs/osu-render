@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title osu-render doctor

if not exist "runtime\node.exe" goto not_extracted
echo Checking danser, ffmpeg, GPU and video encoders. This takes up to a minute...
echo.
"runtime\node.exe" "dist\src\doctor.js"
echo.
echo The report above was also saved in the data\diagnostics folder, which opens now.
echo Attach the newest doctor-*.json file when asking for help, or use the link above
echo to open a GitHub issue. Your client secret is never included and your user name is masked.
if exist "data\diagnostics" start "" explorer "%CD%\data\diagnostics"
pause
exit /b 0

:not_extracted
echo osu-render files are missing. Extract the whole zip first
echo (right-click the zip, Extract All), then run doctor.bat from the extracted folder.
pause
exit /b 1
