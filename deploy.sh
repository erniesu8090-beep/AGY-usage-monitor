#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="${HOME}/.gemini/config/plugins"
TARGET_DIR="${PLUGINS_DIR}/usage-monitor"
BACKUP_ROOT="${HOME}/.gemini/config/plugins_backup"

mkdir -p "${PLUGINS_DIR}"

if [ -e "${TARGET_DIR}" ]; then
  mkdir -p "${BACKUP_ROOT}"
  STAMP="$(date +%Y%m%d_%H%M%S)"
  BACKUP_DIR="${BACKUP_ROOT}/usage-monitor_${STAMP}"
  echo "[Backup] Existing plugin found -> ${BACKUP_DIR}"
  mv "${TARGET_DIR}" "${BACKUP_DIR}"
fi

mkdir -p "${TARGET_DIR}"

if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude='.git' \
    --exclude='.data' \
    --exclude='node_modules' \
    --exclude='.*-test-*' \
    --exclude='待刪除資料夾' \
    "${SOURCE_DIR}/" "${TARGET_DIR}/"
else
  cp -a "${SOURCE_DIR}/." "${TARGET_DIR}/"
  rm -rf \
    "${TARGET_DIR}/.git" \
    "${TARGET_DIR}/.data" \
    "${TARGET_DIR}/node_modules" \
    "${TARGET_DIR}/待刪除資料夾" \
    "${TARGET_DIR}/sidecars/panel/.data" \
    "${TARGET_DIR}/sidecars/panel/node_modules"
  find "${TARGET_DIR}/sidecars/panel" -maxdepth 1 -type d -name '.*-test-*' -exec rm -rf {} + 2>/dev/null || true
fi

echo "[OK] Deployed usage-monitor to: ${TARGET_DIR}"
echo "Next: Restart or reload Antigravity and enable 'usage-monitor' in Customizations -> Installed."
