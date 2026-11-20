/**
 * @fileoverview Reactive telemetry store with async non-overlapping poll scheduler
 * and granular slice updates.
 */

import { createReactiveStore } from '../core/reactive.js';
import { callSidecarApi, isWindowOverlayMode } from '../core/httpClient.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  formatLiveActivityDetail,
  formatLiveActivityLabel,
  getAgentBadgeClass,
} from '../core/formatters.js';
import { normalizeI18nLanguage, t } from '../i18n/index.js';
import { normalizeClientFontScale, normalizeClientThemeAccent } from '../core/appearance.js';
import {
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  MAX_POPOVER_WIDTH,
  MIN_POPOVER_WIDTH,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  STEP_TABLE_COLUMN_KEYS,
  TOPBAR_SLOT_KEYS,
  normalizeHoverModules,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
} from '../../shared/settings-normalization.mjs';

const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractHostRouteCascadeId() {
  return '';
}

const initialConversationId =
  (typeof window !== 'undefined' && window.sidecar?.conversationId) || '';

export const telemetryStore = createReactiveStore({
  selectedConversationId: initialConversationId,
  hostRouteConversationId: extractHostRouteCascadeId(),
  selectedTimeRange: 'today',
  customStartMs: Date.now() - 24 * 3600 * 1000,
  customEndMs: Date.now(),
  syncState: 'idle', // 'idle' | 'syncing' | 'synced' | 'error'
  minuteTick: 0,
  telemetry: null,
});

let pollTimer = null;
let feedbackTimer = null;
let activeBundleVersion = 0;
let latestRequestSeq = 0;
let activeForceCount = 0;
let consecutivePollFailures = 0;
let inFlightTelemetryPoll = null;
let lastReceivedSteps = null;
let loopActive = false;
let loopIntervalMs = 2000;
let loopTickFn = null;

export const CLIENT_TOPBAR_SLOT_KEYS = TOPBAR_SLOT_KEYS;
export const DEFAULT_CLIENT_TOPBAR_SLOTS = DEFAULT_TOPBAR_SLOTS;
export const CLIENT_OVERVIEW_MODULE_KEYS = OVERVIEW_MODULE_KEYS;
export const DEFAULT_CLIENT_OVERVIEW_MODULES = DEFAULT_OVERVIEW_MODULES;
export const DEFAULT_CLIENT_HOVER_MODULES = DEFAULT_HOVER_MODULES;
export const CLIENT_OVERVIEW_METRIC_KEYS = OVERVIEW_METRIC_KEYS;
export const DEFAULT_CLIENT_OVERVIEW_METRICS = DEFAULT_OVERVIEW_METRICS;
export const CLIENT_STEP_COLUMN_KEYS = STEP_TABLE_COLUMN_KEYS;
export const DEFAULT_CLIENT_STEP_COLUMNS = DEFAULT_STEP_TABLE_COLUMNS;
export const DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT = DEFAULT_STEP_TOKEN_COMBO_FORMAT;
export const MIN_CLIENT_POPOVER_WIDTH = MIN_POPOVER_WIDTH;
export const MAX_CLIENT_POPOVER_WIDTH = MAX_POPOVER_WIDTH;
export const DEFAULT_CLIENT_POPOVER_WIDTH = DEFAULT_POPOVER_WIDTH;

export const parseClientStepTokenComboSegments = parseStepTokenComboSegments;
export const normalizeClientStepTokenComboFormat = normalizeStepTokenComboFormat;
export const normalizeClientPopoverWidthMode = normalizePopoverWidthMode;
export const normalizeClientPopoverWidth = normalizePopoverWidth;
export const normalizeClientModelDisplayMode = normalizeModelDisplayMode;
export const normalizeClientTopbarSlots = normalizeTopbarCapsuleSlots;
export const normalizeClientHoverModules = normalizeHoverModules;
export const normalizeClientOverviewModules = normalizeOverviewModules;
export const normalizeClientOverviewMetrics = normalizeOverviewMetrics;
export const normalizeClientStepColumns = normalizeStepTableColumns;
export const normalizeClientUpdateMode = normalizePluginUpdateMode;
export const normalizeClientOrchestratorIdMode = normalizeOrchestratorIdMode;
export const normalizeClientWindowMountMode = normalizeWindowMountMode;

