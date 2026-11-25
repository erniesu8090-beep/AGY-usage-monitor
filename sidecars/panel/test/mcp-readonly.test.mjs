import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createMockDom } from './mock-dom.mjs';
import {
  MCP_TOOL_DEFS,
  handleMcpJsonRpcMessage,
  handleMcpJsonRpcRequest,
  readMcpServerVersion,
} from '../mcp-entry.mjs';

function makeMockTelemetryPayload() {
  return {
    account: { status: 'signedIn', email: 'user@example.com', tierName: 'Pro' },
    quotas: {
      meta: { hasOfficialData: true, isStale: false, refreshFailed: false, error: null },
      activePool: { poolKey: 'Gemini', remainingPct: 82, weeklyRemainingPct: 91 },
      pools: [
        { poolKey: 'Gemini', remainingPct: 82, weeklyRemainingPct: 91 },
        { poolKey: 'Claude & GPT', remainingPct: 65, weeklyRemainingPct: 77 },
      ],
      weekly: { isOfficial: true, poolFamily: 'Gemini' },
    },
    activeConversation: {
      cascadeId: 'conv-123',
      title: 'Test Conversation',
      isRunning: false,
      stepCount: 3,
      activeModelShort: 'gemini-4-hydrogen',
      latestTokPerSec: 88.5,
      avgTokPerSec: 76.2,
      latestTtftSec: 1.4,
      latestStepCostUsd: 0.012,
      sessionCostUsd: 0.045,
      inputTokens: 1200,
      cacheReadTokens: 4800,
      outputTokens: 600,
      totalTokens: 6600,
      latestCacheHitPct: 80.0,
      sessionCacheHitPct: 78.5,
      context: { totalTokens: 6600, compactionLimitTokens: 256000 },
      modelBreakdown: [{ shortName: 'gemini-4-hydrogen', calls: 3, costUsd: 0.045 }],
      recentSteps: [
        { stepIndex: 0, outputTokens: 150 },
        { stepIndex: 1, outputTokens: 200 },
        { stepIndex: 2, outputTokens: 250 },
      ],
    },
    consumption: {
      selectedRange: { key: '7d', label: '7天', startMs: 1000, endMs: 2000 },
      session: { totalTokens: 6600, costUsd: 0.045 },
      account: { totalTokens: 50000, costUsd: 0.5, savedCostUsd: 1.2 },
      presets: { today: { totalTokens: 6600 } },
      sourcesBreakdown: [{ source: 'antigravity', calls: 10 }],
    },
    modelBreakdown: [{ shortName: 'gemini-4-hydrogen', calls: 10 }],
    conversations: [{ cascadeId: 'conv-123' }, { cascadeId: 'conv-456' }],
  };
}

test('mcp_config.json uses usage-monitor and mcp-entry exposes 3 read-only MCP tools', async () => {
  const mcpCfg = JSON.parse(
    fs.readFileSync(new URL('../../../mcp_config.json', import.meta.url), 'utf8')
  );
  assert.ok(mcpCfg.mcpServers['usage-monitor'], 'mcp_config.json must name server usage-monitor');
  assert.equal(mcpCfg.mcpServers.host, undefined);

  const version = readMcpServerVersion();
  assert.equal(version, '1.5.1');

  const initRes = handleMcpJsonRpcMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    version
  );
  assert.equal(initRes.result.serverInfo.name, 'usage-monitor');
  assert.equal(initRes.result.serverInfo.version, '1.5.1');

  const listRes = handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, version);
  assert.deepEqual(
    listRes.result.tools.map((t) => t.name),
    ['get_quota_status', 'get_conversation_usage', 'get_usage_summary']
  );
  for (const def of MCP_TOOL_DEFS) {
    assert.deepEqual(def.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  for (const tool of listRes.result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }

  assert.equal(handleMcpJsonRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

  const calls = [];
  const loadTelemetryFn = async (opts) => {
    calls.push(opts);
    return makeMockTelemetryPayload();
  };

  const quotaRes = await handleMcpJsonRpcRequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_quota_status', arguments: { forceRefresh: true } },
    },
    { serverVersion: version, loadTelemetryFn }
  );
  assert.equal(quotaRes.result.isError, false);
  assert.equal(quotaRes.result.structuredContent.activePool.remainingPct, 82);
  assert.equal(quotaRes.result.structuredContent.uiPanelHint, 'sidecar://usage-monitor/panel/');
  assert.equal(calls[0].force, true);

  const convRes = await handleMcpJsonRpcRequest(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'get_conversation_usage',
        arguments: { conversationId: '../bad/path', includeSteps: true, stepLimit: 2 },
      },
    },
    { serverVersion: version, loadTelemetryFn }
  );
  assert.equal(convRes.result.isError, false);
  assert.equal(convRes.result.structuredContent.uiPanelHint, 'sidecar://usage-monitor/panel/');
  assert.equal(calls[1].conversationId, '');
  assert.equal(convRes.result.structuredContent.recentSteps.length, 2);
  assert.equal(convRes.result.structuredContent.recentSteps[0].stepIndex, 1);

  const summaryRes = await handleMcpJsonRpcRequest(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'get_usage_summary',
        arguments: { range: 'custom', startMs: 1000, endMs: 2000 },
      },
    },
    { serverVersion: version, loadTelemetryFn }
  );
  assert.equal(summaryRes.result.isError, false);
  assert.equal(calls[2].range, 'custom');
  assert.equal(summaryRes.result.structuredContent.conversationsCount, 2);

  const unknownRes = await handleMcpJsonRpcRequest(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'mutate_anything' } },
    { serverVersion: version, loadTelemetryFn }
  );
  assert.equal(unknownRes.error.code, -32602);
});

