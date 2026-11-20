---
name: usage-monitor
description: 查詢 Antigravity 模型配額餘量、對話 Token 用量、估算費用、生成速度 (TPS) 與首字延遲 (TTFT)。當使用者詢問目前剩多少額度、何時重置、本對話花了多少 Token 或費用、歷史用量統計，或想開啟用量監控側邊面板時觸發。
---

# Usage & Speed Monitor 查詢指引

本 Skill 協助 AI 代理透過唯讀 MCP 工具與原生 Sidecar 面板提供用量與額度查詢，不修改任何宿主程式或使用者設定。

## 何時呼叫 MCP 工具

當使用者詢問以下任一問題時，優先呼叫 `usage-monitor` MCP Server 提供的唯讀工具，不要自行猜測數字：

1. **詢問額度與重置倒數**（「還剩多少額度」「Gemini / Carbon / Claude 配額還有幾 %」「什麼時候重置」）
   - 呼叫 `get_quota_status`（必要時可帶 `forceRefresh: true`）。
2. **詢問目前或特定對話的明細**（「這段對話用了多少 Token」「估算費用多少」「輸出速度 TPS / 首字延遲 TTFT」「上下文佔用多少」）
   - 呼叫 `get_conversation_usage`（可選填 `conversationId`、`includeSteps`）。
3. **詢問歷史彙總統計**（「今天 / 這週 / 最近 30 天總共花了多少」「哪個模型用最多」「快取省了多少錢」）
   - 呼叫 `get_usage_summary`（依時間範圍指定 `range`: `today` / `24h` / `7d` / `14d` / `30d` / `all` / `custom`）。

## 開啟互動面板按鈕（依 `ui-plugin-navigation` 規範）

- 當使用者想檢視即時圖表、上下文構成條或詳細歷史曲線，且 `usage-monitor` 外掛處於啟用狀態時，於回覆末尾附上一枚 `sidecar://` 開啟按鈕：

```markdown
[用量監控](sidecar://usage-monitor/panel/)
```

- **注意**：每次回覆最多只附一個 `sidecar://usage-monitor/panel/` 按鈕，避免重複輸出；若使用者僅詢問單純數字且無看圖表需求，可只回答數據或視情境附帶。