export function isEquivalentTelemetry(prev, next) {
  if (!prev || !next) return false;
  if (prev === next) return true;

  const sameArr = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };
  // 1. 比对系统设置项（外观语言/主题/字号、模型显示策略、更新策略、挂载与结构布局配置）
  const pAct = prev.activeConversation;
  const nAct = next.activeConversation;
  const pSet = prev.settings;
  const nSet = next.settings;

  if ((pSet?.language ?? 'zh-CN') !== (nSet?.language ?? 'zh-CN')) return false;
  if ((pSet?.themeAccent ?? 'host') !== (nSet?.themeAccent ?? 'host')) return false;
  if ((pSet?.fontScale ?? 'md') !== (nSet?.fontScale ?? 'md')) return false;
  if ((prev.hostPlatform || '') !== (next.hostPlatform || '')) return false;
  if (Boolean(pSet?.contextWindowRiskAccepted) !== Boolean(nSet?.contextWindowRiskAccepted)) {
    return false;
  }
  if (
    JSON.stringify(pSet?.modelContextWindows) !== JSON.stringify(nSet?.modelContextWindows) ||
    JSON.stringify(prev.contextWindowModels) !== JSON.stringify(next.contextWindowModels)
  ) {
    return false;
  }
  if (
    normalizeModelDisplayMode(pSet?.modelDisplayMode, pSet?.showUpstreamModel) !==
    normalizeModelDisplayMode(nSet?.modelDisplayMode, nSet?.showUpstreamModel)
  ) {
    return false;
  }
  if (pSet?.showUpstreamModel !== nSet?.showUpstreamModel) return false;
  if (normalizePopoverWidthMode(pSet?.popoverWidthMode) !== normalizePopoverWidthMode(nSet?.popoverWidthMode)) {
    return false;
  }
  if (normalizePopoverWidth(pSet?.popoverWidth) !== normalizePopoverWidth(nSet?.popoverWidth)) {
    return false;
  }
  if (
    String(pSet?.stepTokenComboFormat ?? DEFAULT_STEP_TOKEN_COMBO_FORMAT).trim() !==
    String(nSet?.stepTokenComboFormat ?? DEFAULT_STEP_TOKEN_COMBO_FORMAT).trim()
  ) {
    return false;
  }
  if (
    normalizeOrchestratorIdMode(pSet?.orchestratorIdMode) !==
    normalizeOrchestratorIdMode(nSet?.orchestratorIdMode)
  ) {
    return false;
  }
  if (pSet?.weeklyLimitMode !== nSet?.weeklyLimitMode) return false;
  if (pSet?.weeklyTokenBudget !== nSet?.weeklyTokenBudget) return false;
  if (pSet?.weeklyCostBudget !== nSet?.weeklyCostBudget) return false;
  if ((pSet?.pluginUpdateMode ?? '') !== (nSet?.pluginUpdateMode ?? '')) return false;
  if (pSet?.autoUpdatePlugin !== nSet?.autoUpdatePlugin) return false;
  if (
    normalizeClientWindowMountMode(pSet?.windowMountMode, pSet?.enableWindowOverlay) !==
    normalizeClientWindowMountMode(nSet?.windowMountMode, nSet?.enableWindowOverlay)
  ) {
    return false;
  }
  if (pSet?.enableWindowOverlay !== nSet?.enableWindowOverlay) return false;
  if ((pSet?.enableCliStatusLine !== false) !== (nSet?.enableCliStatusLine !== false)) {
    return false;
  }
  if ((pSet?.showTopbarMultiSession !== false) !== (nSet?.showTopbarMultiSession !== false)) {
    return false;
  }
  if (Boolean(pSet?.showStepTurnRail) !== Boolean(nSet?.showStepTurnRail)) {
    return false;
  }
  if ((pSet?.showStepAgentBadge !== false) !== (nSet?.showStepAgentBadge !== false)) {
    return false;
  }
  if (Boolean(pSet?.showStepSpeedColor) !== Boolean(nSet?.showStepSpeedColor)) {
    return false;
  }
  if (!sameArr(pSet?.topbarCapsuleSlots, nSet?.topbarCapsuleSlots)) return false;
  if (!sameArr(pSet?.hoverModules, nSet?.hoverModules)) return false;
  if (!sameArr(pSet?.overviewModules, nSet?.overviewModules)) return false;
  if (!sameArr(pSet?.overviewMetrics, nSet?.overviewMetrics)) return false;
  if (!sameArr(pSet?.stepTableColumns, nSet?.stepTableColumns)) return false;

  // 2. 比对云端状态与桥接健康度
  const pWb = prev.windowBridge;
  const nWb = next.windowBridge;
  if (
    (pWb?.state || '') !== (nWb?.state || '') ||
    Boolean(pWb?.argvUpdatedThisBoot) !== Boolean(nWb?.argvUpdatedThisBoot) ||
    Boolean(pWb?.argvConfigured) !== Boolean(nWb?.argvConfigured) ||
    Boolean(pWb?.launcherConfigured) !== Boolean(nWb?.launcherConfigured) ||
    Boolean(pWb?.canRelaunch) !== Boolean(nWb?.canRelaunch) ||
    Number(pWb?.aliveCount || 0) !== Number(nWb?.aliveCount || 0)
  ) {
    return false;
  }
  const pCloud = prev.cloudStatus;
  const nCloud = next.cloudStatus;
  if (
    pCloud?.currentPluginVersion !== nCloud?.currentPluginVersion ||
    pCloud?.latestPluginVersion !== nCloud?.latestPluginVersion ||
    pCloud?.updateAvailable !== nCloud?.updateAvailable ||
    pCloud?.installMode !== nCloud?.installMode ||
    pCloud?.catalogVersion !== nCloud?.catalogVersion ||
    pCloud?.source !== nCloud?.source ||
    pCloud?.lastSyncedAtMs !== nCloud?.lastSyncedAtMs ||
    pCloud?.modelCount !== nCloud?.modelCount ||
    pCloud?.isSyncing !== nCloud?.isSyncing ||
    pCloud?.isUpdating !== nCloud?.isUpdating ||
    pCloud?.lastSyncError !== nCloud?.lastSyncError ||
    pCloud?.lastUpdateError !== nCloud?.lastUpdateError ||
    pCloud?.lastUpdateResult?.updatedAtMs !== nCloud?.lastUpdateResult?.updatedAtMs
  ) {
    return false;
  }

  // 3. 比对活跃会话的实时测速指标
  if (pAct?.cascadeId !== nAct?.cascadeId) return false;
  if (pAct?.stepCount !== nAct?.stepCount) return false;
  if (pAct?.subagentCount !== nAct?.subagentCount) return false;
  if (pAct?.totalStepsAllAgents !== nAct?.totalStepsAllAgents) return false;
  if (pAct?.isRunning !== nAct?.isRunning) return false;
  if (
    pAct?.inputTokens !== nAct?.inputTokens ||
    pAct?.cacheReadTokens !== nAct?.cacheReadTokens ||
    pAct?.outputTokens !== nAct?.outputTokens ||
    pAct?.totalTokens !== nAct?.totalTokens
  ) {
    return false;
  }
  if (
    pAct?.liveActivity?.signature !== nAct?.liveActivity?.signature ||
    pAct?.liveActivity?.startedAtMs !== nAct?.liveActivity?.startedAtMs
  ) {
    return false;
  }
  if (pAct?.aggregated?.isRunning !== nAct?.aggregated?.isRunning) return false;
  if (
    pAct?.aggregated?.inputTokens !== nAct?.aggregated?.inputTokens ||
    pAct?.aggregated?.cacheReadTokens !== nAct?.aggregated?.cacheReadTokens ||
    pAct?.aggregated?.outputTokens !== nAct?.aggregated?.outputTokens ||
    pAct?.aggregated?.totalTokens !== nAct?.aggregated?.totalTokens
  ) {
    return false;
  }
  if (
    pAct?.aggregated?.liveActivity?.signature !== nAct?.aggregated?.liveActivity?.signature ||
    pAct?.aggregated?.liveActivity?.startedAtMs !== nAct?.aggregated?.liveActivity?.startedAtMs
  ) {
    return false;
  }
  if (pAct?.aggregated?.liveActivity?.agentId !== nAct?.aggregated?.liveActivity?.agentId) return false;
  if (pAct?.aggregated?.activeAgentId !== nAct?.aggregated?.activeAgentId) return false;
  if (pAct?.aggregated?.activeAgentBadge !== nAct?.aggregated?.activeAgentBadge) return false;
  if (pAct?.aggregated?.latestTokPerSec !== nAct?.aggregated?.latestTokPerSec) return false;
  if (pAct?.aggregated?.latestTtftSec !== nAct?.aggregated?.latestTtftSec) return false;
  if (pAct?.aggregated?.avgTokPerSec !== nAct?.aggregated?.avgTokPerSec) return false;
  if (pAct?.aggregated?.latestStepCostUsd !== nAct?.aggregated?.latestStepCostUsd) return false;
  if (pAct?.aggregated?.sessionCostUsd !== nAct?.aggregated?.sessionCostUsd) return false;
  if (pAct?.aggregated?.sessionUnpricedCalls !== nAct?.aggregated?.sessionUnpricedCalls) return false;
  if (pAct?.aggregated?.sessionCacheHitPct !== nAct?.aggregated?.sessionCacheHitPct) return false;
  if (pAct?.aggregated?.activeModelShort !== nAct?.aggregated?.activeModelShort) return false;
  if (pAct?.aggregated?.activeModelUpstream !== nAct?.aggregated?.activeModelUpstream) return false;
  if (pAct?.aggregated?.latestCacheHitPct !== nAct?.aggregated?.latestCacheHitPct) return false;
  if (pAct?.aggregated?.latestSpeedReason !== nAct?.aggregated?.latestSpeedReason) return false;
  if (pAct?.latestTokPerSec !== nAct?.latestTokPerSec) return false;
  if (pAct?.latestTtftSec !== nAct?.latestTtftSec) return false;
  if (pAct?.avgTokPerSec !== nAct?.avgTokPerSec) return false;
  if (pAct?.latestCacheHitPct !== nAct?.latestCacheHitPct) return false;
  if (pAct?.sessionCacheHitPct !== nAct?.sessionCacheHitPct) return false;
  if (pAct?.latestSpeedReason !== nAct?.latestSpeedReason) return false;
  if (pAct?.ttftSummary?.avgSec !== nAct?.ttftSummary?.avgSec) return false;
  if (pAct?.speedSummary?.sampleCount !== nAct?.speedSummary?.sampleCount) return false;
  if (
    pAct?.activeModelShort !== nAct?.activeModelShort ||
    pAct?.activeModelLabel !== nAct?.activeModelLabel ||
    pAct?.activeModelUpstream !== nAct?.activeModelUpstream
  ) {
    return false;
  }
  if (
    pAct?.latestStepCostUsd !== nAct?.latestStepCostUsd ||
    pAct?.sessionCostUsd !== nAct?.sessionCostUsd ||
    pAct?.sessionUnpricedCalls !== nAct?.sessionUnpricedCalls
  ) {
    return false;
  }

  const pAgents = pAct?.agents || [];
  const nAgents = nAct?.agents || [];
  if (pAgents.length !== nAgents.length) return false;
  for (let i = 0; i < pAgents.length; i++) {
    const pa = pAgents[i];
    const na = nAgents[i];
    if (
      pa?.agentId !== na?.agentId ||
      pa?.role !== na?.role ||
      pa?.stepCount !== na?.stepCount ||
      pa?.isRunning !== na?.isRunning ||
      pa?.liveActivity?.signature !== na?.liveActivity?.signature ||
      pa?.latestTokPerSec !== na?.latestTokPerSec ||
      pa?.latestTtftSec !== na?.latestTtftSec ||
      pa?.avgTokPerSec !== na?.avgTokPerSec ||
      pa?.latestCacheHitPct !== na?.latestCacheHitPct ||
      pa?.sessionCacheHitPct !== na?.sessionCacheHitPct ||
      pa?.latestSpeedReason !== na?.latestSpeedReason ||
      pa?.latestStepCostUsd !== na?.latestStepCostUsd ||
      pa?.sessionCostUsd !== na?.sessionCostUsd ||
      pa?.sessionUnpricedCalls !== na?.sessionUnpricedCalls ||
      pa?.activeModelShort !== na?.activeModelShort ||
      pa?.activeModelUpstream !== na?.activeModelUpstream ||
      pa?.context?.totalTokens !== na?.context?.totalTokens ||
      pa?.context?.compactionLimitTokens !== na?.context?.compactionLimitTokens ||
      pa?.context?.limitTokens !== na?.context?.limitTokens ||
      pa?.context?.messagesTokens !== na?.context?.messagesTokens ||
      pa?.context?.toolResultsTokens !== na?.context?.toolResultsTokens ||
      pa?.context?.assistantTokens !== na?.context?.assistantTokens ||
      pa?.context?.userInputTokens !== na?.context?.userInputTokens ||
      pa?.context?.subagentTokens !== na?.context?.subagentTokens ||
      pa?.context?.checkpointTokens !== na?.context?.checkpointTokens ||
      pa?.context?.systemToolsTokens !== na?.context?.systemToolsTokens ||
      pa?.context?.mcpToolsTokens !== na?.context?.mcpToolsTokens ||
      pa?.context?.skillsTokens !== na?.context?.skillsTokens ||
      pa?.context?.systemPromptTokens !== na?.context?.systemPromptTokens ||
      pa?.context?.userRulesTokens !== na?.context?.userRulesTokens
    ) {
      return false;
    }
    // 主代理步骤由根会话统一比对，避免明细视图组装后的引用造成重复比对。
    const paSteps = pa?.isMain && pAct?.recentSteps ? [] : pa?.recentSteps || [];
    const naSteps = na?.isMain && nAct?.recentSteps ? [] : na?.recentSteps || [];
    if (paSteps.length !== naSteps.length) return false;
    for (let j = 0; paSteps !== naSteps && j < paSteps.length; j++) {
      const bs = paSteps[j];
      const as = naSteps[j];
      if (
        bs?.stepIndex !== as?.stepIndex ||
        bs?.createdAtMs !== as?.createdAtMs ||
        bs?.totalDurationSec !== as?.totalDurationSec ||
        bs?.streamDurationSec !== as?.streamDurationSec ||
        bs?.modelKey !== as?.modelKey ||
        bs?.modelShort !== as?.modelShort ||
        bs?.modelLabel !== as?.modelLabel ||
        bs?.modelUpstream !== as?.modelUpstream ||
        bs?.responseModel !== as?.responseModel ||
        bs?.modelSource !== as?.modelSource ||
        bs?.costUsd !== as?.costUsd ||
        bs?.tokPerSec !== as?.tokPerSec ||
        bs?.ttftSec !== as?.ttftSec ||
        bs?.outputTokens !== as?.outputTokens ||
        bs?.thinkingTokens !== as?.thinkingTokens ||
        bs?.responseTokens !== as?.responseTokens ||
        bs?.inputTokens !== as?.inputTokens ||
        bs?.cacheReadTokens !== as?.cacheReadTokens ||
        bs?.contextTokens !== as?.contextTokens ||
        bs?.cacheHitPct !== as?.cacheHitPct ||
        bs?.selectedSpeedReason !== as?.selectedSpeedReason ||
        bs?.turnIndex !== as?.turnIndex ||
        bs?.rootTurnIndex !== as?.rootTurnIndex ||
        bs?.isTurnStart !== as?.isTurnStart ||
        bs?.isRootTurnStart !== as?.isRootTurnStart ||
        bs?.isLatestTurn !== as?.isLatestTurn ||
        bs?.isRootLatestTurn !== as?.isRootLatestTurn ||
        bs?.turnPrompt !== as?.turnPrompt ||
        bs?.rootTurnPrompt !== as?.rootTurnPrompt
      ) {
        return false;
      }
    }
  }

  // 4. 比对 10 通道上下文窗口构成及近期步骤明细
  const pCtx = pAct?.context;
  const nCtx = nAct?.context;
  if (pCtx?.totalTokens !== nCtx?.totalTokens) return false;
  if (pCtx?.compactionLimitTokens !== nCtx?.compactionLimitTokens) return false;
  if (pCtx?.limitTokens !== nCtx?.limitTokens) return false;
  if (pCtx?.messagesTokens !== nCtx?.messagesTokens) return false;
  if (pCtx?.assistantTokens !== nCtx?.assistantTokens) return false;
  if (pCtx?.toolResultsTokens !== nCtx?.toolResultsTokens) return false;
  if (pCtx?.userInputTokens !== nCtx?.userInputTokens) return false;
  if (pCtx?.subagentTokens !== nCtx?.subagentTokens) return false;
  if (pCtx?.checkpointTokens !== nCtx?.checkpointTokens) return false;
  if (pCtx?.systemToolsTokens !== nCtx?.systemToolsTokens) return false;
  if (pCtx?.mcpToolsTokens !== nCtx?.mcpToolsTokens) return false;
  if (pCtx?.skillsTokens !== nCtx?.skillsTokens) return false;
  if (pCtx?.systemPromptTokens !== nCtx?.systemPromptTokens) return false;
  if (pCtx?.userRulesTokens !== nCtx?.userRulesTokens) return false;
  if ((pAct?.recentSteps?.length || 0) !== (nAct?.recentSteps?.length || 0)) return false;
  for (let i = 0; pAct?.recentSteps !== nAct?.recentSteps && i < (pAct?.recentSteps?.length || 0); i++) {
    const before = pAct.recentSteps[i], after = nAct.recentSteps[i];
    if (
      before.stepIndex !== after.stepIndex ||
      before.createdAtMs !== after.createdAtMs ||
      before.totalDurationSec !== after.totalDurationSec ||
      before.streamDurationSec !== after.streamDurationSec ||
      before.modelKey !== after.modelKey ||
      before.modelShort !== after.modelShort ||
      before.modelLabel !== after.modelLabel ||
      before.modelUpstream !== after.modelUpstream ||
      before.responseModel !== after.responseModel ||
      before.modelSource !== after.modelSource ||
      before.costUsd !== after.costUsd ||
      before.tokPerSec !== after.tokPerSec ||
      before.ttftSec !== after.ttftSec ||
      before.outputTokens !== after.outputTokens ||
      before.thinkingTokens !== after.thinkingTokens ||
      before.responseTokens !== after.responseTokens ||
      before.inputTokens !== after.inputTokens ||
      before.cacheReadTokens !== after.cacheReadTokens ||
      before.contextTokens !== after.contextTokens ||
      before.cacheHitPct !== after.cacheHitPct ||
      before.selectedSpeedReason !== after.selectedSpeedReason ||
      before.turnIndex !== after.turnIndex ||
      before.rootTurnIndex !== after.rootTurnIndex ||
      before.isTurnStart !== after.isTurnStart ||
      before.isRootTurnStart !== after.isRootTurnStart ||
      before.isLatestTurn !== after.isLatestTurn ||
      before.isRootLatestTurn !== after.isRootLatestTurn ||
      before.turnPrompt !== after.turnPrompt ||
      before.rootTurnPrompt !== after.rootTurnPrompt
    ) {
      return false;
    }
  }

  // 5. 比对消费统计所选时间区间、当前会话累计消费与账号全局累计消费
  const pRange = prev.consumption?.selectedRange;
  const nRange = next.consumption?.selectedRange;
  if (pRange?.key !== nRange?.key) return false;
  if (nRange?.key === 'custom') {
    if (pRange?.startMs !== nRange?.startMs || pRange?.endMs !== nRange?.endMs) return false;
  }

  const pCons = prev.consumption?.session;
  const nCons = next.consumption?.session;
  if (pCons?.totalTokens !== nCons?.totalTokens) return false;
  if (pCons?.costUsd !== nCons?.costUsd) return false;
  if (pCons?.unpricedCalls !== nCons?.unpricedCalls) return false;

  const pAcct = prev.consumption?.account;
  const nAcct = next.consumption?.account;
  if (pAcct?.totalTokens !== nAcct?.totalTokens) return false;
  if (pAcct?.inputTokens !== nAcct?.inputTokens) return false;
  if (pAcct?.cacheReadTokens !== nAcct?.cacheReadTokens) return false;
  if (pAcct?.outputTokens !== nAcct?.outputTokens) return false;
  if (pAcct?.calls !== nAcct?.calls) return false;
  if (pAcct?.costUsd !== nAcct?.costUsd) return false;
  if (pAcct?.savedCostUsd !== nAcct?.savedCostUsd) return false;
  if (pAcct?.cacheHitPct !== nAcct?.cacheHitPct) return false;
  if (pAcct?.unpricedCalls !== nAcct?.unpricedCalls) return false;

  // 6. 比对历史趋势时间分桶序列与年度分月序列
  const pTrend = prev.consumption?.trendSeries || [];
  const nTrend = next.consumption?.trendSeries || [];
  if (pTrend.length !== nTrend.length) return false;
  for (let i = 0; i < pTrend.length; i++) {
    if (
      pTrend[i]?.tokens !== nTrend[i]?.tokens ||
      pTrend[i]?.calls !== nTrend[i]?.calls ||
      pTrend[i]?.label !== nTrend[i]?.label ||
      pTrend[i]?.fullLabel !== nTrend[i]?.fullLabel
    ) {
      return false;
    }
  }
  if (prev.consumption?.monthlyYear !== next.consumption?.monthlyYear) return false;
  const pMonthly = prev.consumption?.monthlySeries || [];
  const nMonthly = next.consumption?.monthlySeries || [];
  if (pMonthly.length !== nMonthly.length) return false;
  for (let i = 0; i < pMonthly.length; i++) {
    if (
      pMonthly[i]?.totalTokens !== nMonthly[i]?.totalTokens ||
      pMonthly[i]?.costUsd !== nMonthly[i]?.costUsd ||
      pMonthly[i]?.calls !== nMonthly[i]?.calls
    ) {
      return false;
    }
  }

  // 7. 比对按模型汇总明细与数据来源汇总明细
  const pModels = prev.modelBreakdown || [];
  const nModels = next.modelBreakdown || [];
  if (pModels.length !== nModels.length) return false;
  for (let i = 0; i < pModels.length; i++) {
    if (
      pModels[i]?.label !== nModels[i]?.label ||
      pModels[i]?.shortName !== nModels[i]?.shortName ||
      pModels[i]?.upstreamName !== nModels[i]?.upstreamName ||
      pModels[i]?.costUsd !== nModels[i]?.costUsd ||
      pModels[i]?.unpricedCalls !== nModels[i]?.unpricedCalls ||
      pModels[i]?.totalTokens !== nModels[i]?.totalTokens ||
      pModels[i]?.calls !== nModels[i]?.calls
    ) {
      return false;
    }
  }

  const pSources = prev.consumption?.sourcesBreakdown || [];
  const nSources = next.consumption?.sourcesBreakdown || [];
  if (pSources.length !== nSources.length) return false;
  for (let i = 0; i < pSources.length; i++) {
    if (
      pSources[i]?.name !== nSources[i]?.name ||
      pSources[i]?.costUsd !== nSources[i]?.costUsd ||
      pSources[i]?.unpricedCalls !== nSources[i]?.unpricedCalls ||
      pSources[i]?.totalTokens !== nSources[i]?.totalTokens ||
      pSources[i]?.calls !== nSources[i]?.calls
    ) {
      return false;
    }
  }

  // 8. 比对账号订阅档位与动态多配额池
  if (
    prev.account?.email !== next.account?.email ||
    prev.account?.name !== next.account?.name ||
    prev.account?.status !== next.account?.status ||
    prev.account?.tierName !== next.account?.tierName ||
    prev.account?.planName !== next.account?.planName ||
    prev.account?.aiCredits !== next.account?.aiCredits
  ) {
    return false;
  }

  if (
    prev.quotas?.meta?.refreshFailed !== next.quotas?.meta?.refreshFailed ||
    prev.quotas?.meta?.isStale !== next.quotas?.meta?.isStale
  ) {
    return false;
  }

  const pQuot = prev.quotas?.activePool;
  const nQuot = next.quotas?.activePool;
  if (pQuot?.family !== nQuot?.family) return false;
  if (pQuot?.usedPct !== nQuot?.usedPct) return false;
  if (pQuot?.remainingPct !== nQuot?.remainingPct) return false;
  if (pQuot?.weeklyUsedPct !== nQuot?.weeklyUsedPct) return false;
  if (pQuot?.weeklyRemainingPct !== nQuot?.weeklyRemainingPct) return false;
  if (prev.quotas?.weekly?.usedPct !== next.quotas?.weekly?.usedPct) return false;
  if (prev.quotas?.weekly?.remainingPct !== next.quotas?.weekly?.remainingPct) return false;
  if (prev.quotas?.weekly?.tokens !== next.quotas?.weekly?.tokens) return false;
  if (prev.quotas?.weekly?.costUsd !== next.quotas?.weekly?.costUsd) return false;
  if (prev.quotas?.weekly?.calls !== next.quotas?.weekly?.calls) return false;
  if (prev.quotas?.weekly?.unpricedCalls !== next.quotas?.weekly?.unpricedCalls) return false;
  if (prev.quotas?.weekly?.resetTime !== next.quotas?.weekly?.resetTime) return false;

  const pPools = prev.quotas?.pools || [];
  const nPools = next.quotas?.pools || [];
  if (pPools.length !== nPools.length) return false;
  for (let i = 0; i < pPools.length; i++) {
    if (
      pPools[i]?.poolKey !== nPools[i]?.poolKey ||
      pPools[i]?.poolLabel !== nPools[i]?.poolLabel ||
      pPools[i]?.usedPct !== nPools[i]?.usedPct ||
      pPools[i]?.remainingPct !== nPools[i]?.remainingPct ||
      pPools[i]?.resetTime !== nPools[i]?.resetTime ||
      pPools[i]?.weeklyUsedPct !== nPools[i]?.weeklyUsedPct ||
      pPools[i]?.weeklyRemainingPct !== nPools[i]?.weeklyRemainingPct ||
      pPools[i]?.weeklyResetTime !== nPools[i]?.weeklyResetTime ||
      pPools[i]?.cycle5h?.tokens !== nPools[i]?.cycle5h?.tokens ||
      pPools[i]?.cycle5h?.costUsd !== nPools[i]?.cycle5h?.costUsd ||
      pPools[i]?.cycle5h?.calls !== nPools[i]?.cycle5h?.calls ||
      pPools[i]?.cycleWeekly?.tokens !== nPools[i]?.cycleWeekly?.tokens ||
      pPools[i]?.cycleWeekly?.costUsd !== nPools[i]?.cycleWeekly?.costUsd ||
      pPools[i]?.cycleWeekly?.calls !== nPools[i]?.cycleWeekly?.calls
    ) {
      return false;
    }
  }

  const pConvs = prev.conversations || [];
  const nConvs = next.conversations || [];
  if (pConvs.length !== nConvs.length) return false;
  for (let i = 0; i < pConvs.length; i++) {
    if (
      pConvs[i]?.cascadeId !== nConvs[i]?.cascadeId ||
      pConvs[i]?.title !== nConvs[i]?.title ||
      pConvs[i]?.status !== nConvs[i]?.status ||
      pConvs[i]?.stepCount !== nConvs[i]?.stepCount ||
      pConvs[i]?.subagentCount !== nConvs[i]?.subagentCount ||
      pConvs[i]?.totalStepCount !== nConvs[i]?.totalStepCount
    ) {
      return false;
    }
  }

  const pRunning = prev.runningConversations || [];
  const nRunning = next.runningConversations || [];
  if (pRunning.length !== nRunning.length) return false;
  for (let i = 0; i < pRunning.length; i++) {
    const pr = pRunning[i];
    const nr = nRunning[i];
    if (
      pr?.cascadeId !== nr?.cascadeId ||
      pr?.title !== nr?.title ||
      pr?.isCurrentSelected !== nr?.isCurrentSelected ||
      pr?.isMainRunning !== nr?.isMainRunning ||
      pr?.subagentCount !== nr?.subagentCount ||
      pr?.runningSubagentCount !== nr?.runningSubagentCount ||
      pr?.mainActivity?.signature !== nr?.mainActivity?.signature ||
      pr?.mainActivity?.startedAtMs !== nr?.mainActivity?.startedAtMs
    ) {
      return false;
    }
    const pSubs = pr?.subagents || [];
    const nSubs = nr?.subagents || [];
    if (pSubs.length !== nSubs.length) return false;
    for (let j = 0; j < pSubs.length; j++) {
      if (
        pSubs[j]?.cascadeId !== nSubs[j]?.cascadeId ||
        pSubs[j]?.role !== nSubs[j]?.role ||
        pSubs[j]?.isRunning !== nSubs[j]?.isRunning ||
        pSubs[j]?.stepCount !== nSubs[j]?.stepCount ||
        pSubs[j]?.liveActivity?.signature !== nSubs[j]?.liveActivity?.signature ||
        pSubs[j]?.liveActivity?.startedAtMs !== nSubs[j]?.liveActivity?.startedAtMs
      ) {
        return false;
      }
    }
  }

  return true;
}

