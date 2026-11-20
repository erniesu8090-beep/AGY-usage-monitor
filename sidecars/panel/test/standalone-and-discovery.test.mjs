import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  discoverAntigravityLsEndpoint,
  parseLinuxProcNetTcpPorts,
  parseLsArgsFromCommandLine,
  parseSsListeningPorts,
} from '../backend/ls-discovery.mjs';
import {
  createAutoStandaloneHost,
  createStandaloneWebServer,
  isLoopbackBindHost,
  parseStandaloneCliArgs,
} from '../backend/standalone-server.mjs';
import {
  getCacheToneClass,
  getSpeedToneClass,
  getStepCostToneClass,
  getTtftToneClass,
} from '../src/core/formatters.js';
import { setI18nLanguage } from '../src/i18n/index.js';
import {
  resolveCapsuleMetricPresentation,
  resolveOverviewMetricCell,
} from '../src/registries/metricRegistry.js';

test('Step table semantic tone classes (speed/cache/ttft/cost) and domain-aligned overview metric subtexts', () => {
  assert.equal(getSpeedToneClass(null), 'tone-muted');
  assert.equal(getSpeedToneClass(0), 'tone-muted');
  assert.equal(getSpeedToneClass(86.1), 'tone-good');
  assert.equal(getSpeedToneClass(54.9), 'tone-info');
  assert.equal(getSpeedToneClass(24.3), 'tone-warn');
  assert.equal(getSpeedToneClass(7.6), 'tone-danger');

  assert.equal(getCacheToneClass(null), 'tone-muted');
  assert.equal(getCacheToneClass(0, 0), 'tone-muted');
  assert.equal(getCacheToneClass(0, 208700), 'tone-danger');
  assert.equal(getCacheToneClass(59.8, 75400), 'tone-warn');
  assert.equal(getCacheToneClass(77.6, 96400), 'tone-info');
  assert.equal(getCacheToneClass(96.8, 155212), 'tone-good');

  assert.equal(getStepCostToneClass(0.056), '');
  assert.equal(getStepCostToneClass(0.18), 'tone-warn');
  assert.equal(getStepCostToneClass(0.421), 'tone-danger');
  assert.equal(getTtftToneClass(12.1), '');
  assert.equal(getTtftToneClass(22.3), 'tone-warn');
  assert.equal(getTtftToneClass(34.0), 'tone-danger');

  setI18nLanguage('zh-CN');
  const mockActive = {
    stepCount: 787,
    isRunning: false,
    activeAgentBadge: '主',
    activeModelShort: 'gemini-4-carbon',
    latestTokPerSec: 54.9,
    latestTtftSec: 12.1,
    ttftSummary: { avgSec: 14.4 },
    avgTokPerSec: 57.3,
    speedSummary: { sampleCount: 787, excludedCount: 0 },
    latestStepCostUsd: 0.056,
    sessionCostUsd: 46.9,
    sessionUnpricedCalls: 0,
    latestCacheHitPct: 96.8,
    sessionCacheHitPct: 92.4,
    latestPromptTokens: 155212,
    inputTokens: 1_200_000,
    cacheReadTokens: 23_900_000,
    outputTokens: 400_000,
    totalTokens: 25_500_000,
    context: { totalTokens: 158328, compactionLimitTokens: 256000, limitTokens: 256000 },
  };
  const mockQuotas = {
    activePool: {
      poolLabel: 'Carbon',
      family: 'Carbon',
      remainingPct: 42,
      weeklyRemainingPct: 85,
    },
  };

  const stepCostCell = resolveOverviewMetricCell('step_cost', {
    active: mockActive,
    hasSubagents: true,
  });
  assert.equal(stepCostCell.valueText, '$0.056');
  assert.equal(stepCostCell.subText, '累計 $46.90');
  assert.equal(stepCostCell.subClass, 'cell-sub');

  const sessCostCell = resolveOverviewMetricCell('session_cost', {
    active: mockActive,
    hasSubagents: true,
  });
  assert.equal(sessCostCell.valueText, '$46.90');
  assert.equal(sessCostCell.subText, '本次 $0.056');
  assert.equal(sessCostCell.subClass, 'cell-sub');

  const cacheCell = resolveOverviewMetricCell('cache_hit', {
    active: mockActive,
    hasSubagents: true,
  });
  assert.equal(cacheCell.valueText, '96.8%');
  assert.equal(cacheCell.valueClass, 'cell-value tone-good');
  assert.equal(cacheCell.subText, '均值 92.4%');

  const coldCacheCell = resolveOverviewMetricCell('cache_hit', {
    active: { ...mockActive, latestCacheHitPct: 0, latestPromptTokens: 208700 },
  });
  assert.equal(coldCacheCell.valueText, '0%');
  assert.equal(coldCacheCell.valueClass, 'cell-value tone-danger');

  const tokCell = resolveOverviewMetricCell('session_tokens', { active: mockActive });
  assert.equal(tokCell.valueText, '25.5M');
  assert.equal(tokCell.subText, '入 25.1M · 出 400.0k');

  const quotaCell = resolveOverviewMetricCell('quota_tightest', {
    active: mockActive,
    quotas: mockQuotas,
  });
  assert.equal(quotaCell.valueText, '餘 42%');
  assert.equal(quotaCell.subText, 'Carbon 5h · 週 85%');

  const avgTpsCell = resolveOverviewMetricCell('avg_tps', { active: mockActive });
  assert.equal(avgTpsCell.valueClass, 'cell-value tone-info');

  const capBaseCtx = {
    hasTelemetry: true,
    usedPct: 55.8,
    dashOffset: 14,
    isRunning: false,
    tps: 43.7,
    avgTps: 57.3,
    ttft: 22.3,
    stepCost: 0.198,
    sessionCost: 46.9,
    cacheHitPct: 98.5,
    latestPromptTokens: 155212,
    sessionTokens: 25_500_000,
    quotas: mockQuotas,
  };
  assert.equal(
    resolveCapsuleMetricPresentation('tps', capBaseCtx, 32.67).toneClass,
    'tone-info'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('tps', { ...capBaseCtx, isRunning: true, tps: 68.4 }, 32.67).toneClass,
    'tone-good'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('avg_tps', capBaseCtx, 32.67).toneClass,
    'tone-info'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('cache_hit', capBaseCtx, 32.67).toneClass,
    'tone-good'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('cache_hit', { ...capBaseCtx, cacheHitPct: 77.6 }, 32.67).toneClass,
    'tone-info'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('ttft', capBaseCtx, 32.67).toneClass,
    'tone-warn'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('ttft', { ...capBaseCtx, ttft: 16.0 }, 32.67).toneClass,
    ''
  );
  assert.equal(
    resolveCapsuleMetricPresentation('cost', capBaseCtx, 32.67).toneClass,
    'tone-warn'
  );
});

