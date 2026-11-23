@echo off
setlocal
echo Persiapan CLIPY.ID
echo.
echo [1] Cek prasyarat
echo [2] Cek dan pasang dependensi aplikasi
echo [3] Keluar
choice /c 123 /n /m "Pilih 1, 2, atau 3: "
if errorlevel 3 exit /b 0
if errorlevel 2 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare.ps1" -Setup
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare.ps1"
)
set "result=%errorlevel%"
echo.
pause
exit /b %result%