export async function fetchTelemetry({ force = false } = {}) {
  if (!force && activeForceCount > 0) {
    return telemetryStore.getState().telemetry;
  }

  const overlay = isWindowOverlayMode();
  if (overlay) {
    const st = telemetryStore.getState();
    const liveRouteId = extractHostRouteCascadeId();
    if (liveRouteId !== st.hostRouteConversationId) {
      const patch = { hostRouteConversationId: liveRouteId };
      if (liveRouteId && st.selectedConversationId && st.selectedConversationId !== liveRouteId) {
        patch.selectedConversationId = '';
      }
      telemetryStore.setState(patch);
    }
  }
  const current = telemetryStore.getState();
  const effectiveConvId = current.selectedConversationId || current.hostRouteConversationId || '';
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  if (current.selectedTimeRange) params.set('range', current.selectedTimeRange);
  if (current.selectedTimeRange === 'custom') {
    if (current.customStartMs > 0) params.set('startMs', String(current.customStartMs));
    if (current.customEndMs > 0) params.set('endMs', String(current.customEndMs));
  }
  if (force) params.set('force', '1');
  params.set('stepDetails', 'display');

  if (force) {
    inFlightTelemetryPoll = null;
    return requestTelemetry(params, true);
  }
  const query = params.toString();
  const existing = inFlightTelemetryPoll;
  if (existing?.query === query) {
    return existing.promise;
  }
  const poll = { query, promise: null };
  poll.promise = requestTelemetry(params, false).finally(() => {
    if (inFlightTelemetryPoll === poll) inFlightTelemetryPoll = null;
  });
  inFlightTelemetryPoll = poll;
  return poll.promise;
}