test('Headless CLI LS discovery reads daemon/hub_*.json without subprocesses and falls back to Linux /proc + ss without lsof', async () => {
  const rcParsed = parseLsArgsFromCommandLine(
    '/home/ubuntu/.local/bin/agy remote-control serve --http-port=43120 --csrf-token rc-token-99'
  );
  assert.equal(rcParsed.isHub, true);
  assert.equal(rcParsed.hubPort, 43120);
  assert.equal(rcParsed.csrfToken, 'rc-token-99');

  const cliBinParsed = parseLsArgsFromCommandLine(
    '/usr/local/bin/antigravity-cli --hub --hub-port 51200 --csrf_token=cli-tok'
  );
  assert.equal(cliBinParsed.isHub, true);
  assert.equal(cliBinParsed.hubPort, 51200);
  assert.equal(cliBinParsed.csrfToken, 'cli-tok');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-um-daemon-test-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'hub_dead.json'),
      JSON.stringify({
        pid: 99991,
        httpPort: 19001,
        httpsPort: 19000,
        csrfToken: 'dead-token',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'hub_13019.json'),
      JSON.stringify({
        pid: 42424,
        httpPort: 13019,
        httpsPort: 13018,
        lsVersion: '2.32.1',
        csrfToken: 'live-hub-token',
      }),
      'utf8'
    );

    let subprocessCalled = false;
    const probedUrls = [];
    const foundViaDaemon = await discoverAntigravityLsEndpoint({
      platform: 'linux',
      daemonDirs: [tmpDir],
      isPidAliveFn: (pid) => pid === 42424,
      execCmdFn: async () => {
        subprocessCalled = true;
        return '';
      },
      fetchFn: async (url, init) => {
        probedUrls.push({ url, token: init?.headers?.['x-codeium-csrf-token'] });
        return { ok: url.startsWith('http://127.0.0.1:13019/') };
      },
    });

    assert.equal(subprocessCalled, false);
    assert.equal(probedUrls.length, 1);
    assert.equal(foundViaDaemon?.addr, '127.0.0.1:13019');
    assert.equal(foundViaDaemon?.baseUrl, 'http://127.0.0.1:13019');
    assert.equal(foundViaDaemon?.csrfToken, 'live-hub-token');
    assert.equal(foundViaDaemon?.pid, 42424);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const tcpSample = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:A4D3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 554433 1 0 100 0',
    '   1: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 554434 1 0 100 0',
  ].join('\n');
  assert.deepEqual(parseLinuxProcNetTcpPorts(tcpSample, new Set(['554433', '554434'])), [42195]);

  const foundViaProcFs = await discoverAntigravityLsEndpoint({
    platform: 'linux',
    daemonDirs: [],
    procFs: {
      existsSync: (p) => p === '/proc/7788/fd' || p === '/proc/7788/net/tcp',
      readdirSync: (p) => (p === '/proc/7788/fd' ? ['3', '4'] : []),
      readlinkSync: (p) => (p === '/proc/7788/fd/4' ? 'socket:[554433]' : '/dev/null'),
      readFileSync: () => tcpSample,
    },
    execCmdFn: async (cmd) => {
      if (cmd === 'ps') {
        return '7788 1 /opt/agy/language_server_linux_x64 --csrf_token proc-tok-1\n';
      }
      throw new Error(`Unexpected command ${cmd}`);
    },
    fetchFn: async (url, init) => ({
      ok:
        url.startsWith('http://127.0.0.1:42195/') &&
        init?.headers?.['x-codeium-csrf-token'] === 'proc-tok-1',
    }),
  });
  assert.equal(foundViaProcFs?.addr, '127.0.0.1:42195');
  assert.equal(foundViaProcFs?.csrfToken, 'proc-tok-1');

  const ssSample =
    'LISTEN 0 4096 127.0.0.1:38899 0.0.0.0:* users:(("language_server",pid=8899,fd=7))\n';
  assert.deepEqual(parseSsListeningPorts(ssSample, 8899), [38899]);
});

