# Antigravity Windows 11 工作列配額監控條

免安裝、零外部相依套件的 Windows 11 工作列浮動監控條與系統匣數字圖示，直接讀取 `antigravity-usage-monitor` 即時寫入的 `cli-status-snapshot.json`，於工作列系統匣左側顯示 `5h` / `7d` 雙排 10 格進度條、剩餘百分比與重置倒數。

## 檔案說明

- `AntigravityTaskbarMonitor.exe`：編譯完成的可執行檔（單一實例保護）。
- `Start_Taskbar_Monitor.bat`：一鍵啟動（若尚未編譯會自動呼叫 `build.bat`）。
- `build.bat`：使用 Windows 內建 `.NET Framework 4.x` (`csc.exe`) 重新編譯並執行 `--self-test`。
- `Program.cs`、`QuotaData.cs`、`TaskbarLocator.cs`、`TaskbarBarForm.cs`：C# 原始碼。

## 操作方式

- **雙擊啟動**：執行 `Start_Taskbar_Monitor.bat` 或 `AntigravityTaskbarMonitor.exe`。
- **左鍵點擊工作列進度條／系統匣數字方塊**：展開各模型池（`Gemini`、`Gemini 4 Argon`、`Claude & GPT` 等）雙排配額速覽，點擊列可固定顯示指定池。
- **右鍵選單**：
  - 切換「模型池顯示」（預設自動跟隨 `activePool`）。
  - 切換「數值口徑」（預設顯示剩餘額度 `%`，可切為已用 `%`）。
  - 切換「進度條配色」（復刻暖橘 / 狀態分色 / Antigravity 天空藍）。
  - 切換「工作列顯示模式 (防遮擋)」：預設「自動避讓」，透過 Windows UIAutomation 即時偵測工作列右側最後一個捷徑圖示位置；空位充足時顯示緊湊雙排進度條，空位不足時自動切換為超精簡純文字（`5h XX%` / `7d XX%`），若連精簡文字都會遮擋則暫時收合為僅保留系統匣數字圖示。
  - 位置微調、全螢幕自動隱藏、設定「Windows 登入時自動啟動」、開啟完整網頁監控。
- **拖曳微調水平位置**：按住 `Alt` + 左鍵左右拖曳進度條即可微調 X 軸偏移，設定自動保存至 `%USERPROFILE%\.gemini\antigravity\sidecar_data\usage-monitor\taskbar-widget-settings.json`。
