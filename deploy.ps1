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
    Move-Item -LiteralPath $targetDir -Destination $backupDir -Force
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$excludeTop = @('.git', '.data', 'node_modules')
Get-ChildItem -LiteralPath $sourceDir -Force | ForEach-Object {
    $name = $_.Name
    if ($excludeTop -contains $name) { return }
    if ($name -like '.*-test-*') { return }
    if ($name -match '[\u4e00-\u9fff]') {
        # Skip Chinese staging folders such as 待刪除資料夾
        return
    }
    $dest = Join-Path $targetDir $name
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force
}

# Clean up any runtime/test artifacts inside deployed plugin
$cleanupPaths = @(
    (Join-Path $targetDir 'sidecars\panel\.data'),
    (Join-Path $targetDir 'sidecars\panel\node_modules')
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
