/**
 * @fileoverview View 3: StepsDetailView (步骤明细与总汇总分析视图).
 * 提供“按步查看”与“总汇总”双子视图切换：
 * - 单步测速表通过 `stepColumnRegistry.js` 动态渲染用户自选的 2..12 个字段列，并支持行级增量对账；
 * - 总汇总视图提供会话线性走势图、多模型同图趋势拟合曲线与极简高密度模型总览卡片。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../core/domPatch.js';
import {
  formatMetric,
  formatTokens,
  formatUsd,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
  resolveModelDisplayInfo,
} from '../core/formatters.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { getEffectiveLocale, i18nStore, t } from '../i18n/index.js';
import {
  formatAgentLabel,
  normalizeClientStepColumns,
  normalizeClientStepTokenComboFormat,
  resolveScopedConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  MODEL_COLOR_VARS,
  createModelFitChart,
  createSessionLineChart,
  getStepModelGroupKey,
  toChronologicalSteps,
} from '../components/charts/SessionStepCharts.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';
import { StepTableWidget } from '../components/widgets/StepTableWidget.js';

function mergeSelectedAgentUnits(units) {
  const combinedSteps = [];
  const modelMap = new Map();

  for (const ag of units) {
    if (!ag || typeof ag !== 'object') continue;
    if (Array.isArray(ag.recentSteps)) {
      for (const step of ag.recentSteps) combinedSteps.push(step);
    }
    const breakdown = Array.isArray(ag.modelBreakdown) ? ag.modelBreakdown : [];
    for (const m of breakdown) {
      if (!m || typeof m !== 'object') continue;
      const gk = getStepModelGroupKey(m);
      let acc = modelMap.get(gk);
      if (!acc) {
        acc = {
          label: m.label || gk,
          shortName: m.shortName || gk,
          rawModel: m.rawModel || '',
          upstreamName: m.upstreamName || m.upstreamModel || '',
          upstreamSet: new Set(
            Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
          ),
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
          _speedWeightedSum: 0,
          _speedWeight: 0,
          _ttftWeightedSum: 0,
          _ttftWeight: 0,
        };
        if (acc.upstreamName) acc.upstreamSet.add(acc.upstreamName);
        modelMap.set(gk, acc);
      }
      if (!acc.upstreamName && (m.upstreamName || m.upstreamModel)) {
        acc.upstreamName = m.upstreamName || m.upstreamModel;
      }
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      if (Array.isArray(m.upstreamModels)) {
        for (const u of m.upstreamModels) {
          if (u) acc.upstreamSet.add(u);
        }
      }
      const calls = Math.max(0, Number(m.calls || 0));
      const inTok = Math.max(0, Number(m.inputTokens || 0));
      const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(m.outputTokens || 0));
      const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
      const respTok =
        m.responseTokens != null
          ? Math.max(0, Number(m.responseTokens))
          : Math.max(0, outTok - thinkTok);
      const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
      const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
      const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

      acc.calls += calls;
      acc.inputTokens += inTok;
      acc.cacheReadTokens += cacheTok;
      acc.outputTokens += outTok;
      acc.thinkingTokens += thinkTok;
      acc.responseTokens += respTok;
      acc.totalTokens += totTok;
      acc.costUsd += costUsd;
      acc.unpricedCalls += unpricedCalls;

      if (Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0) {
        const w = Math.max(1, outTok || calls || 1);
        acc._speedWeightedSum += Number(m.avgTokPerSec) * w;
        acc._speedWeight += w;
      }
      if (
        m.avgTtftSec != null &&
        Number.isFinite(Number(m.avgTtftSec)) &&
        Number(m.avgTtftSec) >= 0
      ) {
        const w = Math.max(1, calls || 1);
        acc._ttftWeightedSum += Number(m.avgTtftSec) * w;
        acc._ttftWeight += w;
      }
    }
  }

  combinedSteps.sort(
    (a, b) =>
      (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0) ||
      (Number(b?.agentIndex) || 0) - (Number(a?.agentIndex) || 0) ||
      (Number(b?.stepIndex) || 0) - (Number(a?.stepIndex) || 0)
  );

  const mergedModels = Array.from(modelMap.values())
    .map((acc) => {
      const promptTok = acc.inputTokens + acc.cacheReadTokens;
      return {
        label: acc.label,
        shortName: acc.shortName,
        rawModel: acc.rawModel,
        upstreamName: acc.upstreamName,
        upstreamModels: Array.from(acc.upstreamSet),
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        outputTokens: acc.outputTokens,
        thinkingTokens: acc.thinkingTokens,
        responseTokens: acc.responseTokens,
        totalTokens: acc.totalTokens,
        costUsd: +acc.costUsd.toFixed(6),
        unpricedCalls: acc.unpricedCalls,
        avgTokPerSec:
          acc._speedWeight > 0 ? +(acc._speedWeightedSum / acc._speedWeight).toFixed(1) : null,
        avgTtftSec:
          acc._ttftWeight > 0 ? +(acc._ttftWeightedSum / acc._ttftWeight).toFixed(1) : null,
        cacheHitPct: promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  return { steps: combinedSteps, models: mergedModels };
}

function getLineMetricSwitchOptions() {
  return [
    { value: 'totalTokens', label: t('steps.metricTotalTokens') },
    { value: 'context', label: t('steps.metricContext') },
    { value: 'tps', label: t('steps.metricTps') },
    { value: 'ttft', label: t('steps.metricTtft') },
    { value: 'cost', label: t('steps.metricCost') },
  ];
}

function getFitMetricSwitchOptions() {
  return [
    { value: 'tps', label: t('steps.metricTps') },
    { value: 'ttft', label: t('steps.metricTtft') },
    { value: 'cache', label: t('steps.metricCache') },
    { value: 'cost', label: t('steps.metricCost') },
  ];
}

export const StepsDetailView = defineComponent({
  name: 'StepsDetailView',
  setup({ onCleanup }) {
    let selectedAgentScopes = [uiStore.getState().selectedAgentScope || 'all'];
    let lastSyncedUiScope = uiStore.getState().selectedAgentScope || 'all';
    let selectedTableModels = ['__all__'];
    let selectedLineModels = ['__all__'];

    function applyAgentScopesSelection(nextScopes) {
      selectedAgentScopes = nextScopes;
      const mappedSingle =
        nextScopes.length === 1 && nextScopes[0] !== 'all' ? nextScopes[0] : 'all';
      const prevUiScope = uiStore.getState().selectedAgentScope;
      lastSyncedUiScope = mappedSingle;
      if (prevUiScope !== mappedSingle) {
        uiStore.setState({
          selectedAgentScope: mappedSingle,
          ...(mappedSingle === 'all' ? { ctxInspectorAgentId: 'auto' } : {}),
        });
      } else if (latestSlice) {
        renderStepsData(latestSlice);
      }
    }

    const inlineScopeSelect = CustomSelect({
      multiple: true,
      allValue: 'all',
      collapseAll: true,
      multiUnit: t('steps.unitAgent'),
      modelValue: selectedAgentScopes,
      icon: 'layers',
      placeholder: t('steps.allAgents'),
      className: 'steps-inline-scope-select',
      options: [{ value: 'all', label: t('steps.allAgents') }],
      onUpdateModelValue: (nextScopes) => {
        if (!Array.isArray(nextScopes) || nextScopes.length === 0) return;
        applyAgentScopesSelection(nextScopes);
      },
    });
    inlineScopeSelect.el.setAttribute('hidden', '');

    const stepsModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedTableModels,
      placeholder: t('steps.allModels'),
      className: 'steps-inline-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedTableModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    stepsModelSelect.el.setAttribute('hidden', '');

    const subTabSwitch = SegmentedControl({
      ariaLabel: t('steps.title'),
      modelValue: uiStore.getState().stepsSubTab,
      options: [
        { value: 'steps', label: t('steps.tabSteps', { count: 0 }) },
        { value: 'models', label: t('steps.tabModels') },
      ],
      onUpdateModelValue: (nextTab) => {
        uiStore.setState({ stepsSubTab: nextTab });
      },
    });

    // --- 子视图 1：单步明细表（委托给可复用的 `StepTableWidget` 解耦组件） ---
    const stepTableWidget = StepTableWidget({
      onSelectAgentScopes: applyAgentScopesSelection,
    });
    const {
      stepsTablePane,
      stepsTableEl,
      stepsTheadRow,
      stepsTbody,
      turnTipEl,
      hideTurnTip,
      syncTableHeaderColumns,
      renderStepTable,
    } = stepTableWidget.refs;
    const stepsScroll = CustomScrollbar({
      contentEl: stepsTablePane,
      className: 'table-scroll-host',
    });

    // --- 子视图 2：总汇总分析面板 ---
    let selectedLineMetric = 'totalTokens';
    let selectedFitMetric = 'tps';
    let latestFitUiState = {
      hasMultipleModels: false,
      isFitPooledAll: false,
      effectiveFitModelKeys: [],
      fitActiveKeySet: new Set(),
    };

    let fitLockedCascadeId = null;
    let fitLockedModelKeys = [];
    let fitPinnedWhileVisible = false;
    let fitUserPicked = false;

    const lineTitleEl = h('span', { className: 'sstep-card-title', text: t('steps.lineTitle') });
    const lineSummaryBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('header.convMetaSteps', { count: 0 }),
    });
    const lineModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedLineModels,
      placeholder: t('steps.allModels'),
      className: 'sstep-fit-model-select sstep-line-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedLineModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    lineModelSelect.el.setAttribute('hidden', '');

    const lineMetricSwitch = SegmentedControl({
      ariaLabel: t('steps.lineTitle'),
      modelValue: selectedLineMetric,
      options: getLineMetricSwitchOptions(),
      onUpdateModelValue: (nextMetric) => {
        selectedLineMetric = nextMetric;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const sessionLineChart = createSessionLineChart();
    const sessionLineCard = h('div', { className: 'sstep-card sstep-line-card' }, [
      h('div', { className: 'sstep-card-head' }, [
        h('div', { className: 'sstep-card-title-group' }, [lineTitleEl, lineSummaryBadge]),
        h('div', { className: 'sstep-fit-controls' }, [
          lineModelSelect.el,
          lineMetricSwitch.el,
        ]),
      ]),
      sessionLineChart.el,
    ]);

    const fitTitleEl = h('span', { className: 'sstep-card-title', text: t('steps.fitTitle') });
    const fitSummaryBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('header.convMetaSteps', { count: 0 }),
    });
    const fitModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: ['__all__'],
      placeholder: t('steps.selectModel'),
      className: 'sstep-fit-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModelKeys) => {
        if (!Array.isArray(nextModelKeys) || nextModelKeys.length === 0) return;
        fitLockedModelKeys = nextModelKeys;
        fitUserPicked = true;
        fitPinnedWhileVisible = true;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    fitModelSelect.el.setAttribute('hidden', '');

    const fitMetricSwitch = SegmentedControl({
      ariaLabel: t('steps.fitTitle'),
      modelValue: selectedFitMetric,
      options: getFitMetricSwitchOptions(),
      onUpdateModelValue: (nextMetric) => {
        selectedFitMetric = nextMetric;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const modelFitChart = createModelFitChart();
    const modelFitCard = h('div', { className: 'sstep-card sstep-fit-card' }, [
      h('div', { className: 'sstep-card-head' }, [
        h('div', { className: 'sstep-card-title-group' }, [fitTitleEl, fitSummaryBadge]),
        h('div', { className: 'sstep-fit-controls' }, [fitModelSelect.el, fitMetricSwitch.el]),
      ]),
      modelFitChart.el,
    ]);

    const modelsSectionTitleEl = h('span', {
      className: 'sstep-card-title',
      text: t('steps.modelsTitle'),
    });
    const modelsSummaryMeta = h('span', {
      className: 'cons-badge text-mono',
      text: t('cons.callsCount', { calls: 0 }),
    });
    const modelsEmptyEl = h('div', {
      className: 'smodel-empty text-muted',
      text: t('steps.modelsEmpty'),
    });
    const modelsListEl = h('div', { className: 'smodel-list' });
    const modelsSummarySection = h('div', { className: 'smodel-section' }, [
      h('div', { className: 'smodel-section-head' }, [modelsSectionTitleEl, modelsSummaryMeta]),
      modelsEmptyEl,
      modelsListEl,
    ]);

    const modelsAnalyticsPane = h('div', { className: 'table-viewport models-analytics-pane' }, [
      sessionLineCard,
      modelFitCard,
      modelsSummarySection,
    ]);
    const modelsScroll = CustomScrollbar({
      contentEl: modelsAnalyticsPane,
      className: 'table-scroll-host',
    });
    modelsScroll.el.setAttribute('hidden', '');

    const panelTitleTextEl = h('span', { text: t('steps.title') });
    const panelEl = h(
      'section',
      {
        className: 'panel',
        style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative;',
      },
      [
        h('div', { className: 'panel-header steps-panel-header' }, [
          h('span', { className: 'panel-title steps-panel-title' }, [
            createSvgIcon('table', { size: 13 }),
            panelTitleTextEl,
          ]),
          h('div', { className: 'steps-header-controls' }, [
            inlineScopeSelect.el,
            stepsModelSelect.el,
            subTabSwitch.el,
          ]),
        ]),
        stepsScroll.el,
        modelsScroll.el,
        turnTipEl,
      ]
    );
    stepTableWidget.refs.setBoundsElGetter(() => panelEl);

    const rootEl = h('div', { className: 'view-pane' }, [panelEl]);

    let latestSlice = null;
    let isDirty = false;

    function resolveDefaultActiveModelKey(scopedConv, chronoSteps, models, availableModelKeys) {
      if (scopedConv?.hasKnownModel !== false) {
        const activeCand = getStepModelGroupKey({
          baseModelLabel: scopedConv?.activeBaseModelLabel,
          baseModelShort: scopedConv?.activeBaseModelShort,
          modelLabel: scopedConv?.activeModelLabel,
          modelShort: scopedConv?.activeModelShort,
        });
        if (
          activeCand &&
          activeCand !== t('fmt.unknownModel') &&
          availableModelKeys.has(activeCand)
        ) {
          return activeCand;
        }
      }
      for (let i = chronoSteps.length - 1; i >= 0; i--) {
        const st = chronoSteps[i];
        if (!st || st.isCompactionStep) continue;
        const gk = getStepModelGroupKey(st);
        if (gk && availableModelKeys.has(gk)) return gk;
      }
      if (chronoSteps.length > 0) {
        const gk = getStepModelGroupKey(chronoSteps[chronoSteps.length - 1]);
        if (gk && availableModelKeys.has(gk)) return gk;
      }
      if (models.length > 0) {
        const firstKey = getStepModelGroupKey(models[0]);
        if (firstKey && availableModelKeys.has(firstKey)) return firstKey;
      }
      return '__all__';
    }

    function normalizeMultiModelSelection(rawSelection, availableModelKeys) {
      if (availableModelKeys.size <= 1) return ['__all__'];
      const arr = Array.isArray(rawSelection) ? rawSelection : [];
      if (arr.length === 0 || arr.includes('__all__')) return ['__all__'];
      const valid = Array.from(new Set(arr.filter((k) => availableModelKeys.has(k))));
      if (valid.length === 0) return ['__all__'];
      return valid;
    }

    function refreshStaticLocaleLabels() {
      patchText(panelTitleTextEl, t('steps.title'));
      patchText(lineTitleEl, t('steps.lineTitle'));
      patchText(fitTitleEl, t('steps.fitTitle'));
      patchText(modelsSectionTitleEl, t('steps.modelsTitle'));
      patchText(modelsEmptyEl, t('steps.modelsEmpty'));
      lineMetricSwitch.setProps({
        modelValue: selectedLineMetric,
        options: getLineMetricSwitchOptions(),
      });
      fitMetricSwitch.setProps({
        modelValue: selectedFitMetric,
        options: getFitMetricSwitchOptions(),
      });
      const colKeys = normalizeClientStepColumns(latestSlice?.stepTableColumns);
      syncTableHeaderColumns(colKeys);
      if (!latestSlice) {
        subTabSwitch.setProps({
          modelValue: uiStore.getState().stepsSubTab,
          options: [
            { value: 'steps', label: t('steps.tabSteps', { count: 0 }) },
            { value: 'models', label: t('steps.tabModels') },
          ],
        });
      }
    }

    function renderStepsData(slice) {
      if (!slice) return;
      const uiSt = uiStore.getState();
      const locale = getEffectiveLocale();

      const currentCid = String(slice.cascadeId || slice.activeConversation?.cascadeId || '');
      if (currentCid !== fitLockedCascadeId) {
        if (fitLockedCascadeId !== null) {
          selectedAgentScopes = [uiSt.selectedAgentScope || 'all'];
          lastSyncedUiScope = uiSt.selectedAgentScope || 'all';
          selectedTableModels = ['__all__'];
          selectedLineModels = ['__all__'];
        }
        fitLockedCascadeId = currentCid;
        fitUserPicked = false;
        fitPinnedWhileVisible = false;
        fitLockedModelKeys = [];
      }

      const baseScope = resolveScopedConversation(
        { activeConversation: slice.activeConversation },
        'all',
        uiSt.ctxInspectorAgentId,
        true
      );
      const { hasSubagents, agents, subagents, mainAgent, aggregated } = baseScope;

      let effectiveScopes = ['main'];
      let isMergedMultiAgents = false;
      let steps = [];
      let models = [];
      let activeModelSource = baseScope.scopedConv;

      patchAttr(inlineScopeSelect.el, 'hidden', !hasSubagents);
      if (hasSubagents) {
        const validAgentIds = ['main', ...subagents.map((s) => s.agentId)];
        const validSet = new Set(validAgentIds);
        if (selectedAgentScopes.length === 0 || selectedAgentScopes.includes('all')) {
          effectiveScopes = ['all'];
        } else {
          const filtered = selectedAgentScopes.filter((id) => validSet.has(id));
          effectiveScopes =
            filtered.length === 0 || filtered.length >= validAgentIds.length
              ? ['all']
              : filtered;
        }
        selectedAgentScopes = effectiveScopes;

        const scopeOpts = [
          {
            value: 'all',
            label: t('steps.allAgents'),
            meta: t('header.convMetaSteps', { count: aggregated?.stepCount ?? 0 }),
          },
          {
            value: 'main',
            label: t('fmt.mainAgent'),
            meta: t('header.convMetaSteps', { count: mainAgent?.stepCount ?? 0 }),
          },
          ...subagents.map((s) => ({
            value: s.agentId,
            label: formatAgentLabel(s),
            meta: t('header.convMetaSteps', { count: s.stepCount || 0 }),
          })),
        ];
        inlineScopeSelect.setProps({
          modelValue: effectiveScopes,
          options: scopeOpts,
          placeholder: t('steps.allAgents'),
          multiUnit: t('steps.unitAgent'),
        });

        if (effectiveScopes[0] === 'all') {
          steps = aggregated?.recentSteps || [];
          models = aggregated?.modelBreakdown || [];
          isMergedMultiAgents = true;
          activeModelSource = aggregated;
        } else if (effectiveScopes.length === 1) {
          const targetId = effectiveScopes[0];
          const unit =
            targetId === 'main'
              ? mainAgent
              : agents.find((a) => a.agentId === targetId) || mainAgent;
          steps = unit?.recentSteps || [];
          models = unit?.modelBreakdown || [];
          isMergedMultiAgents = false;
          activeModelSource = unit;
        } else {
          const scopeSet = new Set(effectiveScopes);
          const selectedUnits = agents.filter((a) =>
            scopeSet.has(a.isMain ? 'main' : a.agentId)
          );
          const merged = mergeSelectedAgentUnits(selectedUnits);
          steps = merged.steps;
          models = merged.models;
          isMergedMultiAgents = true;
          activeModelSource =
            selectedUnits.find((a) => a.isRunning) || selectedUnits[0] || aggregated;
        }
      } else {
        inlineScopeSelect.close();
        steps = slice.recentSteps || [];
        models = slice.sessionModelBreakdown || [];
      }

      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };

      const showAgentPrefix = isMergedMultiAgents;
      const showModels = uiSt.stepsSubTab === 'models';
      const chronoSteps = toChronologicalSteps(steps, isMergedMultiAgents);

      const stepTtftFallbackMap = new Map();
      const stepModelOptionMap = new Map();
      for (const st of chronoSteps) {
        const gk = getStepModelGroupKey(st);
        if (!stepModelOptionMap.has(gk)) {
          const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
          stepModelOptionMap.set(gk, {
            label: disp.baseText || disp.text || gk,
            calls: 0,
          });
        }
        stepModelOptionMap.get(gk).calls += 1;

        if (showModels && !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0) {
          const prev = stepTtftFallbackMap.get(gk) || { sum: 0, count: 0 };
          prev.sum += Number(st.ttftSec);
          prev.count += 1;
          stepTtftFallbackMap.set(gk, prev);
        }
      }

      const availableModelKeys = new Set();
      const modelColorByGroup = new Map();
      const perModelOptions = [];
      for (const m of models) {
        const gk = getStepModelGroupKey(m);
        if (availableModelKeys.has(gk)) continue;
        availableModelKeys.add(gk);
        modelColorByGroup.set(
          gk,
          MODEL_COLOR_VARS[(availableModelKeys.size - 1) % MODEL_COLOR_VARS.length]
        );
        const disp = resolveModelDisplayInfo(m, displaySettings, {
          preferLabelInShort: false,
          fallback: gk,
        });
        perModelOptions.push({
          value: gk,
          label: disp.baseText || disp.text || gk,
          meta: t('header.convMetaSteps', { count: Number(m.calls || 0) }),
        });
      }
      for (const [gk, info] of stepModelOptionMap.entries()) {
        if (!availableModelKeys.has(gk)) {
          availableModelKeys.add(gk);
          modelColorByGroup.set(
            gk,
            MODEL_COLOR_VARS[(availableModelKeys.size - 1) % MODEL_COLOR_VARS.length]
          );
          perModelOptions.push({
            value: gk,
            label: info.label,
            meta: t('header.convMetaSteps', { count: info.calls }),
          });
        }
      }

      const hasMultipleModels = availableModelKeys.size > 1;
      const modelSelectOptions = [
        {
          value: '__all__',
          label: t('steps.allModels'),
          meta: t('header.convMetaSteps', { count: steps.length }),
        },
        ...perModelOptions,
      ];

      // 1. “按步查看”动态列头同步与表格行级增量对账
      selectedTableModels = normalizeMultiModelSelection(
        selectedTableModels,
        availableModelKeys
      );
      const showStepsModelFilter = uiSt.stepsSubTab === 'steps' && hasMultipleModels;
      patchAttr(stepsModelSelect.el, 'hidden', !showStepsModelFilter);
      if (hasMultipleModels) {
        stepsModelSelect.setProps({
          modelValue: selectedTableModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
        if (!showStepsModelFilter) stepsModelSelect.close();
      } else {
        stepsModelSelect.close();
      }

      const tableModelFilterSet = selectedTableModels.includes('__all__')
        ? null
        : new Set(selectedTableModels);
      const tableSteps = tableModelFilterSet
        ? steps.filter((st) => tableModelFilterSet.has(getStepModelGroupKey(st)))
        : steps;

      const stepsTabLabel =
        tableSteps.length !== steps.length
          ? t('steps.tabStepsFiltered', {
              filtered: tableSteps.length,
              total: steps.length,
            })
          : t('steps.tabSteps', { count: steps.length });

      subTabSwitch.setProps({
        options: [
          { value: 'steps', label: stepsTabLabel },
          { value: 'models', label: t('steps.tabModels') },
        ],
      });

      if (!showModels) {
        const colKeys = normalizeClientStepColumns(slice.stepTableColumns);
        renderStepTable(tableSteps, slice.cascadeId, colKeys, locale, {
          effectiveScopes,
          hasSubagents,
          isMergedMultiAgents,
          showStepTurnRail: slice.showStepTurnRail === true,
          showStepAgentBadge: slice.showStepAgentBadge !== false,
          showStepSpeedColor: slice.showStepSpeedColor === true,
          stepTokenComboFormat: slice.stepTokenComboFormat,
          displaySettings,
        });
        stepsScroll.refresh();
      }

      // 2. 顶部“会话走势”更新
      selectedLineModels = normalizeMultiModelSelection(
        selectedLineModels,
        availableModelKeys
      );

      // 3. 顶部“趋势拟合”模型锁定随当前会话与代理范围更新。
      const defaultActiveModelKey = resolveDefaultActiveModelKey(
        activeModelSource,
        chronoSteps,
        models,
        availableModelKeys
      );
      const sanitizedLocked = fitLockedModelKeys.includes('__all__')
        ? ['__all__']
        : Array.from(new Set(fitLockedModelKeys.filter((k) => availableModelKeys.has(k))));

      if (!showModels) {
        fitPinnedWhileVisible = false;
      }
      if ((!fitPinnedWhileVisible && !fitUserPicked) || sanitizedLocked.length === 0) {
        fitLockedModelKeys = [defaultActiveModelKey];
      } else {
        fitLockedModelKeys = sanitizedLocked;
      }
      if (!showModels) return;
      if (availableModelKeys.size > 0) fitPinnedWhileVisible = true;

      patchAttr(lineModelSelect.el, 'hidden', !hasMultipleModels);
      if (hasMultipleModels) {
        lineModelSelect.setProps({
          modelValue: selectedLineModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
      } else {
        lineModelSelect.close();
      }

      const lineRes = sessionLineChart.update({
        steps: chronoSteps,
        modelGroupKey: selectedLineModels[0] || '__all__',
        modelGroupKeys: selectedLineModels,
        modelColorByGroup,
        metric: selectedLineMetric,
        showAgentPrefix,
        displaySettings,
      });
      patchText(lineSummaryBadge, lineRes.summaryBadge);

      const effectiveFitModelKeys =
        availableModelKeys.size === 0
          ? ['__all__']
          : !hasMultipleModels
            ? [Array.from(availableModelKeys)[0]]
            : fitLockedModelKeys.length > 0
              ? fitLockedModelKeys
              : [defaultActiveModelKey];

      patchAttr(fitModelSelect.el, 'hidden', !hasMultipleModels);
      if (hasMultipleModels) {
        fitModelSelect.setProps({
          modelValue: effectiveFitModelKeys,
          options: modelSelectOptions,
          placeholder: t('steps.selectModel'),
          multiUnit: t('steps.unitModel'),
        });
      } else {
        fitModelSelect.close();
      }

      const fitRes = modelFitChart.update({
        steps: chronoSteps,
        modelGroupKey: effectiveFitModelKeys[0] || '__all__',
        modelGroupKeys: effectiveFitModelKeys,
        modelColorByGroup,
        metric: selectedFitMetric,
        showAgentPrefix,
        displaySettings,
      });
      patchText(fitSummaryBadge, fitRes.summaryBadge);

      // 4. 极简模型总览列表增量对账
      const displayModels = mergeModelsByDisplayName(models, displaySettings, { fallback: '—' });
      let sumCalls = 0;
      let sumTokens = 0;
      let sumCost = 0;
      let sumUnpriced = 0;
      for (const m of displayModels) {
        sumCalls += Math.max(0, Number(m.calls || 0));
        sumTokens += Math.max(0, Number(m.totalTokens || 0));
        sumUnpriced += Math.max(0, Number(m.unpricedCalls || 0));
        if (Number.isFinite(Number(m.costUsd))) {
          sumCost += Math.max(0, Number(m.costUsd));
        }
      }

      if (displayModels.length === 0) {
        patchText(modelsSummaryMeta, t('cons.callsCount', { calls: 0 }));
      } else {
        const modelCountPart =
          displayModels.length > 1
            ? t('steps.modelsSummaryPrefix', { count: displayModels.length })
            : '';
        const isAllUnpricedSum = sumCalls > 0 && sumUnpriced >= sumCalls && !(sumCost > 0);
        patchText(
          modelsSummaryMeta,
          `${modelCountPart}${t('cons.callsCount', { calls: sumCalls })} · ${formatTokens(sumTokens)} · ${formatUsd(
            isAllUnpricedSum ? null : sumCost,
            {
              precise: sumCost > 0 && sumCost < 0.1,
            }
          )}`
        );
      }
      patchAttr(modelsEmptyEl, 'hidden', displayModels.length > 0);
      patchAttr(modelsListEl, 'hidden', displayModels.length === 0);

      const isFitPooledAll = effectiveFitModelKeys.includes('__all__');
      const fitActiveKeySet = new Set(isFitPooledAll ? [] : effectiveFitModelKeys);
      latestFitUiState = {
        hasMultipleModels,
        isFitPooledAll,
        effectiveFitModelKeys: [...effectiveFitModelKeys],
        fitActiveKeySet,
      };

      patchKeyedList(modelsListEl, displayModels, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) => {
          const gk = getStepModelGroupKey(m);
          const fbTtft = stepTtftFallbackMap.get(gk);
          const avgTtft =
            m.avgTtftSec != null
              ? m.avgTtftSec
              : fbTtft && fbTtft.count > 0
                ? +(fbTtft.sum / fbTtft.count).toFixed(1)
                : null;
          const cardGroupKeys =
            Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
              ? m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl }))
              : [gk];
          const isActiveFit =
            hasMultipleModels && cardGroupKeys.some((k) => fitActiveKeySet.has(k));
          return `${locale}:${m.displayText}:${m.displayTitle}:${m.calls}:${sumCalls}:${displayModels.length}:${m.avgTokPerSec}:${avgTtft}:${m.cacheHitPct}:${m.inputTokens}:${m.cacheReadTokens}:${m.thinkingTokens}:${m.responseTokens}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${isActiveFit}:${hasMultipleModels}`;
        },
        createRow: () => {
          const nameEl = h('strong', { className: 'smodel-name' });
          const callsPillEl = h('span', { className: 'smodel-calls-pill text-mono' });
          const tokEl = h('span', { className: 'smodel-tok text-mono' });
          const costEl = h('strong', { className: 'smodel-cost text-mono' });
          const segBar = createFourSegmentBar();
          segBar.el.classList.add('smodel-seg-bar');

          const perfEl = h('span', { className: 'smodel-perf text-mono' });
          const splitEl = h('span', { className: 'smodel-split text-mono' });

          const cardEl = h('div', { className: 'smodel-card' }, [
            h('div', { className: 'smodel-head' }, [
              h('div', { className: 'smodel-ident' }, [nameEl, callsPillEl]),
              h('div', { className: 'smodel-totals' }, [tokEl, costEl]),
            ]),
            segBar.el,
            h('div', { className: 'smodel-foot' }, [perfEl, splitEl]),
          ]);

          return {
            el: cardEl,
            refs: { nameEl, callsPillEl, tokEl, costEl, segBar, perfEl, splitEl },
          };
        },
        updateRow: (refs, m, _idx, cardEl) => {
          const gk = getStepModelGroupKey(m);
          const cardGroupKeys =
            Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
              ? Array.from(
                  new Set(m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl })))
                )
              : [gk];
          const dispText = m.displayText || '—';
          const dispTitle = m.displayTitle || dispText;
          patchText(refs.nameEl, dispText);
          patchAttr(refs.nameEl, 'title', dispTitle);

          const calls = Math.max(0, Number(m.calls || 0));
          const callSharePct = sumCalls > 0 ? Math.round((calls / sumCalls) * 100) : 0;
          patchText(
            refs.callsPillEl,
            displayModels.length > 1
              ? t('steps.modelCallsShare', { calls, pct: callSharePct })
              : t('steps.modelCallsOnly', { calls })
          );

          const inTok = Math.max(0, Number(m.inputTokens || 0));
          const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
          const outTok = Math.max(0, Number(m.outputTokens || 0));
          const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
          const respTok =
            m.responseTokens != null
              ? Math.max(0, Number(m.responseTokens))
              : Math.max(0, outTok - thinkTok);

          patchText(refs.tokEl, formatTokens(m.totalTokens || 0));
          const costNum = Number(m.costUsd || 0);
          const isAllUnpriced =
            calls > 0 && Number(m.unpricedCalls || 0) >= calls && !(costNum > 0);
          patchText(
            refs.costEl,
            formatUsd(isAllUnpriced ? null : costNum, { precise: costNum > 0 && costNum < 0.1 })
          );

          refs.segBar.update({
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            responseTokens: respTok,
            thinkingTokens: thinkTok,
          });

          const fbTtft = stepTtftFallbackMap.get(gk);
          const resolvedAvgTtft =
            m.avgTtftSec != null
              ? Number(m.avgTtftSec)
              : fbTtft && fbTtft.count > 0
                ? fbTtft.sum / fbTtft.count
                : null;
          const promptTok = inTok + cacheTok;
          const resolvedCachePct =
            m.cacheHitPct != null
              ? Number(m.cacheHitPct)
              : promptTok > 0
                ? +((cacheTok / promptTok) * 100).toFixed(1)
                : 0;

          patchText(
            refs.perfEl,
            t('steps.modelPerfFoot', {
              tps: formatMetric(m.avgTokPerSec, ' tok/s'),
              ttft: formatMetric(resolvedAvgTtft, 's'),
              cache: resolvedCachePct,
            })
          );
          patchText(
            refs.splitEl,
            t('steps.modelSplitFoot', {
              inTok: formatTokens(inTok),
              cacheTok: formatTokens(cacheTok),
              thinkTok: formatTokens(thinkTok),
              respTok: formatTokens(respTok),
            })
          );

          const isActiveFit =
            hasMultipleModels && cardGroupKeys.some((k) => fitActiveKeySet.has(k));
          patchClasses(cardEl, { 'is-fit-active': isActiveFit });
          patchAttr(
            cardEl,
            'title',
            !hasMultipleModels
              ? dispTitle
              : isActiveFit
                ? t('steps.fitActiveCardTitle', { title: dispTitle })
                : t('steps.fitInactiveCardTitle', { text: dispText })
          );
          cardEl.onclick = (e) => {
            const curState = latestFitUiState;
            if (!curState.hasMultipleModels) return;
            if (e && (e.ctrlKey || e.metaKey || e.shiftKey) && !curState.isFitPooledAll) {
              const cardSet = new Set(cardGroupKeys);
              const curActive = cardGroupKeys.some((k) => curState.fitActiveKeySet.has(k));
              const next = curActive
                ? curState.effectiveFitModelKeys.filter((k) => !cardSet.has(k))
                : Array.from(new Set([...curState.effectiveFitModelKeys, ...cardGroupKeys]));
              fitLockedModelKeys = next.length > 0 ? next : [...cardGroupKeys];
              fitUserPicked = true;
              fitPinnedWhileVisible = true;
              if (latestSlice) renderStepsData(latestSlice);
              return;
            }
            const isAlreadySole =
              !curState.isFitPooledAll &&
              curState.effectiveFitModelKeys.length === cardGroupKeys.length &&
              cardGroupKeys.every((k) => curState.fitActiveKeySet.has(k));
            if (!isAlreadySole || !fitUserPicked) {
              fitLockedModelKeys = [...cardGroupKeys];
              fitUserPicked = true;
              fitPinnedWhileVisible = true;
              if (latestSlice) renderStepsData(latestSlice);
            }
          };
        },
      });

      modelsScroll.refresh();
    }

    const unsubUi = uiStore.subscribe(
      (st) => st.stepsSubTab,
      (tab) => {
        hideTurnTip();
        subTabSwitch.setValue(tab);
        patchAttr(stepsScroll.el, 'hidden', tab !== 'steps');
        patchAttr(modelsScroll.el, 'hidden', tab !== 'models');
        if (getVisibleMonitorView() === 'steps' && latestSlice) {
          renderStepsData(latestSlice);
        } else if (tab === 'steps') {
          stepsScroll.refresh();
        } else {
          modelsScroll.refresh();
        }
      }
    );

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        activeConversation: st.telemetry?.activeConversation,
        cascadeId: st.telemetry?.activeConversation?.cascadeId,
        recentSteps: st.telemetry?.activeConversation?.recentSteps,
        sessionModelBreakdown: st.telemetry?.activeConversation?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
        showStepTurnRail: st.telemetry?.settings?.showStepTurnRail === true,
        showStepAgentBadge: st.telemetry?.settings?.showStepAgentBadge !== false,
        showStepSpeedColor: st.telemetry?.settings?.showStepSpeedColor === true,
        stepTokenComboFormat: normalizeClientStepTokenComboFormat(
          st.telemetry?.settings?.stepTokenComboFormat
        ),
        stepTableColumns: st.telemetry?.settings?.stepTableColumns,
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'steps') {
          if (!fitUserPicked) {
            fitPinnedWhileVisible = false;
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderStepsData(slice);
      }
    );

    let prevScope = uiStore.getState().selectedAgentScope;
    let prevActiveView = getVisibleMonitorView();

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        selectedAgentScope: st.selectedAgentScope,
      }),
      (uiSlice) => {
        const scopeChanged = uiSlice.selectedAgentScope !== prevScope;
        if (uiSlice.selectedAgentScope !== lastSyncedUiScope) {
          lastSyncedUiScope = uiSlice.selectedAgentScope;
          selectedAgentScopes = [uiSlice.selectedAgentScope || 'all'];
        }
        const viewEntered = uiSlice.activeView === 'steps' && prevActiveView !== 'steps';
        prevScope = uiSlice.selectedAgentScope;
        prevActiveView = uiSlice.activeView;
        if (uiSlice.activeView !== 'steps') {
          hideTurnTip();
          fitPinnedWhileVisible = false;
          if (scopeChanged) isDirty = true;
          return;
        }
        if ((isDirty || scopeChanged || viewEntered) && latestSlice) {
          isDirty = false;
          renderStepsData(latestSlice);
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        refreshStaticLocaleLabels();
        if (getVisibleMonitorView() === 'steps' && latestSlice) {
          renderStepsData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      unsubUi();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      stepTableWidget.destroy();
      sessionLineChart.destroy?.();
      modelFitChart.destroy?.();
      inlineScopeSelect.destroy();
      stepsModelSelect.destroy();
      subTabSwitch.destroy();
      lineModelSelect.destroy();
      lineMetricSwitch.destroy();
      fitModelSelect.destroy();
      fitMetricSwitch.destroy();
      stepsScroll.destroy();
      modelsScroll.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        modelsListEl,
        inlineScopeSelect,
        stepsModelSelect,
        subTabSwitch,
        lineModelSelect,
        lineMetricSwitch,
        fitModelSelect,
        fitMetricSwitch,
        stepsScroll,
        modelsScroll,
      },
    };
  },
});
