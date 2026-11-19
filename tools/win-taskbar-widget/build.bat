@echo off
cd /d "%~dp0"
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
if not exist "%CSC%" (
    echo [ERROR] .NET Framework 4.x csc.exe not found.
    exit /b 1
)

set "WPF=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\WPF"
if not exist "%WPF%\UIAutomationClient.dll" (
    set "WPF=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\WPF"
)

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 /utf8output ^
    /out:"AntigravityTaskbarMonitor.exe" ^
    /reference:System.dll ^
    /reference:System.Core.dll ^
    /reference:System.Drawing.dll ^
    /reference:System.Windows.Forms.dll ^
    /reference:System.Web.Extensions.dll ^
    /reference:"%WPF%\WindowsBase.dll" ^
    /reference:"%WPF%\UIAutomationClient.dll" ^
    /reference:"%WPF%\UIAutomationTypes.dll" ^
    "Program.cs" "QuotaData.cs" "TaskbarLocator.cs" "TaskbarBarForm.cs"

if errorlevel 1 (
    echo [ERROR] Compilation failed.
    exit /b 1
)

echo [OK] Built AntigravityTaskbarMonitor.exe
"AntigravityTaskbarMonitor.exe" --self-test
if errorlevel 1 (
    echo [ERROR] Self-test failed.
    exit /b 1
)
exit /b 0
