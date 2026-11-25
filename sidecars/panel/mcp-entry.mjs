/**
 * @fileoverview 去侵入化唯讀 MCP Stdio 服務入口 (`mcp_config.json`)。
 *
 * 提供三個唯讀查詢工具（不啟動任何 CDP 注入或背景守護程序）：
 * - `get_quota_status`：查詢各模型配額池餘量與重置倒數
 * - `get_conversation_usage`：查詢指定或最近活躍對話的 Token、費用、速度與上下文佔比
 * - `get_usage_summary`：查詢跨對話歷史用量與模型統計彙總
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(dirname(PANEL_DIR)), 'plugin.json');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';
const DEFAULT_FALLBACK_VERSION = '1.5.1';

// 所有查詢工具皆為本機閉鎖環境的唯讀操作，明確宣告 MCP 四項工具提示欄位以符合客戶端與目錄檢查規範
const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const MCP_TOOL_DEFS = Object.freeze([
  Object.freeze({
    name: 'get_quota_status',
    description:
      '唯讀查詢目前帳號各模型配額池（Gemini、Argon、Carbon、Claude & GPT）的 5 小時與每週剩餘額度、重置時間與官方資料狀態。',
    inputSchema: {
      type: 'object',
      properties: {
        forceRefresh: {
          type: 'boolean',
          description: '是否強制略過短期快取並向本機語言伺服器重新查詢（預設 false）',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'get_conversation_usage',
    description:
      '唯讀查詢指定對話（或最近活躍對話）的 Token 用量、估算費用、輸出速度 (TPS)、首字延遲 (TTFT)、快取命中率與上下文佔用明細。',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: '選填。指定對話 ID（省略時自動選擇最近活躍對話）',
        },
        includeSteps: {
          type: 'boolean',
          description: '是否回傳最近步驟明細（預設 false）',
        },
        stepLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: '當 includeSteps=true 時最多回傳幾筆最近步驟（預設 10，上限 50）',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'get_usage_summary',
    description:
      '唯讀查詢跨對話歷史用量彙總，包含總 Token、估算費用、快取節省費用、模型分佈與用戶端來源佔比。',
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          enum: ['today', '24h', '7d', '14d', '30d', 'all', 'custom'],
          description: '查詢時間區間（預設 all）',
        },
        startMs: {
          type: 'number',
          description: '當 range=custom 時的起始時間戳（毫秒）',
        },
        endMs: {
          type: 'number',
          description: '當 range=custom 時的結束時間戳（毫秒）',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }),
]);

export function readMcpServerVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // 忽略清單讀取失敗
  }
  return DEFAULT_FALLBACK_VERSION;
}

let telemetryLoaderPromise = null;

async function defaultLoadTelemetry({ conversationId = '', force = false, range = 'all', startMs = 0, endMs = 0 } = {}) {
  if (!telemetryLoaderPromise) {
    telemetryLoaderPromise = Promise.all([
      import('./backend/config.mjs'),
      import('./backend/ls-discovery.mjs'),
      import('./backend/telemetry-builder.mjs'),
    ]).then(([configMod, discoveryMod, telemetryMod]) => ({
      lsRuntimeEndpoint: configMod.lsRuntimeEndpoint,
      ensureLsEndpointDiscovered: discoveryMod.ensureLsEndpointDiscovered,
      buildTelemetryPayload: telemetryMod.buildTelemetryPayload,
    }));
  }
  const { lsRuntimeEndpoint, ensureLsEndpointDiscovered, buildTelemetryPayload } =
    await telemetryLoaderPromise;
  if (lsRuntimeEndpoint.addr !== 'test.invalid' && !lsRuntimeEndpoint.baseUrl) {
    await ensureLsEndpointDiscovered({ force: false }).catch(() => false);
  }
  return buildTelemetryPayload(conversationId, Boolean(force), { range, startMs, endMs });
}

const UI_PANEL_HINT = 'sidecar://usage-monitor/panel/';

function summarizeQuotaStatus(payload) {
  const quotas = payload?.quotas || {};
  return {
    account: payload?.account || null,
    meta: quotas.meta || null,
    activePool: quotas.activePool || null,
    pools: Array.isArray(quotas.pools) ? quotas.pools : [],
    weekly: quotas.weekly || null,
    uiPanelHint: UI_PANEL_HINT,
  };
}

function summarizeConversationUsage(payload, { includeSteps = false, stepLimit = 10 } = {}) {
  const active = payload?.activeConversation || {};
  const cap = active.aggregated || active;
  const limit = Math.max(1, Math.min(50, Number.isFinite(Number(stepLimit)) ? Math.floor(Number(stepLimit)) : 10));
  const rawSteps = Array.isArray(cap.recentSteps)
    ? cap.recentSteps
    : Array.isArray(active.recentSteps)
      ? active.recentSteps
      : [];
  return {
    cascadeId: active.cascadeId || null,
    title: active.title || null,
    isRunning: Boolean(cap.isRunning ?? active.isRunning),
    stepCount: Number(cap.stepCount ?? active.stepCount ?? 0),
    activeModelShort: cap.activeModelShort ?? active.activeModelShort ?? null,
    latestTokPerSec: cap.latestTokPerSec ?? active.latestTokPerSec ?? null,
    avgTokPerSec: cap.avgTokPerSec ?? active.avgTokPerSec ?? null,
    latestTtftSec: cap.latestTtftSec ?? active.latestTtftSec ?? null,
    latestStepCostUsd: cap.latestStepCostUsd ?? active.latestStepCostUsd ?? null,
    sessionCostUsd: cap.sessionCostUsd ?? active.sessionCostUsd ?? 0,
    inputTokens: cap.inputTokens ?? active.inputTokens ?? 0,
    cacheReadTokens: cap.cacheReadTokens ?? active.cacheReadTokens ?? 0,
    outputTokens: cap.outputTokens ?? active.outputTokens ?? 0,
    totalTokens: cap.totalTokens ?? active.totalTokens ?? 0,
    latestCacheHitPct: cap.latestCacheHitPct ?? active.latestCacheHitPct ?? null,
    sessionCacheHitPct: cap.sessionCacheHitPct ?? active.sessionCacheHitPct ?? null,
    context: active.context || null,
    modelBreakdown: Array.isArray(cap.modelBreakdown)
      ? cap.modelBreakdown
      : Array.isArray(active.modelBreakdown)
        ? active.modelBreakdown
        : [],
    ...(includeSteps ? { recentSteps: rawSteps.slice(-limit) } : {}),
    uiPanelHint: UI_PANEL_HINT,
  };
}

function summarizeUsageOverview(payload) {
  const cons = payload?.consumption || {};
  return {
    selectedRange: cons.selectedRange || null,
    session: cons.session || null,
    account: cons.account || null,
    presets: cons.presets || null,
    sourcesBreakdown: Array.isArray(cons.sourcesBreakdown) ? cons.sourcesBreakdown : [],
    modelBreakdown: Array.isArray(payload?.modelBreakdown) ? payload.modelBreakdown : [],
    conversationsCount: Array.isArray(payload?.conversations) ? payload.conversations.length : 0,
    uiPanelHint: UI_PANEL_HINT,
  };
}

export async function executeReadOnlyMcpTool(name, args = {}, { loadTelemetryFn = defaultLoadTelemetry } = {}) {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'get_quota_status') {
    const payload = await loadTelemetryFn({ force: Boolean(safeArgs.forceRefresh) });
    return summarizeQuotaStatus(payload);
  }
  if (name === 'get_conversation_usage') {
    const rawCid = String(safeArgs.conversationId || '').trim();
    const conversationId = rawCid && !/[\\/]|\.\./.test(rawCid) ? rawCid : '';
    const payload = await loadTelemetryFn({ conversationId });
    return summarizeConversationUsage(payload, {
      includeSteps: Boolean(safeArgs.includeSteps),
      stepLimit: safeArgs.stepLimit,
    });
  }
  if (name === 'get_usage_summary') {
    const allowedRanges = new Set(['today', '24h', '7d', '14d', '30d', 'all', 'custom']);
    const range = allowedRanges.has(safeArgs.range) ? safeArgs.range : 'all';
    const startMs = Number.isFinite(Number(safeArgs.startMs)) ? Math.max(0, Math.floor(Number(safeArgs.startMs))) : 0;
    const endMs = Number.isFinite(Number(safeArgs.endMs)) ? Math.max(0, Math.floor(Number(safeArgs.endMs))) : 0;
    const payload = await loadTelemetryFn({ range, startMs, endMs });
    return summarizeUsageOverview(payload);
  }
  throw new Error(`Unknown tool: ${name}`);
}

/**
 * 處理單條 MCP JSON-RPC 2.0 同步查詢訊息（不含工具執行），通知類訊息返回 `null`。
 */
