# Antigravity Windows 11 工作列配額監控條

免安裝、零外部相依套件的 Windows 11 工作列浮動監控條與系統匣數字圖示，直接讀取 `usage-monitor` 即時寫入的 `cli-status-snapshot.json`，於工作列系統匣左側顯示 `5h` / `7d` 雙排 10 格進度條、剩餘百分比與重置倒數。

## 檔案說明

- `AntigravityTaskbarMonitor.exe`：首次執行 `Start_Taskbar_Monitor.bat` 後自動編譯產生的可執行檔（已由 `.gitignore` 排除，不納入 Git 版控，具單一實例保護）。
- `Start_Taskbar_Monitor.bat`：一鍵啟動（若尚未編譯會自動呼叫 `build.bat`）。
- `build.bat`：使用 Windows 內建 `.NET Framework 4.x` (`csc.exe`) 重新編譯並執行 `--self-test`。
- `Program.cs`、`QuotaData.cs`、`TaskbarLocator.cs`、`TaskbarBarForm.cs`：C# 原始碼。

## 設計特色（相容企業防毒）

- 僅使用唯讀視窗矩形 API（`FindWindow` / `GetWindowRect`）取得工作列與系統匣左緣座標進行對齊。
- **已移除 `UIAutomation` 跨行程工作列控制項掃描**與對應的 WPF 相依參考，降低觸發端點防毒（如 Apex One 行為監控）誤判封鎖的風險。

## 操作方式

- **雙擊啟動**：執行 `Start_Taskbar_Monitor.bat` 或已編譯的 `AntigravityTaskbarMonitor.exe`。
- **左鍵點擊工作列進度條／系統匣數字方塊**：展開各模型池（`Gemini`、`Gemini 4 Argon`、`Gemini 4 Carbon`、`Claude & GPT` 等）雙排配額速覽，點擊列可固定顯示指定池。
- **右鍵選單**：
  - 切換「模型池顯示」（預設自動跟隨 `activePool`）。
  - 切換「數值口徑」（預設顯示剩餘額度 `%`，可切為已用 `%`）。
  - 切換「進度條配色」（復刻暖橘 / 狀態分色 / Antigravity 天空藍）。
  - 切換「工作列顯示模式」：預設（顯示雙排進度條）／一律顯示雙排進度條／一律顯示超精簡純文字（`5h XX%` / `7d XX%`）／僅顯示系統匣數字圖示。
  - 「位置與視窗行為」：向左／向右微調 `24 px`、重設貼齊系統匣左側、全螢幕時自動隱藏、設定「Windows 登入時自動啟動」。
  - 「重置提醒通知」：
    - 切換通知模式：`僅通知無預警提前重設 (預設)`／`所有配額重設都通知 (含到期)`／`關閉重設通知`。
    - 開關「重設時播放提示音」（預設開啟）與「無面板時背景自動刷新 (每 90 秒)」（預設開啟；當快照超過 90 秒未更新時自動向本機監控埠請求 `/api/telemetry?force=1`）。
    - 「立即測試重設通知」：手動觸發一次範例氣球通知與提示音。
  - 開啟完整網頁監控、立即重新整理、結束。
- **拖曳微調水平位置**：按住 `Alt` + 左鍵左右拖曳進度條即可微調 X 軸偏移（避開工作列圖示），設定自動保存至 `%USERPROFILE%\.gemini\antigravity\sidecar_data\usage-monitor\taskbar-widget-settings.json`。

## 運作前提與常見問題

1. **是否一定要先安裝 `usage-monitor` 外掛才能使用？**
   - 工作列監控條本身可獨立啟動，但它**不直接連線 Google 伺服器**，而是讀取 `usage-monitor` 後端即時寫入的本機快照檔（`%USERPROFILE%\.gemini\antigravity\sidecar_data\usage-monitor\panel\data\cli-status-snapshot.json` 或 `antigravity-cli` 同路徑）。
   - 因此仍須透過已啟用的 `usage-monitor` 外掛（或自行啟動 `sidecars/panel/standalone.mjs` 並請求遙測）來持續寫入該快照，工作列數值才會更新。
2. **沒開 Antigravity（AGY）時，只開工作列監控條可以嗎？**
   - **可以正常開啟、不會報錯**，但因為配額是透過 Antigravity 本機 `language_server` RPC 取得，未啟動 Antigravity 時無法向伺服器拉取新配額：
     - **曾開過 Antigravity 並留有快照時**：會顯示最後一筆紀錄的配額比例，並持續依據快照中的 `resetTime` 動態倒數；若已超過重置時間仍未開啟 Antigravity，倒數會停在 `0m`（彈窗顯示 `已重設`），待下次開啟 Antigravity 後自動刷新。
     - **從未產生過快照時**：工作列與系統匣圖示仍會正常顯示，但數值呈現 `--`，待開啟 Antigravity 並啟用外掛後即會自動帶出數據。
3. **如果工作列進度條剛好遮到我的釘選捷徑怎麼辦？**
   - 可按住 `Alt` + 左鍵直接拖曳調整水平偏移，或右鍵切換為「超精簡純文字」或「僅顯示系統匣數字圖示」。
