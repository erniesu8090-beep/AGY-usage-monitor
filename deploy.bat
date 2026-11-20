@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
if errorlevel 1 (
    echo [ERROR] Deployment failed.
    pause
    exit /b 1
)
echo [OK] Deployment complete.
pause
exit /b 0