export function handleMcpJsonRpcMessage(msg, serverVersion = DEFAULT_FALLBACK_VERSION) {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) return null;
  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'usage-monitor', version: serverVersion },
      },
    };
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOL_DEFS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'resources/templates/list') return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

/**
 * 處理完整 MCP JSON-RPC 2.0 訊息（支援非同步 `tools/call`）。
 */
export async function handleMcpJsonRpcRequest(
  msg,
  { serverVersion = DEFAULT_FALLBACK_VERSION, loadTelemetryFn = defaultLoadTelemetry } = {}
) {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) return null;

  const id = msg.id;
  const method = String(msg.method || '');
  if (method !== 'tools/call') {
    return handleMcpJsonRpcMessage(msg, serverVersion);
  }

  const toolName = String(msg.params?.name || '').trim();
  const toolArgs = msg.params?.arguments;
  if (!toolName || !MCP_TOOL_DEFS.some((tool) => tool.name === toolName)) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown tool: ${toolName || '(empty)'}` },
    };
  }

  try {
    const data = await executeReadOnlyMcpTool(toolName, toolArgs, { loadTelemetryFn });
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
        isError: false,
      },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: err?.message || 'Tool execution failed' }],
        isError: true,
      },
    };
  }
}

function startMcpServer() {
  const serverVersion = readMcpServerVersion();
  let shuttingDown = false;
  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);

  function writeJsonRpcResponse(payload, mode) {
    const serialized = JSON.stringify(payload);
    if (mode === 'lsp') {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  async function dispatchParsedPayload(parsed, mode) {
    if (Array.isArray(parsed)) {
      const batchOut = (
        await Promise.all(parsed.map((item) => handleMcpJsonRpcRequest(item, { serverVersion })))
      ).filter(Boolean);
      if (batchOut.length > 0) {
        writeJsonRpcResponse(batchOut, mode);
      }
      return;
    }
    const response = await handleMcpJsonRpcRequest(parsed, { serverVersion });
    if (response) {
      writeJsonRpcResponse(response, mode);
    }
  }

  function drainInputBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx >= 0 ? sepIdx : lfSepIdx;
        const sepLen = sepIdx >= 0 ? 4 : 2;
        if (headerEnd < 0) return;

        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalFrameLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalFrameLen) return;

        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalFrameLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalFrameLen);
        try {
          void dispatchParsedPayload(JSON.parse(bodyStr), 'lsp');
        } catch {
          // 忽略損壞幀
        }
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        void dispatchParsedPayload(JSON.parse(lineStr), framingMode);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exit(0);
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainInputBuffer();
  });

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.resume();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startMcpServer();
}
