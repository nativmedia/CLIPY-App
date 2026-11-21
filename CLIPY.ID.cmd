@echo off
setlocal
title CLIPY.ID
rem Checks GitHub for updates, restarts the local servers when their code changed, then opens the app.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-clipy.ps1" -Repo "%~dp0."
if errorlevel 1 pause
endlocal
