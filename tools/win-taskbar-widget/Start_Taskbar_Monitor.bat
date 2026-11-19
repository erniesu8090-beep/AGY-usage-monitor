@echo off
cd /d "%~dp0"
if not exist "AntigravityTaskbarMonitor.exe" (
    call "build.bat"
    if errorlevel 1 exit /b 1
)
start "" "%~dp0AntigravityTaskbarMonitor.exe"
exit /b 0