function readDisplaySteps(payload) {
  const active = payload?.activeConversation;
  if (!payload?.stepRevision || !Array.isArray(active?.recentSteps)) return null;
  return {
    revision: payload.stepRevision,
    recentSteps: active.recentSteps,
    agentSteps: active.agents.map((agent) => agent.recentSteps === active.recentSteps
      ? undefined
      : agent.recentSteps),
  };
}

async function requestTelemetry(params, force) {
  const reqSeq = ++latestRequestSeq;
  const startMs = Date.now();

  if (force) {
    activeForceCount += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    telemetryStore.setState({ syncState: 'syncing' });
  }

  try {
    const previousSteps = lastReceivedSteps || readDisplaySteps(telemetryStore.getState().telemetry);
    params.set('stepRevision', previousSteps?.revision || '');
    const payload = await callSidecarApi(`/api/telemetry?${params}`, {
      method: 'GET',
      abortKey: force ? 'telemetry-force' : 'telemetry-poll',
    });

    const active = payload?.activeConversation;
    if (payload?.stepsUnchanged) {
      if (!active || !previousSteps || payload.stepRevision !== previousSteps.revision) {
        throw new Error('Telemetry step revision mismatch');
      }
      active.recentSteps = previousSteps.recentSteps;
      active.agents.forEach((agent, index) => {
        const steps = previousSteps.agentSteps[index];
        if (steps) agent.recentSteps = steps;
      });
    }
    if (reqSeq !== latestRequestSeq) {
      return payload;
    }
    lastReceivedSteps = readDisplaySteps(payload);

    if (payload?.uiBundleVersion) {
      if (activeBundleVersion && activeBundleVersion !== payload.uiBundleVersion) {
        if (
          !isWindowOverlayMode() &&
          typeof window !== 'undefined' &&
          typeof window.location?.reload === 'function'
        ) {
          window.location.reload();
          return payload;
        }
      }
      activeBundleVersion = payload.uiBundleVersion;
    }
    consecutivePollFailures = 0;

    const latestSt = telemetryStore.getState();
    if (force) {
      const elapsed = Date.now() - startMs;
      if (elapsed < 220) {
        await new Promise((r) => setTimeout(r, 220 - elapsed));
      }
      if (reqSeq !== latestRequestSeq) {
        return payload;
      }
      if (feedbackTimer) clearTimeout(feedbackTimer);
      telemetryStore.setState({
        telemetry: payload,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: 'synced',
      });
      feedbackTimer = setTimeout(() => {
        feedbackTimer = null;
        telemetryStore.setState({ syncState: 'idle' });
      }, 1100);
    } else {
      const isSame = isEquivalentTelemetry(latestSt.telemetry, payload);
      const nextTelemetry = isSame ? latestSt.telemetry : payload;
      telemetryStore.setState({
        telemetry: nextTelemetry,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: latestSt.syncState === 'synced' ? 'synced' : 'idle',
      });
    }
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError' || reqSeq !== latestRequestSeq) return null;
    consecutivePollFailures += 1;
    if (force || consecutivePollFailures >= 2 || !telemetryStore.getState().telemetry) {
      telemetryStore.setState({ syncState: 'error' });
    }
    return null;
  } finally {
    if (force) {
      activeForceCount = Math.max(0, activeForceCount - 1);
      if (activeForceCount === 0 && loopActive && loopTickFn && !pollTimer) {
        pollTimer = setTimeout(loopTickFn, loopIntervalMs);
      }
    }
  }
}