test('Standalone Web server enforces loopback/non-loopback security boundaries, serves full assets, and supports token cookie/Bearer auth', async () => {
  assert.equal(isLoopbackBindHost('127.0.0.1'), true);
  assert.equal(isLoopbackBindHost('localhost'), true);
  assert.equal(isLoopbackBindHost('::1'), true);
  assert.equal(isLoopbackBindHost('[::1]'), true);
  assert.equal(isLoopbackBindHost('0.0.0.0'), false);
  assert.equal(isLoopbackBindHost('192.168.1.25'), false);

  const parsedArgs = parseStandaloneCliArgs(
    ['--port', '9090', '--host=0.0.0.0', '--token', 's3cr3t'],
    {}
  );
  assert.equal(parsedArgs.port, 9090);
  assert.equal(parsedArgs.host, '0.0.0.0');
  assert.equal(parsedArgs.token, 's3cr3t');

  assert.throws(
    () => createStandaloneWebServer({ host: '0.0.0.0', port: 0, skipStartupDiscovery: true }),
    /Refusing to bind standalone server to non-loopback host "0\.0\.0\.0" without --token/
  );

  const loopSrv = createStandaloneWebServer({
    host: '127.0.0.1',
    port: 0,
    skipStartupDiscovery: true,
    readAssetFn: async (rel) => `ASSET:${rel}`,
    handleApiRequest: async (pathname, method, data) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pathname, method, data }),
    }),
  });

  try {
    const st = await loopSrv.start();
    assert.equal(st.running, true);
    assert.ok(st.port > 0);
    assert.equal(st.loopbackOnly, true);
    assert.equal(st.tokenProtected, false);

    const indexRes = await fetch(`${st.url}/`);
    assert.equal(indexRes.status, 200);
    assert.equal(await indexRes.text(), 'ASSET:index.html');

    const preloadRes = await fetch(`${st.url}/preload.js`);
    assert.equal(preloadRes.status, 200);
    assert.match(await preloadRes.text(), /standalone web mode/);

    const apiRes = await fetch(`${st.url}/api/telemetry?range=today`);
    assert.equal(apiRes.status, 200);
    const apiJson = await apiRes.json();
    assert.deepEqual(apiJson, {
      ok: true,
      pathname: '/api/telemetry',
      method: 'GET',
      data: { range: 'today' },
    });

    const crossSiteRes = await fetch(`${st.url}/api/telemetry`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossSiteRes.status, 403);

    const rebindStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: st.port,
          path: '/api/telemetry',
          method: 'GET',
          headers: { Host: `attacker.rebind.test:${st.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebindStatus, 403);
  } finally {
    await loopSrv.stop();
  }

  const tokenSrv = createStandaloneWebServer({
    host: '127.0.0.1',
    port: 0,
    token: 'cli-remote-secret',
    skipStartupDiscovery: true,
    readAssetFn: async (rel) => `PROTECTED:${rel}`,
    handleApiRequest: async (pathname, method, data) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pathname, method, data }),
    }),
  });

  try {
    const st = await tokenSrv.start();
    assert.equal(st.tokenProtected, true);

    const unauthPage = await fetch(`${st.url}/`);
    assert.equal(unauthPage.status, 401);
    assert.match(await unauthPage.text(), /standalone-auth/);

    const unauthApi = await fetch(`${st.url}/api/telemetry`);
    assert.equal(unauthApi.status, 401);

    const bearerApi = await fetch(`${st.url}/api/telemetry?range=week`, {
      headers: { Authorization: 'Bearer cli-remote-secret' },
    });
    assert.equal(bearerApi.status, 200);

    const loginRedirect = await fetch(`${st.url}/?token=cli-remote-secret`, {
      redirect: 'manual',
    });
    assert.equal(loginRedirect.status, 302);
    assert.equal(loginRedirect.headers.get('location'), '/');
    const setCookie = loginRedirect.headers.get('set-cookie') || '';
    assert.match(setCookie, /ag_um_token=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\//);
    const cookiePair = setCookie.split(';')[0];

    const authedPage = await fetch(`${st.url}/`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(authedPage.status, 200);
    assert.equal(await authedPage.text(), 'PROTECTED:index.html');

    const csrfPost = await fetch(`${st.url}/api/settings`, {
      method: 'POST',
      headers: {
        Cookie: cookiePair,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'en-US' }),
    });
    assert.equal(csrfPost.status, 403);

    const validPost = await fetch(`${st.url}/api/settings`, {
      method: 'POST',
      headers: {
        Cookie: cookiePair,
        Origin: st.url,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'en-US' }),
    });
    assert.equal(validPost.status, 200);
  } finally {
    await tokenSrv.stop();
  }
});

test('createStandaloneWebServer and createAutoStandaloneHost manage runtimeStateFile and EADDRINUSE fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-um-runtime-'));
  const runtimeFile = path.join(tmpDir, 'standalone-runtime.json');
  const occupier = createStandaloneWebServer({
    host: '127.0.0.1',
    port: 0,
    skipStartupDiscovery: true,
    handleApiRequest: async () => ({ status: 200, contentType: 'application/json', body: '{}' }),
    readAssetFn: async (name) => `OCCUPIER:${name}`,
  });

  try {
    const occStatus = await occupier.start();
    const autoHost = createAutoStandaloneHost({
      defaultAutoPort: occStatus.port,
      runtimeStateFile: runtimeFile,
      env: { USAGE_MONITOR_STANDALONE_HOST: '127.0.0.1' },
    });

    try {
      await autoHost.ready();
      const autoStatus = autoHost.getStatus();
      assert.equal(autoStatus.running, true);
      assert.notEqual(autoStatus.port, occStatus.port);
      assert.ok(autoStatus.port >= 1024);

      const persisted = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      assert.equal(persisted.pid, process.pid);
      assert.equal(persisted.port, autoStatus.port);
    } finally {
      await autoHost.stop();
    }

    assert.equal(fs.existsSync(runtimeFile), false);
  } finally {
    await occupier.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
