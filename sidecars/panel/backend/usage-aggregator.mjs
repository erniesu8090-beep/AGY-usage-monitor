/**
 * @fileoverview 多时间窗口解析、用量桶累加、趋势序列、月度序列与分模型/分来源聚合引擎。
 *
 * 负责将内存缓存 (`trajectoryCache`) 与外部深层统计缓存 (`loadExternalDeepStatsCache`)
 * 中的所有步骤按预设窗口（`all`, `5h`, `today`, `24h`, `week`, `7d`, `14d`, `30d`）与当前选定窗口
 * 进行去重遍历聚合，输出前端消费分析与模型明细所需的完整统计结构。
 */

import { isDeepStrictEqual } from 'node:util';
import {
  MEASUREMENT_VERSION,
  accumulateSpeed,
  createSpeedAccumulator,
  finishSpeed,
  parseIsoMs,
} from '../trajectory-metrics.mjs';
import { listCachedTrajectoryEntries, roundMetric } from './config.mjs';
import { loadExternalDeepStatsCache } from './local-scanner.mjs';
import {
  computeStepCost,
  formatUpstreamModelId,
  isArgonModelIdentifier,
  isCarbonModelIdentifier,
} from './model-pricing.mjs';

/** @typedef {ReturnType<import('./model-pricing.mjs').createStepModelResolver>} StepModelResolver */