export async function saveSettingsPatch(patch) {
  const safePatch = patch && typeof patch === 'object' ? { ...patch } : {};
  if (Object.prototype.hasOwnProperty.call(safePatch, 'language')) {
    safePatch.language = normalizeI18nLanguage(safePatch.language);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'themeAccent')) {
    safePatch.themeAccent = normalizeClientThemeAccent(safePatch.themeAccent);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'fontScale')) {
    safePatch.fontScale = normalizeClientFontScale(safePatch.fontScale);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'weeklyLimitMode')) {
    safePatch.weeklyLimitMode = normalizeWeeklyLimitMode(safePatch.weeklyLimitMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'enableCliStatusLine')) {
    safePatch.enableCliStatusLine = Boolean(safePatch.enableCliStatusLine);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showTopbarMultiSession')) {
    safePatch.showTopbarMultiSession = Boolean(safePatch.showTopbarMultiSession);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepTurnRail')) {
    safePatch.showStepTurnRail = Boolean(safePatch.showStepTurnRail);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepAgentBadge')) {
    safePatch.showStepAgentBadge = Boolean(safePatch.showStepAgentBadge);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepSpeedColor')) {
    safePatch.showStepSpeedColor = Boolean(safePatch.showStepSpeedColor);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'topbarCapsuleSlots')) {
    safePatch.topbarCapsuleSlots = normalizeClientTopbarSlots(safePatch.topbarCapsuleSlots);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverModules')) {
    safePatch.hoverModules = normalizeClientHoverModules(safePatch.hoverModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewModules')) {
    safePatch.overviewModules = normalizeClientOverviewModules(safePatch.overviewModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewMetrics')) {
    safePatch.overviewMetrics = normalizeClientOverviewMetrics(safePatch.overviewMetrics);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'stepTableColumns')) {
    safePatch.stepTableColumns = normalizeClientStepColumns(safePatch.stepTableColumns);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'stepTokenComboFormat')) {
    safePatch.stepTokenComboFormat = normalizeClientStepTokenComboFormat(
      safePatch.stepTokenComboFormat
    );
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'modelDisplayMode')) {
    const normDisp = normalizeClientModelDisplayMode(
      safePatch.modelDisplayMode,
      safePatch.showUpstreamModel
    );
    safePatch.modelDisplayMode = normDisp;
    safePatch.showUpstreamModel = normDisp !== 'short';
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'showUpstreamModel')) {
    safePatch.showUpstreamModel = Boolean(safePatch.showUpstreamModel);
    safePatch.modelDisplayMode = safePatch.showUpstreamModel ? 'upstream' : 'short';
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'popoverWidthMode')) {
    safePatch.popoverWidthMode = normalizeClientPopoverWidthMode(safePatch.popoverWidthMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'popoverWidth')) {
    safePatch.popoverWidth = normalizeClientPopoverWidth(safePatch.popoverWidth);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'contextWindowRiskAccepted')) {
    safePatch.contextWindowRiskAccepted = Boolean(safePatch.contextWindowRiskAccepted);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'orchestratorIdMode')) {
    safePatch.orchestratorIdMode = normalizeClientOrchestratorIdMode(safePatch.orchestratorIdMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'standalonePort')) {
    const numPort = Number(safePatch.standalonePort);
    safePatch.standalonePort =
      Number.isInteger(numPort) && numPort >= 1024 && numPort <= 65535 ? numPort : 0;
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'windowMountMode')) {
    const normMount = normalizeClientWindowMountMode(
      safePatch.windowMountMode,
      safePatch.enableWindowOverlay
    );
    safePatch.windowMountMode = normMount;
    safePatch.enableWindowOverlay = normMount !== 'sidebar';
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'enableWindowOverlay')) {
    safePatch.enableWindowOverlay = Boolean(safePatch.enableWindowOverlay);
    safePatch.windowMountMode = safePatch.enableWindowOverlay ? 'dual' : 'sidebar';
  }
  const prevTelemetry = telemetryStore.getState().telemetry;
  if (prevTelemetry?.settings) {
    telemetryStore.setState({
      telemetry: {
        ...prevTelemetry,
        settings: { ...prevTelemetry.settings, ...safePatch },
      },
    });
  }
  try {
    await callSidecarApi('/api/settings', { method: 'POST', body: safePatch });
  } catch (err) {
    if (prevTelemetry) {
      telemetryStore.setState({ telemetry: prevTelemetry });
    }
    throw err;
  }
  await fetchTelemetry({ force: true });
}

