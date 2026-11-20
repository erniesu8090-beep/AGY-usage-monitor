import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    assert.equal(def.annotations?.readOnlyHint, true);
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
    '../src/components/layout/WindowOverlayShell.js',
    '../src/components/settings/BridgeStatusNotice.js',
    '../src/views/settings/SettingsAccountTab.js',
  ];
  for (const rel of removedRelPaths) {
    assert.equal(fs.existsSync(new URL(rel, import.meta.url)), false, `${rel} must be removed`);
  }
});
