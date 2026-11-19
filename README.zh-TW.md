<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor（繁體中文在地化版）

Google Antigravity 2.0、Antigravity IDE 與 Antigravity CLI 的本機用量、速度、上下文與額度監控外掛，零外部 npm 相依性。

> 本倉庫為上游 [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)（`v1.5.1`）之**繁體中文（台灣用語）在地化分支**。

[![License](https://img.shields.io/github/license/erniesu8090-beep/AGY-usage-monitor?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20套件-10b981?style=flat-square)](#本地開發與測試)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#用戶端支援)

[English](README.md) · 繁體中文 · [简体中文](README.zh-CN.md)

[在地化說明](#繁體中文在地化差異) · [主要功能](#主要功能) · [用戶端支援](#用戶端支援) · [安裝方式](#安裝方式) · [使用方式](#使用方式) · [本地開發與測試](#本地開發與測試)

<br />

<img src="assets/preview.png" alt="Antigravity Usage Monitor 介面預覽" width="100%" />

</div>

---

## 繁體中文在地化差異

相較於原上游倉庫 [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)，本版額外進行了以下調整：

1. **全介面台灣繁體中文化**：完整轉換外掛資訊（`plugin.json`、`sidecar.json`、`index.html`）、前端多語系字典（`src/i18n/zh-CN.js`）、UI 元件標籤、後端狀態／錯誤訊息、CLI `statusLine` 與軌跡動作文字（採用台灣慣用詞彙，如「快取」「預設」「設定」「重新整理」「對話」「最吃緊額度」等），並已重新編譯打包 `app.js` 與 `styles.css`。
2. **雙語相容保護**：針對主程式原生按鈕偵測（`WindowOverlayShell.js`）、壓縮標記判斷（`SessionStepCharts.js`、`formatters.js`）與自訂 Token 欄位別名（`shared/settings-normalization.mjs`）皆保留簡體相容並擴充繁體匹配。
3. **非 ASCII 路徑測試修正**：修正 `sidecars/panel/test/window-bridge.test.mjs` 解析 `mcp-entry.mjs` 路徑時補上 `decodeURIComponent(...)`，避免在含中文字元的工作區路徑下執行測試失敗。

---

## 主要功能

- **即時指標與版面編排**：統計單步輸出速度（`tok/s`）、首字延遲（`TTFT`）、對話平均速度、單步／累計費用、快取命中率、最吃緊額度與對話 Token；可於設定中從 9 項指標自由勾選並拖曳排序（預設顯示 4 項），並調整即時監控各模組順序。
- **10 類上下文視窗構成**：展示最近一次請求的上下文佔比，依類別列出模型回覆、工具結果、使用者訊息、子代理通知、壓縮摘要、系統提示詞、系統工具、MCP 工具、Skill 與使用者規則，支援在主代理與任意子代理之間切換檢視。
- **配額池監控與陳舊提示**：追蹤 `Gemini`、`Gemini 4 Argon`、`Gemini 4 Carbon` 與 `Claude & GPT` 配額池的 5 小時及每週餘量、重置倒數與週期累計用量；上游介面暫未回傳新資料時保留快取餘量並顯示過期狀態。
- **主／子代理聯動與多對話管理**：依時間歸併展示主代理與各子代理呼叫步驟（亦可依單一代理篩選），支援對話輪次導軌與執行中子代理卡片原地展開，並於頂欄切換最近對話。
- **呼叫明細與自訂 Token 格式**：包含「按步查看」與「總彙總」（含多模型趨勢擬合圖）；支援增刪與拖曳排序 2–14 欄、獨立開關輸出速度多色分級，除預設的 `上下文 / 思考 / 正文` 與 `輸入 / 輸出 / 快取` 外，亦可透過 `context:new:cache`、`in:out:cache` 等語法自訂 Token 組合格式。
- **歷史用量與來源統計**：支援今天、1 天、7 天、14 天、30 天、全部或自訂起訖日期時間，統計總 Token、新輸入與快取讀取節省金額、輸出／思考拆分、按小時／按日趨勢曲線、模型排行、用戶端來源（Desktop App / IDE / CLI）與月度統計圖。
- **多端膠囊與懸浮速覽**：支援 Antigravity 2.0 頂欄／輸入框停靠膠囊與右側輔助欄、Antigravity IDE 頂欄／輸入框膠囊、Antigravity CLI（`agy`）單行 24-bit ANSI `statusLine` 與獨立 Web 介面；支援自訂 1–5 個膠囊欄位、懸浮速覽模組與自適應（或 `440–1080 px` 指定）面板寬度。
- **不修改 `app.asar`**：桌面版與 IDE 的膠囊掛載及上下文請求攔截皆於執行期透過本機 CDP 記憶體注入完成（IDE 首次啟用僅會於 `~/.antigravity-ide/argv.json` 寫入 `"remote-debugging-port": "0"`，保留註解與原有設定），不改動主程式安裝檔與 `app.asar`。
- **依模型設定上下文視窗**：支援依模型系列統一指定上下文上限或跟隨主程式預設；桌面版與 IDE 於請求層生效，CLI 透過環境變數 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 控制。

---

## 用戶端支援

| 用戶端 / 執行環境 | 狀態膠囊 / 底欄 | 監控面板 | 離線 SQLite 與日誌讀取 | 依模型上下文限制 | 修改 `app.asar` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 桌面版** | 頂欄 / 輸入框停靠 | 懸浮窗 + 右側輔助欄 | 支援 | 請求層覆寫掛鉤 | 否 |
| **Antigravity IDE** | 頂欄 / 輸入框停靠 | 點擊膠囊展開面板 | 支援 | 請求層覆寫掛鉤 | 否 |
| **Antigravity CLI (`agy`)** | 終端機底欄 `statusLine` | 獨立 Web (`--port`) | 支援（`node:sqlite` + `.pbtxt`） | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | 否 |
| **無頭伺服器 / SSH 遠端** | 終端機底欄 `statusLine` | SSH 通道 / `--token` Web | 支援 | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | 否 |

> [!NOTE]
> - **Antigravity IDE**：首次啟用外掛時，背景會透過零工具開銷的 MCP 保活入口（不消耗上下文 Token）於 `~/.antigravity-ide/argv.json` 加入 `"remote-debugging-port": "0"`，首次啟用後請**重啟一次 IDE** 讓頂欄膠囊掛載。
> - **Node.js 版本說明**：建議使用 **Node.js 22.5+** 以支援 CLI 離線 `node:sqlite` 讀取；在 **Node.js 20.x**（如 `v20.20.2`）下外掛仍可正常啟動與監控，系統會自動降級略過 `node:sqlite` 離線資料庫讀取。

---

## 安裝方式

外掛資料夾名稱**必須保持為 `usage-monitor`**，且**不需執行 `npm install`**。

### Windows (PowerShell)

```powershell
git clone https://github.com/erniesu8090-beep/AGY-usage-monitor.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

### macOS / Linux

```bash
git clone https://github.com/erniesu8090-beep/AGY-usage-monitor.git ~/.gemini/config/plugins/usage-monitor
```

若本機已安裝過舊版，可先移除或備份後重新 clone，或於外掛目錄內拉取更新：

```powershell
git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only
```

---

## 使用方式

1. 開啟 Antigravity 左側邊欄 **Customizations → Installed**，找到 **`usage-monitor`** 並啟用。
2. **Antigravity 2.0 桌面版**：
   - 主視窗右上角會出現狀態膠囊（**懸停**看速覽、**點擊**展開四分頁面板、**右鍵**強制重新整理），並同時可於右側輔助欄開啟「用量監控」。
3. **Antigravity IDE**：
   - 首次啟用後請**重啟一次 Antigravity IDE**，保持掛載方式為「雙棲掛載」，點擊頂欄膠囊即可開啟面板。
4. **Antigravity CLI (`agy`)**：
   - 偵測到 `~/.gemini/antigravity-cli` 時會自動設定原生 `statusLine`（保留既有自訂 `statusLine.command`），可用 `/statusline` 或於面板 **偏好設定 → 結構 → 掛載膠囊** 切換開關。
5. **獨立 Web 介面（無須安裝進外掛目錄亦可啟動）**：

```bash
# 1. 於主機啟動（預設監聽 127.0.0.1:8787）
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787

# 2. 若為遠端主機，透過 SSH Port Forwarding 連線後開啟 http://localhost:8787
ssh -L 8787:127.0.0.1:8787 user@your-server
```

<details>
<summary>設定說明、計算口徑與本機資料保存目錄</summary>

- **模型識別與費用估算**：美元費用係依據 [`pricing-catalog.json`](pricing-catalog.json) 公開 API 單價計算，僅供參考，不代表訂閱配額扣減比例；當自動壓縮步驟缺少模型欄位時，會依同一對話相鄰步驟推斷並標註 `·壓縮`。
- **更新與本機保護**：外掛設定與解析快取存放於 `~/.gemini/antigravity/sidecar_data/usage-monitor/`（獨立模式為 `sidecars/panel/.data/`），更新或重開外掛不會遺失歷史紀錄。
- **與上游同步**：若要同步原上游倉庫更新，可先加入 upstream 再合併：
  ```bash
  git remote add upstream https://github.com/yuhuan-dev/antigravity-usage-monitor.git
  git fetch upstream
  ```

</details>

---

## 本地開發與測試

前後端皆採用純 Node.js ESM 與原生 Web Components 撰寫，**無外部 npm 相依性**。

```bash
cd sidecars/panel

# 修改 src/ 原始碼後重新編譯 app.js 與 styles.css
npm run build

# macOS / Linux 執行完整測試
npm test
```

若在 **Windows PowerShell + Node.js 20.x** 環境執行測試（Node 20 的 `--test` 在 Windows 命令列下不會自動展開 `test/*.test.mjs` 萬用字元），請改用以下指令展開測試檔案清單：

```powershell
cd sidecars\panel
$tests = Get-ChildItem "test\*.test.mjs" | ForEach-Object { $_.FullName }
node --test $tests
```

---

## 授權條款

本專案沿用原上游專案之 [GNU General Public License v3.0](LICENSE) 授權條款釋出。