export async function saveModelContextWindow(modelId, option) {
  const result = await callSidecarApi('/api/context-window', {
    method: 'POST',
    body: { modelId, option },
  });
  const telemetry = telemetryStore.getState().telemetry;
  if (telemetry?.settings) {
    telemetryStore.setState({
      telemetry: {
        ...telemetry,
        settings: { ...telemetry.settings, modelContextWindows: result.modelContextWindows },
      },
    });
  }
  return result.modelContextWindows;
}

export async function resetAllSettings() {
  const res = await callSidecarApi('/api/settings/reset', { method: 'POST', body: {} });
  const prevTelemetry = telemetryStore.getState().telemetry;
  if (res?.settings && prevTelemetry) {
    telemetryStore.setState({
      telemetry: {
        ...prevTelemetry,
        settings: { ...res.settings },
      },
    });
  }
  await fetchTelemetry({ force: true });
  return res;
}

export async function rebuildTrajectoryCache() {
  const res = await callSidecarApi('/api/cache/rebuild', { method: 'POST', body: {} });
  await fetchTelemetry({ force: true });
  return res;
}

export async function triggerCloudSync() {
  const res = await callSidecarApi('/api/cloud-sync', { method: 'POST', body: {} });
  await fetchTelemetry({ force: true });
  return res;
}