function safeTok(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeOwnerAccount(val) {
  return typeof val === 'string' ? val.trim().toLowerCase() : '';
}

/**
 * 获取本地当日 00:00:00.000 的毫秒时间戳。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number}
 */
function getStartOfLocalDayMs(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartOfLocalOffsetDaysMs(nowMs, offsetDays) {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 获取本地下一个周一 00:00:00.000 的 ISO 时间字符串（用于自定义本机周限额重置倒计时）。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {string}
 */
export function getNextMondayResetIso(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sun, 1 = Mon ...
  const daysUntilMon = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysUntilMon);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 获取本地本周一 00:00:00.000 的毫秒时间戳。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number}
 */
function getStartOfCurrentWeekMs(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sun, 1 = Mon
  const diffToMon = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMon);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 根据时间范围键名 (`rangeKey`) 与官方配额重置锚点 (`cycleAnchors`) 解析起止毫秒时间戳。
 *
 * @param {string} [rangeKey='all']
 * @param {number} [customStartMs=0]
 * @param {number} [customEndMs=0]
 * @param {number} [nowMs=Date.now()]
 * @param {{ fiveHourResetMs?: number, weeklyResetMs?: number }} [cycleAnchors={}]
 * @returns {{ key: string, label: string, startMs: number, endMs: number }}
 */
function resolveTimeWindow(
  rangeKey = 'all',
  customStartMs = 0,
  customEndMs = 0,
  nowMs = Date.now(),
  cycleAnchors = {}
) {
  const now = new Date(nowMs);
  switch (rangeKey) {
    case '5h': {
      const reset5hMs = cycleAnchors.fiveHourResetMs || 0;
      const start5hMs =
        reset5hMs > nowMs
          ? Math.min(nowMs, reset5hMs - 5 * 3600 * 1000)
          : nowMs - 5 * 3600 * 1000;
      return {
        key: '5h',
        label: reset5hMs > nowMs ? '目前 5h 週期' : '近 5 小時',
        startMs: start5hMs,
        endMs: nowMs,
      };
    }
    case 'today':
      return { key: 'today', label: '今日', startMs: getStartOfLocalDayMs(now), endMs: nowMs };
    case '24h':
      return { key: '24h', label: '近 24 小時', startMs: nowMs - 24 * 3600 * 1000, endMs: nowMs };
    case 'week': {
      const resetWkMs = cycleAnchors.weeklyResetMs || 0;
      const startWkMs =
        resetWkMs > nowMs
          ? Math.min(nowMs, resetWkMs - 7 * 24 * 3600 * 1000)
          : getStartOfCurrentWeekMs(now);
      return {
        key: 'week',
        label: resetWkMs > nowMs ? '目前週限週期' : '本週',
        startMs: startWkMs,
        endMs: nowMs,
      };
    }
    case '7d':
      return {
        key: '7d',
        label: '近 7 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 7),
        endMs: nowMs,
      };
    case '14d':
      return {
        key: '14d',
        label: '近 14 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 14),
        endMs: nowMs,
      };
    case '30d':
      return {
        key: '30d',
        label: '近 30 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 30),
        endMs: nowMs,
      };
    case 'custom': {
      const s = Number(customStartMs) > 0 ? Number(customStartMs) : 0;
      const e = Number(customEndMs) > 0 ? Number(customEndMs) : nowMs;
      return {
        key: 'custom',
        label: '自訂時段',
        startMs: Math.min(s, e),
        endMs: Math.max(s, e),
      };
    }
    case 'all':
    default:
      return { key: 'all', label: '全部時間', startMs: 0, endMs: Infinity };
  }
}

/**
 * 创建一个空的用量统计累加桶。
 */
function createUsageBucket() {
  return {
    calls: 0,
    conversationsSet: new Set(),
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    savedCostUsd: 0,
  };
}

/**
 * 将单个模型步骤的 Token 与成本累加至目标统计桶。
 *
 * @param {ReturnType<typeof createUsageBucket>} bucket
 * @param {object} usage 已归一化的单步用量
 * @param {string} cascadeId 会话标识
 */
function accumulateStepIntoBucket(bucket, usage, cascadeId) {
  const { inTok, cacheTok, outTok, thinkTok, respTok, stepTotalTokens,
    resolvedCost, savedCost, unpriced } = usage;
  if (unpriced) bucket.unpricedCalls = (bucket.unpricedCalls || 0) + 1;
  bucket.calls += 1;
  if (cascadeId) bucket.conversationsSet.add(cascadeId);
  bucket.inputTokens += inTok;
  bucket.cacheReadTokens += cacheTok;
  bucket.outputTokens += outTok;
  bucket.thinkingTokens += thinkTok;
  bucket.responseTokens += respTok;
  bucket.totalTokens += stepTotalTokens;
  bucket.costUsd += resolvedCost;
  bucket.savedCostUsd += savedCost;
}

/**
 * 将累加完成的用量桶定型为可序列化的前端统计结构（计算缓存命中率并舍入金额）。
 *
 * @param {ReturnType<typeof createUsageBucket>} bucket
 */
function finalizeUsageBucket(bucket) {
  const promptTokens = bucket.inputTokens + bucket.cacheReadTokens;
  const cacheHitPct =
    promptTokens > 0 ? +((bucket.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
  return {
    calls: bucket.calls,
    conversationsCount: bucket.conversationsSet.size,
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    thinkingTokens: bucket.thinkingTokens,
    responseTokens: bucket.responseTokens,
    totalTokens: bucket.totalTokens,
    costUsd: +bucket.costUsd.toFixed(2),
    unpricedCalls: bucket.unpricedCalls || 0,
    savedCostUsd: +bucket.savedCostUsd.toFixed(2),
    cacheHitPct,
  };
}

/**
 * 将单步统计数据累加至按模型分组的映射表中（供单代理、主+子汇总与全局时间范围共用）。
 *
 * @param {Map<string, object>} perModelStats
 * @param {object} st
 * @param {object} mInfo
 * @param {number|null} stepCost
 */
function accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost) {
  const inTok = safeTok(st?.inputTokens);
  const cacheTok = safeTok(st?.cacheReadTokens);
  const outTok = safeTok(st?.outputTokens);
  const thinkTok = safeTok(st?.thinkingTokens);
  const respTok =
    st?.responseTokens !== undefined && st?.responseTokens !== null
      ? safeTok(st.responseTokens)
      : Math.max(0, outTok - thinkTok);
  const stepTotalTokens = inTok + cacheTok + outTok;
  const unpriced = stepCost === null ? 1 : 0;
  const modelGroupKey = mInfo.baseLabel || mInfo.label;

  if (!perModelStats.has(modelGroupKey)) {
    perModelStats.set(modelGroupKey, {
      label: modelGroupKey,
      shortName: mInfo.shortName,
      fallbackModelId:
        mInfo.modelId && mInfo.modelId !== 'unknown'
          ? formatUpstreamModelId(mInfo.modelId, mInfo)
          : '',
      upstreamModelCounts: new Map(),
      family: mInfo.family,
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      ttftSumSec: 0,
      ttftSampleCount: 0,
      speedAccumulator: createSpeedAccumulator(),
    });
  }
  const agg = perModelStats.get(modelGroupKey);
  if (st.responseModel) {
    const formattedResp = formatUpstreamModelId(st.responseModel, mInfo);
    agg.upstreamModelCounts.set(
      formattedResp,
      (agg.upstreamModelCounts.get(formattedResp) || 0) + 1
    );
  }
  accumulateSpeed(agg.speedAccumulator, st);
  if (
    !st.isCompactionStep &&
    st.measurementVersion === MEASUREMENT_VERSION &&
    st.isComplete &&
    Number.isFinite(st.totalDurationSec) &&
    Number.isFinite(st.nativeTtftSec) &&
    st.nativeTtftSec >= 0 &&
    st.nativeTtftSec <= st.totalDurationSec + 0.01
  ) {
    agg.ttftSumSec += st.nativeTtftSec;
    agg.ttftSampleCount += 1;
  }

  agg.calls += 1;
  agg.inputTokens += inTok;
  agg.cacheReadTokens += cacheTok;
  agg.outputTokens += outTok;
  agg.thinkingTokens += thinkTok;
  agg.responseTokens += respTok;
  agg.totalTokens += stepTotalTokens;
  agg.costUsd += Number.isFinite(stepCost) ? stepCost : 0;
  agg.unpricedCalls = (agg.unpricedCalls || 0) + unpriced;
}

/**
 * 将按模型分组的统计映射表定型并排序为前端可渲染数组。
 *
 * @param {Map<string, object>} perModelStats
 * @returns {object[]}
 */
function finalizeModelBreakdownMap(perModelStats) {
  return Array.from(perModelStats.values())
    .sort((a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label)))
    .map(
      ({
        speedAccumulator,
        upstreamModelCounts,
        fallbackModelId,
        ttftSumSec,
        ttftSampleCount,
        ...m
      }) => {
        const sortedUpstream = Array.from((upstreamModelCounts || new Map()).entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        const primaryUpstream =
          sortedUpstream.length > 0 ? sortedUpstream[0] : fallbackModelId || m.shortName || m.label;
        const finishedSpeed = finishSpeed(speedAccumulator);
        const promptTokens = m.inputTokens + m.cacheReadTokens;
        const cacheHitPct =
          promptTokens > 0 ? +((m.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
        const avgTtftSec =
          ttftSampleCount > 0 ? roundMetric(ttftSumSec / ttftSampleCount) : null;
        return {
          ...m,
          upstreamName: primaryUpstream,
          upstreamModels: sortedUpstream,
          costUsd: +m.costUsd.toFixed(6),
          cacheHitPct,
          avgTtftSec,
          ttftSampleCount,
          avgTokPerSec: roundMetric(finishedSpeed.avgTokPerSec),
          speedSummary: finishedSpeed,
        };
      }
    );
}

/**
 * 针对给定步骤数组构建按模型聚合的统计列表（供单代理、主+子汇总及全局时间范围复用）。
 *
 * @param {object[]} [steps=[]]
 * @param {StepModelResolver} resolveStepModel
 * @returns {object[]}
 */
export function buildScopedModelBreakdown(steps, resolveStepModel) {
  const perModelStats = new Map();
  for (const st of steps) {
    if (!st || typeof st !== 'object') continue;
    const mInfo = resolveStepModel(st);
    const stepCost = computeStepCost(st, mInfo.pricing);
    accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
  }
  return finalizeModelBreakdownMap(perModelStats);
}

let lastUsageSnapshot = null;
const MAX_TREND_TIMESTAMP_MS = 8_640_000_000_000_000;

function planUsageTrend(window, nowMs, earliest, latest) {
  const safeMs = (value, fallback) =>
    Number.isFinite(value) && value > 0 && value <= MAX_TREND_TIMESTAMP_MS ? value : fallback;
  const end = Math.max(safeMs(window.endMs, Math.max(nowMs, latest || nowMs)), latest);
  const defaultStart = end - 24 * 3600 * 1000;
  const start = window.key === 'all'
    ? Math.min(safeMs(earliest, defaultStart), end - 3600 * 1000)
    : Math.min(safeMs(window.startMs, defaultStart), end);
  const hourly = window.key === 'today' || window.key === '24h' || window.key === '5h' ||
    end - start <= 72 * 3600 * 1000;
  const first = new Date(start);
  const last = new Date(end);
  if (hourly) {
    first.setMinutes(0, 0, 0);
    last.setMinutes(0, 0, 0);
  } else {
    first.setHours(0, 0, 0, 0);
    last.setHours(0, 0, 0, 0);
  }
  return { start, end, hourly, first: first.getTime(), last: last.getTime() };
}

function sameUsageEntries(previous, current) {
  return previous.length === current.length && current.every((entry, index) => {
    const before = previous[index];
    return entry.steps === before.steps && entry.cascadeId === before.cascadeId &&
      entry.appSource === before.appSource && entry.accountName === before.accountName &&
      entry.isCurrentConv === before.isCurrentConv;
  });
}

function sortedUsageTimestamps(entries) {
  const dates = new Float64Array(entries.reduce((sum, entry) => sum + entry.steps.length, 0));
  let count = 0;
  for (const { steps } of entries) {
    for (const step of steps) {
      const date = Number(step?.createdAtMs);
      if (date > 0) dates[count++] = date;
    }
  }
  return dates.subarray(0, count).sort();
}

function usageTimestampBoundary(dates, value, inclusive) {
  let start = 0;
  let end = dates.length;
  while (start < end) {
    const i = (start + end) >>> 1;
    if (dates[i] < value || (inclusive && dates[i] === value)) start = i + 1;
    else end = i;
  }
  return start;
}

function sameUsageWindows(previous, current, dates) {
  return previous.length === current.length && current.every((window, index) => {
    const before = previous[index];
    if (before.key !== window.key || before.label !== window.label) return false;
    if (window.key === 'custom') {
      return before.startMs === window.startMs && before.endMs === window.endMs;
    }
    return (
      (before.startMs === window.startMs ||
        usageTimestampBoundary(dates, before.startMs, false) ===
          usageTimestampBoundary(dates, window.startMs, false)) &&
      (before.endMs === window.endMs ||
        usageTimestampBoundary(dates, before.endMs, true) ===
          usageTimestampBoundary(dates, window.endMs, true))
    );
  });
}

/**
 * 聚合所有预设时间窗口、当前选定窗口、趋势图、年度月序列、来源占比与分模型统计。
 *
 * @param {{
 *   filterOpts?: { range?: string, startMs?: number, endMs?: number },
 *   cycleAnchors?: { fiveHourResetMs?: number, weeklyResetMs?: number },
 *   currentAccountName?: string|null,
 *   activeCascadeId?: string|null,
 *   activeFamilyCascadeIds?: Set<string>|null,
 *   resolveStepModel: StepModelResolver
 *   modelInputs?: { catalogRevision: number, dynamicModelMap: Map }
 * }} params
 */
export function aggregateMultiWindowUsage({
  filterOpts = {},
  cycleAnchors = {},
  currentAccountName = '',
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  quotaPoolsMap = null,
  modelInputs = null,
}) {
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs,
    cycleAnchors
  );

  const presetKeys = ['all', '5h', 'today', '24h', 'week', '7d', '14d', '30d'];
  const presetWindows = {};
  const accountBuckets = {};
  const sessionBuckets = {};

  for (const k of presetKeys) {
    presetWindows[k] = resolveTimeWindow(k, 0, 0, nowMs, cycleAnchors);
    accountBuckets[k] = createUsageBucket();
    sessionBuckets[k] = createUsageBucket();
  }

  // 为每个配额池建立独立的 5h 与周限周期统计桶（按各池自身的 resetTime / weeklyResetTime 截取窗口）
  const poolCycleBuckets = new Map();
  if (quotaPoolsMap instanceof Map && quotaPoolsMap.size > 0) {
    const weekFallbackStartMs = getStartOfCurrentWeekMs(new Date(nowMs));
    for (const [poolKey, poolObj] of quotaPoolsMap.entries()) {
      const reset5hMs = parseIsoMs(poolObj?.resetTime) || 0;
      const start5hMs =
        reset5hMs > nowMs
          ? Math.min(nowMs, reset5hMs - 5 * 3600 * 1000)
          : nowMs - 5 * 3600 * 1000;
      const resetWkMs = parseIsoMs(poolObj?.weeklyResetTime) || 0;
      const startWkMs =
        resetWkMs > nowMs
          ? Math.min(nowMs, resetWkMs - 7 * 24 * 3600 * 1000)
          : weekFallbackStartMs;
      poolCycleBuckets.set(poolKey, {
        start5hMs,
        startWkMs,
        b5h: createUsageBucket(),
        bWk: createUsageBucket(),
      });
    }
  }
  const hasDedicatedCarbonPool = poolCycleBuckets.has('Carbon');
  const hasDedicatedArgonPool = poolCycleBuckets.has('Argon');
  const poolByModel = new Map();
  const quotaWeekBucket = createUsageBucket();
  const normalizedQuotaAccount =
    currentAccountName === null ? null : normalizeOwnerAccount(currentAccountName);
  const selectedAccountBucket = accountBuckets[selectedWindow.key] || createUsageBucket();
  const selectedSessionBucket = sessionBuckets[selectedWindow.key] || createUsageBucket();
  const perModelStats = new Map();
  const selectedWindowSteps = [];
  let earliestSelectedStepMs = Infinity;
  let latestSelectedStepMs = 0;

  const currentYear = new Date(nowMs).getFullYear();
  const monthBoundsMs = Array.from({ length: 13 }, (_, idx) =>
    new Date(currentYear, idx, 1).getTime()
  );
  const yearStartMs = monthBoundsMs[0];
  const nextYearStartMs = monthBoundsMs[12];
  const monthlySeries = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    label: `${idx + 1}月`,
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    responseTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  }));

  const SOURCE_LABELS = {
    standalone: 'Antigravity App',
    ide: 'Antigravity IDE',
    cli: 'Antigravity CLI',
  };
  const perSourceStats = new Map();
  const externalConvos = loadExternalDeepStatsCache();

  // 构建大小写归一化的内存缓存与跨端深层缓存索引，彻底杜绝 `${appSource}:${cascadeId}` 键不匹配导致的双倍重复计费
  const allLiveByLower = new Map();
  for (const [rawId, entry] of listCachedTrajectoryEntries()) {
    const cidLower = String(rawId || '').toLowerCase();
    if (!cidLower || !entry || typeof entry !== 'object') continue;
    const prev = allLiveByLower.get(cidLower);
    if (!prev || (entry.steps?.length || 0) > (prev.steps?.length || 0)) {
      allLiveByLower.set(cidLower, entry);
    }
  }

  const externalByCid = new Map();
  for (const ext of externalConvos.values()) {
    const extCidLower = String(ext?.cascadeId || '').toLowerCase();
    if (!extCidLower) continue;
    const prevExt = externalByCid.get(extCidLower);
    if (!prevExt || (ext.steps?.length || 0) > (prevExt.steps?.length || 0)) {
      externalByCid.set(extCidLower, ext);
    }
  }

  const allEntriesToAggregate = [];

  for (const [cidLower, entry] of allLiveByLower.entries()) {
    const extMatch = externalByCid.get(cidLower);
    if (extMatch && (extMatch.steps?.length || 0) > (entry?.steps?.length || 0)) {
      continue;
    }
    const groupCascadeId = String(
      entry?.rootConversationId || entry?.parentConversationId || cidLower
    ).toLowerCase();
    allEntriesToAggregate.push({
      cascadeId: groupCascadeId,
      appSource: entry?.appSource || 'standalone',
      accountName: entry?.accountName || extMatch?.accountName || '',
      steps: entry?.steps || [],
      isCurrentConv: familySet.has(cidLower),
    });
  }

  for (const [extCidLower, ext] of externalByCid.entries()) {
    const liveEntry = allLiveByLower.get(extCidLower);
    if (liveEntry && (liveEntry.steps?.length || 0) >= (ext.steps?.length || 0)) {
      continue;
    }
    const groupCascadeId = String(
      liveEntry?.rootConversationId || liveEntry?.parentConversationId || extCidLower
    ).toLowerCase();
    allEntriesToAggregate.push({
      cascadeId: groupCascadeId,
      appSource: ext.appSource || 'ide',
      accountName: ext.accountName || liveEntry?.accountName || '',
      steps: ext.steps || [],
      isCurrentConv: familySet.has(extCidLower),
    });
  }

  const timeZone = modelInputs ? new Intl.DateTimeFormat().resolvedOptions().timeZone : '';
  const quotaWindows = Array.from(poolCycleBuckets, ([key, { start5hMs, startWkMs }]) => [
    { key: `${key}:5h`, startMs: start5hMs, endMs: nowMs },
    { key: `${key}:week`, startMs: startWkMs, endMs: nowMs },
  ]).flat();
  const windows = [selectedWindow, ...Object.values(presetWindows), ...quotaWindows];
  const snapshot = lastUsageSnapshot;
  const sameSnapshot = modelInputs && snapshot && timeZone === snapshot.timeZone &&
    currentYear === snapshot.currentYear &&
    normalizedQuotaAccount === snapshot.normalizedQuotaAccount &&
    modelInputs.catalogRevision === snapshot.modelInputs.catalogRevision &&
    isDeepStrictEqual(modelInputs.dynamicModelMap, snapshot.modelInputs.dynamicModelMap) &&
    sameUsageEntries(snapshot.entries, allEntriesToAggregate);
  const previous = sameSnapshot ? snapshot.ranges.get(selectedWindow.key) : null;
  if (previous) {
    // 时钟继续前进，只有实际有步骤跨过窗口边界时才重新聚合。
    const trend = planUsageTrend(selectedWindow, nowMs, previous.earliest, previous.latest);
    if (
      trend.hourly === previous.trend.hourly && trend.first === previous.trend.first &&
      trend.last === previous.trend.last &&
      sameUsageWindows(previous.windows, windows,
        snapshot.dates ??= sortedUsageTimestamps(allEntriesToAggregate))
    ) {
      snapshot.ranges.delete(selectedWindow.key);
      snapshot.ranges.set(selectedWindow.key, previous);
      return { ...previous.result, selectedWindow, trendStartMs: trend.start, trendEndMs: trend.end };
    }
  }

  for (const entry of allEntriesToAggregate) {
    const { cascadeId, isCurrentConv } = entry;
    const entryOwner = normalizeOwnerAccount(entry.accountName);
    const srcKey = entry.appSource || 'standalone';
    const srcName = SOURCE_LABELS[srcKey] || `Antigravity (${srcKey})`;

    for (const st of entry.steps || []) {
      if (!st || typeof st !== 'object') continue;
      const stepOwner = normalizeOwnerAccount(st.accountName) || entryOwner;
      const includeInQuotaPools =
        normalizedQuotaAccount === null
          ? false
          : normalizedQuotaAccount === ''
            ? true
            : stepOwner === normalizedQuotaAccount;
      const mInfo = resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = { inTok, cacheTok, outTok, thinkTok, respTok, stepTotalTokens,
        resolvedCost, savedCost, unpriced };

      if (tMs >= yearStartMs && tMs < nextYearStartMs) {
        let monthIdx = 11;
        for (let m = 0; m < 12; m++) {
          if (tMs < monthBoundsMs[m + 1]) {
            monthIdx = m;
            break;
          }
        }
        const mBucket = monthlySeries[monthIdx];
        if (mBucket) {
          mBucket.calls += 1;
          mBucket.inputTokens += inTok;
          mBucket.cacheReadTokens += cacheTok;
          mBucket.responseTokens += respTok;
          mBucket.thinkingTokens += thinkTok;
          mBucket.totalTokens += stepTotalTokens;
          mBucket.costUsd += resolvedCost;
          mBucket.unpricedCalls = (mBucket.unpricedCalls || 0) + unpriced;
        }
      }

      for (const k of presetKeys) {
        const w = presetWindows[k];
        if (k === 'all' || (tMs > 0 && tMs >= w.startMs && tMs <= w.endMs)) {
          accumulateStepIntoBucket(accountBuckets[k], stepUsage, cascadeId);
          if (isCurrentConv) {
            accumulateStepIntoBucket(sessionBuckets[k], stepUsage, cascadeId);
          }
          if (k === 'week' && includeInQuotaPools) {
            accumulateStepIntoBucket(quotaWeekBucket, stepUsage, cascadeId);
          }
        }
      }

      if (includeInQuotaPools && poolCycleBuckets.size > 0 && tMs > 0 && tMs <= nowMs) {
        let cachedPool = poolByModel.get(mInfo);
        if (!cachedPool || cachedPool.key !== st.modelKey ||
            cachedPool.response !== st.responseModel || cachedPool.displayName !== st.modelDisplayName) {
          const ids = [st.modelKey, st.responseModel, mInfo.modelId, mInfo.label, st.modelDisplayName];
          let poolKey = null;
          if (hasDedicatedCarbonPool && isCarbonModelIdentifier(...ids)) poolKey = 'Carbon';
          else if (hasDedicatedArgonPool && isArgonModelIdentifier(...ids)) poolKey = 'Argon';
          else if (mInfo.family === 'Gemini') poolKey = 'Gemini';
          else if (['Claude', 'GPT', 'Other'].includes(mInfo.family)) poolKey = 'Claude & GPT';
          cachedPool = {
            key: st.modelKey, response: st.responseModel, displayName: st.modelDisplayName,
            bucket: poolCycleBuckets.get(poolKey),
          };
          poolByModel.set(mInfo, cachedPool);
        }
        const poolBucketEntry = cachedPool.bucket;
        if (poolBucketEntry) {
          if (tMs >= poolBucketEntry.start5hMs) {
            accumulateStepIntoBucket(poolBucketEntry.b5h, stepUsage, cascadeId);
          }
          if (tMs >= poolBucketEntry.startWkMs) {
            accumulateStepIntoBucket(poolBucketEntry.bWk, stepUsage, cascadeId);
          }
        }
      }

      const inSelectedWindow =
        selectedWindow.key === 'all' ||
        (tMs > 0 && tMs >= selectedWindow.startMs && tMs <= selectedWindow.endMs);

      if (inSelectedWindow) {
        if (selectedWindow.key === 'custom') {
          accumulateStepIntoBucket(selectedAccountBucket, stepUsage, cascadeId);
          if (isCurrentConv) {
            accumulateStepIntoBucket(selectedSessionBucket, stepUsage, cascadeId);
          }
        }
        if (tMs > 0) {
          if (tMs < earliestSelectedStepMs) earliestSelectedStepMs = tMs;
          if (tMs > latestSelectedStepMs && tMs <= MAX_TREND_TIMESTAMP_MS) latestSelectedStepMs = tMs;
          selectedWindowSteps.push({
            tMs,
            tokens: stepTotalTokens,
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            outputTokens: outTok,
            costUsd: resolvedCost,
            unpricedCalls: unpriced,
          });
        }

        if (!perSourceStats.has(srcKey)) {
          perSourceStats.set(srcKey, {
            name: srcName,
            calls: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            responseTokens: 0,
            thinkingTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          });
        }
        const sAgg = perSourceStats.get(srcKey);
        sAgg.calls += 1;
        sAgg.inputTokens += inTok;
        sAgg.cacheReadTokens += cacheTok;
        sAgg.responseTokens += respTok;
        sAgg.thinkingTokens += thinkTok;
        sAgg.totalTokens += stepTotalTokens;
        sAgg.costUsd += resolvedCost;
        sAgg.unpricedCalls = (sAgg.unpricedCalls || 0) + unpriced;

        accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
      }
    }
  }

  for (const mBucket of monthlySeries) {
    mBucket.costUsd = +mBucket.costUsd.toFixed(4);
  }

  // 构建当前选定时间窗口的自适应自然整点/整日趋势序列 (trendSeries)
  const trend = planUsageTrend(selectedWindow, nowMs, earliestSelectedStepMs, latestSelectedStepMs);
  const { start: trendStartMs, end: trendEndMs, hourly: useHourly } = trend;
  const pad2 = (n) => String(n).padStart(2, '0');
  const WEEKDAY_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  const trendSeries = [];
  if (useHourly) {
    let firstHourMs = trend.first;
    let lastHourMs = trend.last;
    if (selectedWindow.key === 'today') {
      const minTodayEndMs = firstHourMs + 5 * 3600 * 1000;
      if (lastHourMs < minTodayEndMs) {
        lastHourMs = minTodayEndMs;
      }
    } else if (lastHourMs - firstHourMs < 5 * 3600 * 1000) {
      firstHourMs = lastHourMs - 5 * 3600 * 1000;
    }

    const totalHours = Math.max(2, Math.round((lastHourMs - firstHourMs) / (3600 * 1000)) + 1);
    const stepHours = totalHours > 72 ? Math.ceil(totalHours / 48) : 1;
    const slotMs = stepHours * 3600 * 1000;
    const slotCount = Math.max(2, Math.ceil((lastHourMs - firstHourMs + 3600 * 1000) / slotMs));

    const firstD = new Date(firstHourMs);
    const lastD = new Date(firstHourMs + (slotCount - 1) * slotMs);
    const isSameDay =
      firstD.getFullYear() === lastD.getFullYear() &&
      firstD.getMonth() === lastD.getMonth() &&
      firstD.getDate() === lastD.getDate();

    for (let idx = 0; idx < slotCount; idx++) {
      const sMs = firstHourMs + idx * slotMs;
      const eMs = sMs + slotMs;
      const sd = new Date(sMs);
      const ed = new Date(eMs);
      if (Number.isNaN(sd.getTime())) continue;
      const hh = `${pad2(sd.getHours())}:00`;
      const endHh = `${pad2(ed.getHours())}:00`;
      const dateStr = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const axisLabel = isSameDay ? hh : `${dateStr} ${hh}`;
      const fullLabel = `${sd.getMonth() + 1}月${sd.getDate()}日 ${hh} - ${endHh}`;
      trendSeries.push({
        index: idx,
        startMs: sMs,
        endMs: eMs,
        granularity: 'hour',
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        calls: 0,
      });
    }
  } else {
    const firstDayMs = trend.first;
    const lastDayMs = trend.last;
    const dayStarts = [];
    const cursor = new Date(firstDayMs);
    cursor.setHours(0, 0, 0, 0);
    let safety = 0;
    while (cursor.getTime() <= lastDayMs && safety < 3660) {
      dayStarts.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      safety++;
    }
    while (dayStarts.length < 2) {
      const prev = new Date(dayStarts[0] || firstDayMs);
      prev.setDate(prev.getDate() - 1);
      prev.setHours(0, 0, 0, 0);
      dayStarts.unshift(prev.getTime());
    }

    const firstYear = new Date(dayStarts[0]).getFullYear();
    const lastYear = new Date(dayStarts[dayStarts.length - 1]).getFullYear();
    const showFullYear = firstYear !== lastYear || dayStarts.length > 90;

    for (let i = 0; i < dayStarts.length; i++) {
      const sMs = dayStarts[i];
      const endCursor = new Date(sMs);
      endCursor.setDate(endCursor.getDate() + 1);
      endCursor.setHours(0, 0, 0, 0);
      const eMs = endCursor.getTime();

      const sd = new Date(sMs);
      const axisLabel = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const datePrefix = showFullYear ? `${sd.getFullYear()}年` : '';
      const fullLabel = `${datePrefix}${sd.getMonth() + 1}月${sd.getDate()}日 (${WEEKDAY_NAMES[sd.getDay()]})`;

      trendSeries.push({
        index: i,
        startMs: sMs,
        endMs: eMs,
        granularity: 'day',
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        calls: 0,
      });
    }
  }

  if (trendSeries.length > 0) {
    const firstBucketStart = trendSeries[0].startMs;
    const lastIdx = trendSeries.length - 1;
    let previousBucketIndex = 0;
    for (const item of selectedWindowSteps) {
      let targetIdx = lastIdx;
      const previousBucket = trendSeries[previousBucketIndex];
      if (item.tMs <= firstBucketStart) {
        targetIdx = 0;
      } else if (item.tMs >= previousBucket.startMs && item.tMs < previousBucket.endMs) {
        targetIdx = previousBucketIndex;
      } else {
        // 二分查找匹配的时间桶 [startMs, endMs)
        let lo = 0;
        let hi = lastIdx;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const b = trendSeries[mid];
          if (item.tMs < b.startMs) {
            hi = mid - 1;
          } else if (item.tMs >= b.endMs && mid < lastIdx) {
            lo = mid + 1;
          } else {
            targetIdx = mid;
            break;
          }
        }
      }
      previousBucketIndex = targetIdx;
      const bucket = trendSeries[targetIdx];
      bucket.tokens += item.tokens;
      bucket.inputTokens += item.inputTokens || 0;
      bucket.cacheReadTokens += item.cacheReadTokens || 0;
      bucket.outputTokens += item.outputTokens || 0;
      bucket.costUsd += item.costUsd;
      bucket.unpricedCalls = (bucket.unpricedCalls || 0) + item.unpricedCalls;
      bucket.calls += 1;
    }
    for (const b of trendSeries) {
      b.costUsd = +b.costUsd.toFixed(4);
    }
  }

  const finalizedPresets = {};
  for (const k of presetKeys) {
    finalizedPresets[k] = {
      label: presetWindows[k].label,
      session: finalizeUsageBucket(sessionBuckets[k]),
      account: finalizeUsageBucket(accountBuckets[k]),
    };
  }

  const finalizedSelectedSession = finalizeUsageBucket(selectedSessionBucket);
  const finalizedSelectedAccount = finalizeUsageBucket(selectedAccountBucket);

  const sourcesBreakdown = Array.from(perSourceStats.values())
    .filter((s) => s.totalTokens > 0 || s.calls > 0)
    .map((s) => ({
      ...s,
      costUsd: +s.costUsd.toFixed(2),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  const todayBucket = finalizedPresets.today.account;
  const weekBucket = finalizedPresets.week.account;
  const finalizedQuotaWeekBucket = finalizeUsageBucket(quotaWeekBucket);
  const modelBreakdown = finalizeModelBreakdownMap(perModelStats);

  const formatCycleSummary = (b) => {
    const fin = finalizeUsageBucket(b);
    return {
      calls: fin.calls,
      tokens: fin.totalTokens,
      inputTokens: fin.inputTokens,
      cacheReadTokens: fin.cacheReadTokens,
      outputTokens: fin.outputTokens,
      costUsd: fin.costUsd,
      unpricedCalls: fin.unpricedCalls,
    };
  };

  const poolCycleStats = new Map();
  let rawPoolsWeeklyCalls = 0;
  let rawPoolsWeeklyTokens = 0;
  let rawPoolsWeeklyCostUsd = 0;
  let rawPoolsWeeklyUnpricedCalls = 0;
  for (const [poolKey, entry] of poolCycleBuckets.entries()) {
    poolCycleStats.set(poolKey, {
      cycle5h: formatCycleSummary(entry.b5h),
      cycleWeekly: formatCycleSummary(entry.bWk),
    });
    rawPoolsWeeklyCalls += entry.bWk.calls;
    rawPoolsWeeklyTokens += entry.bWk.totalTokens;
    rawPoolsWeeklyCostUsd += entry.bWk.costUsd;
    rawPoolsWeeklyUnpricedCalls += entry.bWk.unpricedCalls || 0;
  }
  const poolsWeeklySummary =
    poolCycleBuckets.size > 0
      ? {
          calls: rawPoolsWeeklyCalls,
          tokens: rawPoolsWeeklyTokens,
          costUsd: +rawPoolsWeeklyCostUsd.toFixed(2),
          unpricedCalls: rawPoolsWeeklyUnpricedCalls,
        }
      : null;

  const result = {
    selectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    finalizedPresets,
    trendSeries,
    sourcesBreakdown,
    currentYear,
    monthlySeries,
    todayBucket,
    weekBucket,
    quotaWeekBucket: finalizedQuotaWeekBucket,
    modelBreakdown,
    poolCycleStats,
    poolsWeeklySummary,
  };
  if (modelInputs) {
    if (!sameSnapshot) {
      lastUsageSnapshot = {
        timeZone,
        modelInputs,
        currentYear,
        normalizedQuotaAccount,
        entries: allEntriesToAggregate,
        dates: null,
        ranges: new Map(),
      };
    }
    const { ranges } = lastUsageSnapshot;
    ranges.delete(selectedWindow.key);
    ranges.set(selectedWindow.key, {
      windows, trend, result, earliest: earliestSelectedStepMs, latest: latestSelectedStepMs,
    });
    // 侧栏和悬浮窗可同时查看不同范围，共用时间索引并最多保留两份聚合结果。
    if (ranges.size > 2) ranges.delete(ranges.keys().next().value);
  }
  return result;
}