test('de-intrusive artifacts: SKILL.md, deploy scripts, and removal of CDP/credential modules', () => {
  const skillText = fs.readFileSync(
    new URL('../../../skills/usage-monitor/SKILL.md', import.meta.url),
    'utf8'
  );
  assert.match(skillText, /get_quota_status/);
  assert.match(skillText, /get_conversation_usage/);
  assert.match(skillText, /get_usage_summary/);
  assert.match(skillText, /sidecar:\/\/usage-monitor\/panel\//);

  for (const file of ['deploy.ps1', 'deploy.bat', 'deploy.sh']) {
    assert.equal(fs.existsSync(new URL(`../../../${file}`, import.meta.url)), true, `${file} must exist`);
  }

  const removedRelPaths = [
    '../backend/window-bridge.mjs',
    '../backend/desktop-launcher-config.mjs',
    '../bridge-daemon.mjs',
    '../backend/account-oauth.mjs',
    '../backend/account-switch.mjs',
    '../backend/account-credentials.ps1',
    '../shared/window-bridge-protocol.mjs',
    '../src/components/layout/WindowOverlayShell.js',
    '../src/components/settings/BridgeStatusNotice.js',
    '../src/views/settings/SettingsAccountTab.js',
  ];
  for (const rel of removedRelPaths) {
    assert.equal(fs.existsSync(new URL(rel, import.meta.url)), false, `${rel} must be removed`);
  }

  const pluginJson = JSON.parse(
    fs.readFileSync(new URL('../../../plugin.json', import.meta.url), 'utf8')
  );
  assert.equal(pluginJson.name, 'usage-monitor');
  assert.ok(Array.isArray(pluginJson.suggestedPrompts) && pluginJson.suggestedPrompts.length <= 3);

  const sidecarJson = JSON.parse(
    fs.readFileSync(new URL('../sidecar.json', import.meta.url), 'utf8')
  );
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config?.views?.[0]?.entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
});

test('compiled app.js boots and renders UI shell in Sidecar Webview without runtime errors', async () => {
  const { document, body, makeElement } = createMockDom();
  const root = makeElement('div');
  root.id = 'app-root';
  body.appendChild(root);

  const win = {
    location: { search: '?token=test', href: 'http://127.0.0.1:1/', reload() {} },
    navigator: { language: 'zh-TW', clipboard: { writeText: async () => {} } },
    document,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    sidecar: {
      conversationId: '',
      fetch: async () => ({
        ok: true,
        json: async () => ({
          timestamp: '2026-11-20T08:00:00.000Z',
          hostPlatform: 'win32',
          settings: { language: 'zh-CN', themeAccent: 'host', fontScale: 'md' },
          cloudStatus: {},
          account: { status: 'signedIn', email: 'dev@example.com', planName: 'Pro', totalConversations: 1 },
          runningConversations: [],
          conversations: [],
          activeConversation: {
            cascadeId: '11111111-1111-4111-8111-111111111111',
            title: 'Test',
            status: 'IDLE',
            stepCount: 0,
            agents: [],
            recentSteps: [],
            modelBreakdown: [],
            context: { totalTokens: 0, limitTokens: 512000, usedPct: 0 },
          },
          consumption: {
            selectedRange: { key: 'today', label: '今日' },
            account: { modelBreakdown: [] },
            trendSeries: [],
            sourcesBreakdown: [],
            monthlySeries: [],
          },
          quotas: { meta: { hasOfficialData: true }, pools: [], activePool: null },
        }),
      }),
    },
  };

  const activeTimers = new Set();
  const unrefSetTimeout = (fn, ms, ...args) => {
    const t = setTimeout(fn, ms, ...args);
    t.unref?.();
    activeTimers.add(t);
    return t;
  };
  const unrefClearTimeout = (t) => {
    activeTimers.delete(t);
    clearTimeout(t);
  };
  const unrefSetInterval = (fn, ms, ...args) => {
    const t = setInterval(fn, ms, ...args);
    t.unref?.();
    activeTimers.add(t);
    return t;
  };
  const unrefClearInterval = (t) => {
    activeTimers.delete(t);
    clearInterval(t);
  };

  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  try {
    vm.runInNewContext(appJs, {
      window: win,
      document,
      navigator: win.navigator,
      getComputedStyle: win.getComputedStyle,
      matchMedia: win.matchMedia,
      ResizeObserver: win.ResizeObserver,
      MutationObserver: win.MutationObserver,
      HTMLElement: class {},
      URLSearchParams,
      URL,
      console,
      setTimeout: unrefSetTimeout,
      clearTimeout: unrefClearTimeout,
      setInterval: unrefSetInterval,
      clearInterval: unrefClearInterval,
      queueMicrotask,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakRef,
      Error,
      TypeError,
      Math,
      Date,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      RegExp,
      Intl,
      encodeURIComponent,
      decodeURIComponent,
      requestAnimationFrame: (fn) => unrefSetTimeout(fn, 0),
      cancelAnimationFrame: unrefClearTimeout,
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(root.children.length > 0, 'app-root should render app-shell');
    assert.ok(root.textContent.length > 20, 'rendered panel should contain visible text');
  } finally {
    for (const t of activeTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
  }
});