export async function triggerPluginUpdate() {
  const res = await callSidecarApi('/api/plugin-update', { method: 'POST', body: {} });
  if (res?.ok && res?.restarting) {
    await new Promise((r) => setTimeout(r, 1100));
    if (
      !isWindowOverlayMode() &&
      typeof window !== 'undefined' &&
      typeof window.location?.reload === 'function'
    ) {
      window.location.reload();
      return res;
    }
  }
  await fetchTelemetry({ force: true });
  return res;
}

export function startAsyncTelemetryLoop(intervalMs = 2000) {
  stopAsyncTelemetryLoop();
  loopActive = true;
  loopIntervalMs = intervalMs;

  const resolveNextDelay = () => {
    if (isWindowOverlayMode() && typeof document !== 'undefined' && document.hidden) {
      return Math.max(loopIntervalMs, 8000);
    }
    return loopIntervalMs;
  };

  const tick = async () => {
    pollTimer = null;
    if (!loopActive) return;
    await fetchTelemetry({ force: false });
    if (!loopActive || activeForceCount > 0) return;
    if (!pollTimer) {
      pollTimer = setTimeout(tick, resolveNextDelay());
    }
  };
  loopTickFn = tick;

  tick();
  return () => {
    stopAsyncTelemetryLoop();
  };
}

