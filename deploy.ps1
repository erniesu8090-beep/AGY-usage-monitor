$ErrorActionPreference = 'Stop'

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsDir = Join-Path $env:USERPROFILE '.gemini\config\plugins'
$targetDir = Join-Path $pluginsDir 'usage-monitor'
$backupRoot = Join-Path $env:USERPROFILE '.gemini\config\plugins_backup'

if (-not (Test-Path -LiteralPath $pluginsDir)) {
    New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
}

if (Test-Path -LiteralPath $targetDir) {
    if (-not (Test-Path -LiteralPath $backupRoot)) {
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backupDir = Join-Path $backupRoot ("usage-monitor_" + $stamp)
    Write-Host "[Backup] Existing plugin found -> $backupDir"
    # Copy-Item 採唯讀複製備份，避免在 Sidecar 執行中因 Move-Item 鎖檔造成半殘搬移
    Copy-Item -LiteralPath $targetDir -Destination $backupDir -Recurse -Force
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$excludeDirs = @('.git', '.data', 'node_modules')

function Copy-DirectoryMerge {
    param(
        [Parameter(Mandatory = $true)][string]$Src,
        [Parameter(Mandatory = $true)][string]$Dst
    )
    if (-not (Test-Path -LiteralPath $Dst)) {
        New-Item -ItemType Directory -Path $Dst -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $Src -Force | ForEach-Object {
        $name = $_.Name
        if ($_.PSIsContainer) {
            if ($excludeDirs -contains $name) { return }
            if ($name -like '.*-test-*') { return }
            if ($name -match '[\u4e00-\u9fff]') {
                # 略過中文暫存資料夾（例如：待刪除資料夾）
                return
            }
            Copy-DirectoryMerge -Src $_.FullName -Dst (Join-Path $Dst $name)
        } else {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Dst $name) -Force
        }
    }
}

try {
    Copy-DirectoryMerge -Src $sourceDir -Dst $targetDir
} catch {
    Write-Host "[WARN] 部分檔案複製受限，可能正被 Antigravity 或工作列監控條鎖定。"
    Write-Host "       請先關閉 Antigravity 與 AntigravityTaskbarMonitor.exe 後再重新執行本腳本。"
    throw
}

# 清理部署目標內不應留存的執行期暫存、已廢棄舊檔與誤建的嵌套目錄
$cleanupPaths = @(
    (Join-Path $targetDir 'assets\assets'),
    (Join-Path $targetDir 'sidecars\sidecars'),
    (Join-Path $targetDir 'skills\skills'),
    (Join-Path $targetDir 'tools\tools'),
    (Join-Path $targetDir 'sidecars\panel\.data'),
    (Join-Path $targetDir 'sidecars\panel\node_modules'),
    (Join-Path $targetDir 'sidecars\panel\shared\window-bridge-protocol.mjs'),
    (Join-Path $targetDir 'sidecars\panel\backend\window-bridge.mjs'),
    (Join-Path $targetDir 'sidecars\panel\backend\desktop-launcher-config.mjs'),
    (Join-Path $targetDir 'sidecars\panel\backend\account-oauth.mjs'),
    (Join-Path $targetDir 'sidecars\panel\backend\account-switch.mjs'),
    (Join-Path $targetDir 'sidecars\panel\backend\account-credentials.ps1'),
    (Join-Path $targetDir 'sidecars\panel\bridge-daemon.mjs'),
    (Join-Path $targetDir 'assets\ide-preview.png'),
    (Join-Path $targetDir 'sidecars\panel\src\components\ui\CustomNumberInput.js')
)
foreach ($p in $cleanupPaths) {
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Get-ChildItem -LiteralPath (Join-Path $targetDir 'sidecars\panel') -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.PSIsContainer -and ($_.Name -like '.*-test-*')
} | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[OK] Deployed usage-monitor to: $targetDir"
Write-Host "Next: Restart or reload Antigravity and enable 'usage-monitor' in Customizations -> Installed."
