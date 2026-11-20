<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor（繁體中文唯讀在地化版）

Google Antigravity 2.0 與 Antigravity CLI 的本機用量、速度、上下文與額度監控外掛，零外部 npm 相依性。

> 本倉庫為上游 [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)（`v1.5.1`）之**繁體中文（台灣用語）去侵入化唯讀分支**。

[![License](https://img.shields.io/github/license/erniesu8090-beep/AGY-usage-monitor?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20套件-10b981?style=flat-square)](#本地開發與測試)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#用戶端支援)

[English](README.md) · 繁體中文 · [简体中文](README.zh-CN.md)

[分支差異](#分支特色與重構差異) · [畫面預覽](#畫面預覽) · [主要功能](#主要功能) · [用戶端支援](#用戶端支援) · [安裝與部署](#安裝與部署) · [使用方式](#使用方式) · [本地開發與測試](#本地開發與測試)

<br />

<img src="assets/preview.png" alt="Antigravity Usage Monitor 介面預覽" width="100%" />

</div>

---

## 分支特色與重構差異

相較於原上游倉庫 [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)，本分支進行了以下在地化與架構簡化：

1. **全介面台灣繁體中文化**：完整轉換外掛資訊（`plugin.json`、`sidecar.json`、`index.html`）、前端多語系字典（`src/i18n/zh-CN.js`）、UI 元件標籤、後端狀態／錯誤訊息、CLI `statusLine` 與對話動作文字（採用台灣慣用詞彙，如「快取」「預設」「設定」「重新整理」「對話」「最吃緊額度」等），並提供 [`SKILL.md`](skills/usage-monitor/SKILL.md) 繁中指引。
2. **去侵入化純唯讀架構**：移除 CDP 記憶體注入（Window Bridge）、桌面捷徑啟動器改寫、宿主 `argv.json` 修改、請求層上下文覆寫及帳號切換模組，**不觸碰主程式安裝檔與 `app.asar`**。改由標準 **MCP 唯讀工具 + 原生 Sidecar 輔助面板 + CLI `statusLine` + 獨立 Web** 運作。
3. **唯讀 MCP 查詢整合**：新增 [`mcp-entry.mjs`](sidecars/panel/mcp-entry.mjs) 提供 `get_quota_status`、`get_conversation_usage`、`get_usage_summary` 三項唯讀工具，讓 AI 代理在對話中直接回報額度與明細並可附帶開啟面板按鈕。
4. **一鍵本機部署腳本**：根目錄提供 [`deploy.bat`](deploy.bat) / [`deploy.ps1`](deploy.ps1)（Windows）與 [`deploy.sh`](deploy.sh)（macOS / Linux），自動備份既有外掛目錄並完成安裝部署。
5. **Windows 11 工作列配額監控條（相容企業防毒）**：新增獨立零相依 C# 附屬工具（[`tools/win-taskbar-widget/`](tools/win-taskbar-widget/README.md)），直接讀取本機 `cli-status-snapshot.json` 於工作列系統匣左側顯示 `5h`／`7d` 雙排進度條與數字方塊圖示，且**已移除 `UIAutomation` 跨行程掃描**以相容端點防毒行為監控。

---

## 畫面預覽

<table>
  <tr>
    <td align="center">
      <img src="assets/cli-preview.png" alt="Antigravity CLI 原生底部 statusLine" width="100%" />
      <br />
      <b>Antigravity CLI (<code>agy</code>) 終端底欄 <code>statusLine</code></b>
      <br />
      <sub>單行 24-bit ANSI 無底色狀態列，即時顯示活躍數、輸出速度、首字延遲與上下文佔比</sub>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td align="center" width="33.3%">
      <img src="assets/context.png" alt="即時監控與上下文視窗" />
      <br />
      <b>即時監控</b>
      <br />
      <sub>輸出速度、首字延遲、10 類上下文明細、配額池與執行中任務</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/analytics.png" alt="歷史用量與趨勢統計" />
      <br />
      <b>用量統計</b>
      <br />
      <sub>Token 彙總、快取命中率、趨勢曲線與各模型用量排行</sub>
    </td>
    <td align="center" width="33.3%">
      <img src="assets/subagents.png" alt="呼叫明細與子代理統計" />
      <br />
      <b>呼叫明細</b>
      <br />
      <sub>按步列出代理歸屬、模型、速度、首字延遲、Token 構成與費用</sub>
    </td>
  </tr>
</table>

---

## 主要功能

- **即時指標與版面編排**：統計單步輸出速度（`tok/s`）、首字延遲（`TTFT`）、對話平均速度、單步／累計估算費用、快取命中率、最吃緊額度與對話 Token；可從 9 項指標自由勾選並拖曳排序（預設顯示 4 項），並自訂即時監控區塊順序。
- **10 類上下文視窗構成**：展示最近一次請求的上下文佔比，依類別列出模型回覆、工具結果、使用者訊息、子代理通知、壓縮摘要、系統提示詞、系統工具、MCP 工具、Skill 與使用者規則，並支援在主代理與各子代理之間切換檢視。
- **配額池監控與陳舊提示**：追蹤 `Gemini`、`Gemini 4 Argon`、`Gemini 4 Carbon` 與 `Claude & GPT` 配額池的 5 小時及每週餘量、重置倒數與週期累計用量；上游暫未回傳新資料時保留快取餘量並標示陳舊狀態。
- **主／子代理聯動與多對話管理**：依時間歸併展示主代理與各子代理步驟（亦可依單一代理篩選），支援對話輪次導軌、執行中子代理卡片原地展開，以及於頂欄快速切換最近對話。
- **呼叫明細與自訂 Token 格式**：包含「按步查看」與「總彙總」（含多模型趨勢擬合圖）；支援 2–14 欄自由增刪與排序、輸出速度多色分級，除預設 `上下文 / 思考 / 正文` 與 `輸入 / 輸出 / 快取` 外，亦可透過 `context:new:cache`、`in:out:cache` 等語法自訂 Token 組合格式。
- **歷史用量與來源統計**：支援今天、1 天、7 天、14 天、30 天、全部或自訂起訖時間，統計總 Token、新輸入與快取讀取節省金額、輸出／思考拆分、按小時／按日趨勢曲線、模型排行、用戶端來源（Desktop App / IDE / CLI）與月度柱狀圖。
- **唯讀 MCP 工具與對話整合**：透過 `get_quota_status`、`get_conversation_usage`、`get_usage_summary` 三個唯讀工具，直接於 AI 對話回覆配額與費用，並可點擊 `sidecar://usage-monitor/panel/` 捷徑開啟互動面板。
- **CLI 底欄與離線資料讀取**：離線直接讀取 CLI SQLite + WAL、`annotations/*.pbtxt`、`transcript.jsonl` 與 `.deep_stats_cache.json`，在無頭或未啟動主程式時仍可檢視歷史數據，並支援雲端 [`pricing-catalog.json`](pricing-catalog.json) 單價同步。

---

## 用戶端支援

| 用戶端 / 執行環境 | 監控呈現方式 | 對話 MCP 查詢 | 離線 SQLite 與日誌 | 修改 `app.asar` 或宿主設定 |
| :--- | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 桌面版** | 右側輔助面板（Sidecar）＋ 獨立 Web | 支援（3 個唯讀工具） | 支援 | **完全不修改** |
| **Antigravity CLI (`agy`)** | 終端底欄 `statusLine` ＋ 獨立 Web (`--port`) | 支援（3 個唯讀工具） | 支援（`node:sqlite` + `.pbtxt`） | 僅可選設定 `statusLine` |
| **無頭伺服器 / SSH 遠端** | 終端底欄 `statusLine` ＋ SSH 通道 / `--token` Web | 支援 | 支援 | **完全不修改** |
| **Windows 11 桌面工作列** | 系統匣左側雙排進度條 ＋ 數字圖示（附屬工具） | — | 讀取本機快照檔 | **完全不修改** |

> [!NOTE]
> - **Node.js 版本說明**：建議使用 **Node.js 22.5+** 以支援 CLI 離線 `node:sqlite` 讀取；在 **Node.js 20.x** 下仍可正常啟動與監控，系統會自動略過 `node:sqlite` 離線讀取改讀其他本機來源。

---

## 安裝與部署

外掛資料夾名稱**必須保持為 `usage-monitor`**，且**不需執行 `npm install`**。

### 方式一：下載／Clone 後使用一鍵部署腳本（推薦）

若您將倉庫下載或同步到任意工作目錄，直接執行根目錄對應腳本，系統會自動備份舊外掛至 `~/.gemini/config/plugins_backup/` 並部署到 `~/.gemini/config/plugins/usage-monitor`：

- **Windows**：雙擊 [`deploy.bat`](deploy.bat)（或於 PowerShell 執行 `.\deploy.ps1`）
- **macOS / Linux**：
  ```bash
  chmod +x deploy.sh && ./deploy.sh
  ```

### 方式二：直接 Git Clone 至外掛目錄

```powershell
# Windows (PowerShell)
git clone https://github.com/erniesu8090-beep/AGY-usage-monitor.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

```bash
# macOS / Linux
git clone https://github.com/erniesu8090-beep/AGY-usage-monitor.git ~/.gemini/config/plugins/usage-monitor
```

若本機已透過 Git Clone 安裝，可直接於外掛目錄拉取更新：

```powershell
git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only
```

---

## 使用方式

1. **啟用外掛**：開啟 Antigravity 左側邊欄 **Customizations → Installed**，找到 **`usage-monitor`** 並啟用（若剛執行 `deploy` 部署，建議重啟或重新載入一次 Antigravity）。
2. **在 Antigravity 2.0 開啟監控面板**：
   - 可直接從右側輔助欄開啟「用量監控」（Sidecar 面板），或於對話中直接詢問「現在還剩多少額度？」、「這段對話花了多少 Token？」，AI 會呼叫唯讀 MCP 工具回答並附上側邊欄開啟按鈕。
3. **Antigravity CLI (`agy`) 底欄**：
   - 偵測到 `~/.gemini/antigravity-cli` 時可於面板 **偏好設定 → 結構** 開啟 CLI `statusLine`（保留既有自訂 `statusLine.command`），亦可在 `agy` 中透過 `/statusline` 切換。
4. **獨立 Web 介面（免裝外掛或遠端使用）**：

```bash
# 1. 於本機或遠端主機啟動（預設監聽 127.0.0.1:8787）
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787

# 2. 若需從遠端存取，透過 SSH Port Forwarding 連線後於瀏覽器開啟 http://localhost:8787
ssh -L 8787:127.0.0.1:8787 user@your-server
```

5. **Windows 11 工作列配額監控條（選用附屬工具）**：
   - 雙擊 [`tools/win-taskbar-widget/Start_Taskbar_Monitor.bat`](tools/win-taskbar-widget/Start_Taskbar_Monitor.bat)（首次啟動會以 Windows 內建 `.NET Framework 4.x` `csc.exe` 編譯 `AntigravityTaskbarMonitor.exe`，免裝外部套件）。
   - 直接讀取 `usage-monitor` 即時寫入的 `cli-status-snapshot.json`，於系統匣左側顯示 `5h` / `7d` 雙排 10 格進度條與剩餘倒數，並於系統匣常駐數字圖示。
   - **企業防毒相容設計**：僅使用唯讀視窗矩形定位系統匣左側，不啟用 `UIAutomation` 跨行程工作列掃描；支援左鍵點擊展開全模型池速覽、右鍵切換顯示模式（雙排進度條／超精簡純文字／僅系統匣圖示）、數值口徑、配色與開機自啟，以及按住 `Alt` + 左鍵左右拖曳微調水平位置。詳見 [`tools/win-taskbar-widget/README.md`](tools/win-taskbar-widget/README.md)。

<details>
<summary>獨立 Web 參數、計算口徑與本機資料目錄說明</summary>

- **獨立 Web 常用參數**：
  - 綁定非回環位址（如 `--host 0.0.0.0`）時必須搭配 `--token <secret>` 或環境變數 `USAGE_MONITOR_STANDALONE_TOKEN`。
  - 支援 `--data-dir`、`--app-data-dir`、`--gemini-dir`、`--ls-addr`、`--csrf-token`。
  - 於 `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data/settings.json` 設定 `"standalonePort": 8787`（或環境變數 `USAGE_MONITOR_STANDALONE_PORT=8787`），可隨支援的宿主生命週期一併拉起。
- **模型識別與費用估算**：美元費用係依據 [`pricing-catalog.json`](pricing-catalog.json) 公開 API 單價計算，僅供參考，不代表訂閱配額扣減比例；當自動壓縮步驟缺少模型欄位時，會依同一對話相鄰步驟推斷並標註 `·壓縮`。
- **資料保存目錄**：外掛設定與解析快取存放於 `~/.gemini/antigravity/sidecar_data/usage-monitor/`（獨立模式為 `sidecars/panel/.data/`），重新部署或更新不會遺失歷史快取。

</details>

---

## 本地開發與測試

前後端皆採用純 Node.js ESM 與原生 Web Components 撰寫，**無外部 npm 相依性**。

```bash
cd sidecars/panel

# 修改 src/ 原始碼後重新編譯 app.js 與 styles.css
npm run build

# 執行完整單元測試（macOS / Linux，或支援萬用字元的 Node.js 22+ Windows 環境）
npm test
```

若在 Windows PowerShell 遇到 `--test` 未自動展開萬用字元的情況（如部分 Node 20.x 環境），可改用以下指令展開測試檔案清單：

```powershell
cd sidecars\panel
$tests = Get-ChildItem "test\*.test.mjs" | ForEach-Object { $_.FullName }
node --test $tests
```

若要重新編譯並測試 Windows 工作列配額監控條：

```bat
tools\win-taskbar-widget\build.bat
```

---

## 授權條款

本專案沿用原上游專案之 [GNU General Public License v3.0](LICENSE) 授權條款釋出。