export function stopAsyncTelemetryLoop() {
  loopActive = false;
  loopTickFn = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
}

export {
  formatAgentBadgeText,
  formatAgentLabel,
  formatLiveActivityDetail,
  formatLiveActivityLabel,
  getAgentBadgeClass,
};

/**
 * 解析当前选中的主/子代理作用域视图数据与独立上下文窗口检视目标。
 * 同时在客户端按需组装主代理与全部汇总的 `recentSteps`，避免后端 JSON 载荷重复序列化 2-3 倍步骤列表。
 *
 * @param {object|null} telemetry
 * @param {string} [selectedAgentScope='all']
 * @param {string} [ctxInspectorAgentId='auto']
 * @param {boolean} [includeSteps=false] 是否组装调用明细所需的步骤列表
 */
const scopedStepProjectionMemo = new WeakMap();

export function resolveScopedConversation(
  telemetry,
  selectedAgentScope = 'all',
  ctxInspectorAgentId = 'auto',
  includeSteps = false
) {
  const rawActive = telemetry?.activeConversation;
  const active = rawActive || {};
  const agents = Array.isArray(active.agents) && active.agents.length > 0 ? active.agents : [];
  const hasSubagents = Boolean(active.hasSubagents && agents.length > 1);
  const subagents = agents.filter((a) => !a.isMain);
  let mainAgent = agents.find((a) => a.isMain) || active;
  let aggregated = active.aggregated || active;
  let resolvedAgents = agents;

  if (includeSteps) {
    let cached = rawActive && typeof rawActive === 'object' ? scopedStepProjectionMemo.get(rawActive) : null;
    if (!cached) {
      let nextMain = mainAgent;
      let nextAgents = agents;
      if (!Array.isArray(mainAgent.recentSteps) && Array.isArray(active.recentSteps)) {
        nextMain = { ...mainAgent, recentSteps: active.recentSteps };
        if (agents.includes(mainAgent)) {
          nextAgents = agents.map((ag) => (ag === mainAgent ? nextMain : ag));
        }
      }
      let nextAgg = aggregated;
      if (hasSubagents && !Array.isArray(aggregated.recentSteps)) {
        const combined = [];
        for (const ag of nextAgents) {
          const steps = ag.isMain ? ag.recentSteps || active.recentSteps || [] : ag.recentSteps || [];
          for (const step of steps) combined.push(step);
        }
        combined.sort(
          (a, b) =>
            (b.createdAtMs || 0) - (a.createdAtMs || 0) ||
            (b.agentIndex || 0) - (a.agentIndex || 0) ||
            (b.stepIndex || 0) - (a.stepIndex || 0)
        );
        nextAgg = { ...aggregated, recentSteps: combined };
      }
      cached = { mainAgent: nextMain, aggregated: nextAgg, agents: nextAgents };
      if (rawActive && typeof rawActive === 'object') {
        scopedStepProjectionMemo.set(rawActive, cached);
      }
    }
    mainAgent = cached.mainAgent;
    aggregated = cached.aggregated;
    resolvedAgents = cached.agents;
  }

  if (!hasSubagents) {
    const singleScoped =
      includeSteps && !Array.isArray(active.recentSteps) && Array.isArray(mainAgent.recentSteps)
        ? { ...active, recentSteps: mainAgent.recentSteps }
        : active;
    return {
      hasSubagents: false,
      effectiveScope: 'main',
      effectiveCtxScope: 'main',
      agents: resolvedAgents,
      subagents: [],
      mainAgent,
      aggregated,
      scopedConv: singleScoped,
      ctxAgent: mainAgent,
    };
  }

  const isValidSub = subagents.some((s) => s.agentId === selectedAgentScope);
  const effectiveScope =
    selectedAgentScope === 'main'
      ? 'main'
      : isValidSub
        ? selectedAgentScope
        : 'all';

  const scopedConv =
    effectiveScope === 'all'
      ? aggregated
      : resolvedAgents.find((a) => a.agentId === effectiveScope) || mainAgent;

  let ctxAgent = scopedConv;
  let effectiveCtxScope = effectiveScope;
  if (effectiveScope === 'all') {
    if (ctxInspectorAgentId && ctxInspectorAgentId !== 'auto') {
      const matched = resolvedAgents.find((a) => a.agentId === ctxInspectorAgentId);
      if (matched) {
        ctxAgent = matched;
        effectiveCtxScope = matched.agentId;
      } else {
        effectiveCtxScope = 'auto';
      }
    } else {
      effectiveCtxScope = 'auto';
    }
    if (effectiveCtxScope === 'auto') {
      ctxAgent =
        resolvedAgents.find((a) => !a.isSideQuestion && a.agentId === aggregated.activeAgentId) ||
        resolvedAgents.find((a) => !a.isSideQuestion && a.isRunning) ||
        mainAgent;
    }
  }

  return {
    hasSubagents: true,
    effectiveScope,
    effectiveCtxScope,
    agents: resolvedAgents,
    subagents,
    mainAgent,
    aggregated,
    scopedConv,
    ctxAgent,
  };
}

/**
 * 判断宿主系统是否为 macOS (`darwin`)：优先读取后端遥测或双栖桥接注入的 `platform`，首帧缺省时回退 UA/平台标识。
 *
 * @param {Record<string, any>|null|undefined} telemetry
 * @returns {boolean}
 */
export function isMacHostPlatform(telemetry) {
  const p = String(telemetry?.hostPlatform || '')
    .trim()
    .toLowerCase();
  if (p) return p === 'darwin';
  if (typeof navigator !== 'undefined') {
    const ua = String(navigator.platform || navigator.userAgent || '');
    return /\b(?:mac|darwin)\b|macintosh|mac\s*os/i.test(ua);
  }
  return false;
}
