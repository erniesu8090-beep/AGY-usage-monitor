/**
 * @fileoverview Standalone decoupled Live Running Tasks Widget (`LiveActivityWidget.js`).
 * Displays active multi-session running conversations & collapsible subagent activity
 * with an isolated 1s elapsed timer lifecycle. Supports both Overview/Hover widget mode
 * and controlled Multi-Session Floating Panel mode (`WindowOverlayShell.js`).
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import {
  formatAgentBadgeText,
  formatElapsedSec,
  formatLiveActivityDetail,
  formatLiveActivityLabel,
  getAgentBadgeClass,
} from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import {
  fetchTelemetry,
  resolveScopedConversation,
  telemetryStore,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

export function buildFallbackRunningConversations(
  data,
  { agents = [], aggregated = null, latestTokPerSec = undefined, contextUsedPct = undefined } = {}
) {
  if (!data) return [];
  if (Array.isArray(data.runningConversations) && data.runningConversations.length > 0) {
    return data.runningConversations;
  }
  const activeConv = data.activeConversation || {};
  if (!activeConv.isRunning && !aggregated?.isRunning) return [];
  return [
    {
      cascadeId: activeConv.cascadeId || 'current',
      title: activeConv.title || t('live.currentSession'),
      isCurrentSelected: true,
      isMainRunning: Boolean(activeConv.isRunning),
      isRunning: true,
      mainActivity: activeConv.liveActivity || aggregated?.liveActivity || null,
      subagentCount: Math.max(0, (agents?.length || 1) - 1),
      runningSubagentCount: (agents || []).filter((a) => !a.isMain && a.isRunning).length,
      ...(latestTokPerSec !== undefined ? { latestTokPerSec } : {}),
      ...(contextUsedPct !== undefined ? { contextUsedPct } : {}),
      subagents: (agents || [])
        .filter((a) => !a.isMain)
        .map((s, idx) => ({
          cascadeId: s.cascadeId || s.agentId,
          index: s.index || idx + 1,
          agentKind: s.agentKind || (s.isSideQuestion ? 'side_question' : 'subagent'),
          agentOrdinal: s.agentOrdinal || (s.isSideQuestion ? s.sideIndex || 0 : s.index || idx + 1),
          customRole: s.customRole,
          ...(s.isSideQuestion ? { isSideQuestion: true, sideIndex: s.sideIndex || 0 } : {}),
          badgeText: formatAgentBadgeText({ ...s, index: s.index || idx + 1 }),
          shortLabel: s.shortLabel || `${t('fmt.subAgent')} #${idx + 1}`,
          role: s.role || `${t('fmt.subAgent')} #${idx + 1}`,
          isRunning: Boolean(s.isRunning),
          stepCount: Number(s.stepCount || 0),
          lastModifiedMs: s.lastModifiedMs || 0,
          liveActivity: s.liveActivity || {
            phase: s.isRunning ? 'thinking' : 'done',
            actionKey: s.isRunning ? 'thinking' : 'done',
            label: s.isRunning ? t('live.thinking') : t('live.done'),
            detail: '',
            stepProgress: '',
            startedAtMs: s.lastModifiedMs || 0,
            signature: `${s.agentId}:${s.stepCount || 0}`,
          },
        })),
    },
  ];
}

export const LiveActivityWidget = defineComponent({
  name: 'LiveActivityWidget',
  setup({ props, onCleanup }) {
    const interactive = props.interactive !== false;
    const preview = Boolean(props.preview);
    const defaultExpandRunningSubs = Boolean(props.defaultExpandRunningSubs);
    const showSessionExtras = Boolean(props.showSessionExtras);
    const onSelectSession =
      typeof props.onSelectSession === 'function' ? props.onSelectSession : null;
    const onLayoutChange =
      typeof props.onLayoutChange === 'function' ? props.onLayoutChange : null;
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const isVisibleFn =
      typeof props.isVisibleFn === 'function' ? props.isVisibleFn : () => true;

    const liveActivityBar = h('div', {
      className: 'live-activity-list',
      hidden: true,
      'aria-live': 'polite',
    });

    const manualSubExpandMap = new Map();
    const activityTimersMap = new Map();
    let liveTickTimer = null;
    let latestUpdateArgs = null;

    function resolveIsExpanded(item) {
      const runSubCount = Number(item?.runningSubagentCount || 0);
      if (!interactive) return runSubCount > 0;
      if (manualSubExpandMap.has(item.cascadeId)) {
        return Boolean(manualSubExpandMap.get(item.cascadeId));
      }
      return defaultExpandRunningSubs ? runSubCount > 0 : false;
    }

    function bindLiveElapsedTimer(timerKey, sig, rawStartMs, targetEl) {
      const now = Date.now();
      const prev = activityTimersMap.get(timerKey);
      let startMs = prev?.startMs || 0;
      if (!prev || prev.sig !== sig) {
        const validRaw = Number(rawStartMs || 0);
        startMs = validRaw > 0 && validRaw <= now + 2000 ? validRaw : now;
      } else if (startMs <= 0 && Number(rawStartMs) > 0 && Number(rawStartMs) <= now + 2000) {
        startMs = Number(rawStartMs);
      }
      activityTimersMap.set(timerKey, { sig, startMs, el: targetEl });
      const elapsedSec = Math.max(0, (now - startMs) / 1000);
      patchText(targetEl, formatElapsedSec(elapsedSec));
    }

    function updateLiveElapsedDisplay() {
      const now = Date.now();
      for (const entry of activityTimersMap.values()) {
        if (!entry?.el) continue;
        const elapsedSec = entry.startMs > 0 ? Math.max(0, (now - entry.startMs) / 1000) : 0;
        patchText(entry.el, formatElapsedSec(elapsedSec));
      }
    }

    function pauseTicker() {
      if (liveTickTimer) {
        clearInterval(liveTickTimer);
        liveTickTimer = null;
      }
    }

    function stopLiveTicker() {
      pauseTicker();
      activityTimersMap.clear();
    }

    function ensureLiveTicker() {
      if (!isVisibleFn() || activityTimersMap.size === 0) {
        pauseTicker();
        return;
      }
      if (!liveTickTimer) {
        liveTickTimer = setInterval(updateLiveElapsedDisplay, 1000);
      }
    }

    function resumeTicker() {
      if (activityTimersMap.size > 0) {
        updateLiveElapsedDisplay();
        ensureLiveTicker();
      }
    }

    function createLiveTaskCard() {
      const dotIcon = createSvgIcon('dot', { size: 11 });
      patchClasses(dotIcon, { 'is-pulsing': true });
      const dotWrap = h('span', { className: 'live-activity-dot' }, [dotIcon]);
      const titleEl = h('strong', {
        className: 'live-task-title',
        text: t('live.currentSession'),
      });
      const hereTagEl = showSessionExtras
        ? h('span', {
            className: 'wm-session-tag is-here',
            hidden: true,
            text: t('multi.hereTag'),
          })
        : null;
      const metricsEl = showSessionExtras
        ? h('span', {
            className: 'wm-task-metrics text-mono',
            hidden: true,
            text: '',
          })
        : null;
      const subToggleBtn = h('button', {
        type: 'button',
        className: 'live-sub-toggle',
        hidden: true,
        text: t('live.subToggleIdle', { total: 0, arrow: '▸' }),
      });
      const elapsedEl = h('span', {
        className: 'live-activity-elapsed text-mono',
        text: '0s',
      });

      const headerEl = h('div', { className: 'live-task-header' }, [
        h('div', { className: 'live-task-title-wrap' }, [
          dotWrap,
          titleEl,
          ...(hereTagEl ? [hereTagEl] : []),
        ]),
        h('div', { className: 'live-task-header-right' }, [
          ...(metricsEl ? [metricsEl] : []),
          subToggleBtn,
          elapsedEl,
        ]),
      ]);

      const mainBadge = h('span', {
        className: 'agent-badge badge-main',
        hidden: true,
        text: t('fmt.mainBadge'),
      });
      const mainPhase = h('strong', {
        className: 'live-activity-phase',
        text: t('live.thinking'),
      });
      const mainProgress = h('span', {
        className: 'live-activity-progress text-mono',
        hidden: true,
        text: '',
      });
      const mainSep = h('span', { className: 'live-activity-sep', hidden: true, text: '·' });
      const mainDetail = h('span', {
        className: 'live-activity-detail',
        hidden: true,
        text: '',
      });

      const mainRowEl = h('div', { className: 'live-task-main-row' }, [
        mainBadge,
        mainPhase,
        mainProgress,
        mainSep,
        mainDetail,
      ]);

      const subListEl = h('div', { className: 'live-sub-list', hidden: true });
      const cardEl = h('div', { className: 'live-task-card' }, [headerEl, mainRowEl, subListEl]);

      return {
        el: cardEl,
        refs: {
          cardEl,
          dotIcon,
          titleEl,
          hereTagEl,
          metricsEl,
          subToggleBtn,
          elapsedEl,
          mainBadge,
          mainPhase,
          mainProgress,
          mainSep,
          mainDetail,
          subListEl,
        },
      };
    }

    function createLiveSubRow() {
      const subBadge = h('span', {
        className: 'agent-badge badge-sub-1',
        text: t('fmt.subBadge', { index: 1 }),
      });
      const subRole = h('span', { className: 'live-sub-role', text: t('fmt.subAgent') });
      const subSummary = h('span', { className: 'live-sub-summary', text: '' });
      const subElapsed = h('span', { className: 'live-sub-elapsed text-mono', text: '0s' });

      const rowEl = h('div', { className: 'live-sub-row' }, [
        h('div', { className: 'live-sub-left' }, [subBadge, subRole, subSummary]),
        subElapsed,
      ]);

      return {
        el: rowEl,
        refs: {
          rowEl,
          subBadge,
          subRole,
          subSummary,
          subElapsed,
        },
      };
    }

    function update({ data = null, items = null, hostRouteConversationId = '' } = {}) {
      latestUpdateArgs = { data, items, hostRouteConversationId };
      if (!data && !Array.isArray(items)) {
        patchAttr(liveActivityBar, 'hidden', true);
        stopLiveTicker();
        return;
      }

      let rawRunningList = Array.isArray(items) ? items : null;
      if (!rawRunningList) {
        const { agents, aggregated } = resolveScopedConversation(
          data,
          'all',
          getCtxAgentId()
        );
        rawRunningList = buildFallbackRunningConversations(data, { agents, aggregated });
      }

      if (manualSubExpandMap.size > 0) {
        const runningIdsSet = new Set(rawRunningList.map((item) => item.cascadeId));
        for (const id of [...manualSubExpandMap.keys()]) {
          if (!runningIdsSet.has(id)) {
            manualSubExpandMap.delete(id);
          }
        }
      }

      const hasRunningTasks = rawRunningList.length > 0;
      patchAttr(liveActivityBar, 'hidden', !hasRunningTasks);
      if (!hasRunningTasks) {
        stopLiveTicker();
        patchKeyedList(liveActivityBar, [], {});
        return;
      }

      if (!isVisibleFn()) {
        pauseTicker();
        return;
      }

      const locale = getEffectiveLocale();
      const hostRouteLower = showSessionExtras
        ? String(hostRouteConversationId || '').toLowerCase()
        : '';

      const activeTimerKeys = new Set();
      for (const item of rawRunningList) {
        activeTimerKeys.add(`main:${item.cascadeId}`);
        const subCount = Number(item.subagentCount || item.subagents?.length || 0);
        const isExp = resolveIsExpanded(item);
        if (subCount > 0 && isExp) {
          for (const sub of item.subagents || []) {
            if (sub?.isRunning) {
              activeTimerKeys.add(`sub:${sub.cascadeId}`);
            }
          }
        }
      }

      patchKeyedList(liveActivityBar, rawRunningList, {
        keyFn: (item) => item.cascadeId,
        sigFn: (item) => {
          const isExp = resolveIsExpanded(item);
          const isHere =
            showSessionExtras &&
            Boolean(hostRouteLower) &&
            String(item.cascadeId || '').toLowerCase() === hostRouteLower;
          const subSig = (item.subagents || [])
            .map(
              (s) =>
                `${s.cascadeId}:${s.isRunning}:${s.stepCount}:${s.liveActivity?.signature || ''}:${s.liveActivity?.startedAtMs || 0}`
            )
            .join('|');
          return `${locale}:${item.cascadeId}:${item.title}:${isHere}:${item.isMainRunning}:${item.subagentCount}:${item.runningSubagentCount}:${isExp}:${item.latestTokPerSec ?? ''}:${item.contextUsedPct ?? ''}:${item.mainActivity?.signature || ''}:${item.mainActivity?.startedAtMs || 0}:${subSig}`;
        },
        createRow: createLiveTaskCard,
        updateRow: (refs, item) => {
          const act = item.mainActivity || {
            phase: 'thinking',
            actionKey: 'thinking',
            label: t('live.thinking'),
            detail: '',
            stepProgress: '',
            startedAtMs: item.lastModifiedMs || 0,
            signature: `fallback:${item.lastModifiedMs || 0}`,
          };

          const isWaiting = act.phase === 'waiting';
          const isCompacting = act.phase === 'compacting';
          patchClasses(refs.cardEl, {
            'is-waiting': isWaiting,
            'is-compacting': isCompacting,
          });
          patchClasses(refs.dotIcon, { 'is-pulsing': true });

          const convTitle = item.title || item.cascadeId?.slice(0, 8) || t('live.currentSession');
          patchText(refs.titleEl, convTitle);
          if (interactive && !preview) {
            patchAttr(
              refs.titleEl,
              'title',
              onSelectSession
                ? t('multi.inspectSessionTitle', { title: convTitle })
                : t('live.switchSessionTitle', { title: convTitle })
            );
            refs.titleEl.onclick = (e) => {
              e?.stopPropagation?.();
              if (onSelectSession) {
                onSelectSession(item.cascadeId);
              } else if (item.cascadeId && item.cascadeId !== 'current') {
                uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
                telemetryStore.setState({ selectedConversationId: item.cascadeId });
                fetchTelemetry({ force: false });
              }
            };
          }

          if (showSessionExtras && refs.hereTagEl && refs.metricsEl) {
            const isHere =
              Boolean(hostRouteLower) &&
              String(item.cascadeId || '').toLowerCase() === hostRouteLower;
            patchText(refs.hereTagEl, t('multi.hereTag'));
            patchAttr(refs.hereTagEl, 'hidden', !isHere);

            const metricParts = [];
            if (Number.isFinite(item.latestTokPerSec) && item.latestTokPerSec > 0) {
              metricParts.push(
                `${item.latestTokPerSec >= 100 ? Math.round(item.latestTokPerSec) : item.latestTokPerSec.toFixed(1)} t/s`
              );
            }
            if (item.contextUsedPct != null && Number.isFinite(Number(item.contextUsedPct))) {
              metricParts.push(`${Math.round(Number(item.contextUsedPct))}%`);
            }
            const metricsStr = metricParts.join(' · ');
            patchAttr(refs.metricsEl, 'hidden', !metricsStr);
            if (metricsStr) {
              patchText(refs.metricsEl, metricsStr);
            }
          }

          const subCount = Number(item.subagentCount || item.subagents?.length || 0);
          const runSubCount = Number(item.runningSubagentCount || 0);
          const isExpanded = resolveIsExpanded(item);
          patchText(refs.mainBadge, t('fmt.mainBadge'));
          patchAttr(refs.mainBadge, 'hidden', subCount === 0);
          patchAttr(refs.subToggleBtn, 'hidden', subCount === 0);
          if (subCount > 0) {
            const arrow = isExpanded ? '▾' : '▸';
            const toggleText =
              runSubCount > 0
                ? t('live.subToggleRunning', { run: runSubCount, total: subCount, arrow })
                : t('live.subToggleIdle', { total: subCount, arrow });
            patchText(refs.subToggleBtn, toggleText);
            patchClasses(refs.subToggleBtn, { 'is-expanded': isExpanded });
            if (interactive) {
              patchAttr(
                refs.subToggleBtn,
                'title',
                isExpanded ? t('live.subCollapseTitle') : t('live.subExpandTitle')
              );
              refs.subToggleBtn.onclick = (e) => {
                e.stopPropagation();
                manualSubExpandMap.set(item.cascadeId, !isExpanded);
                if (latestUpdateArgs) update(latestUpdateArgs);
                onLayoutChange?.();
              };
            }
          }

          const mainLabel = formatLiveActivityLabel(act, 'live.thinking');
          const detailStr = formatLiveActivityDetail(act);
          const mainTimerKey = `main:${item.cascadeId}`;
          activeTimerKeys.add(mainTimerKey);
          bindLiveElapsedTimer(
            mainTimerKey,
            `${item.cascadeId}:${act.signature || mainLabel}`,
            act.startedAtMs,
            refs.elapsedEl
          );

          patchText(refs.mainPhase, mainLabel);
          const progText = act.stepProgress ? `[${act.stepProgress}]` : '';
          patchAttr(refs.mainProgress, 'hidden', !progText);
          if (progText) {
            patchText(refs.mainProgress, progText);
          }

          patchAttr(refs.mainSep, 'hidden', !detailStr);
          patchAttr(refs.mainDetail, 'hidden', !detailStr);
          patchText(refs.mainDetail, detailStr);

          if (interactive && !showSessionExtras) {
            const fullTooltip = `[${convTitle}] ${t('fmt.mainAgent')} · ${mainLabel}${progText ? ` ${progText}` : ''}${detailStr ? ` · ${detailStr}` : ''}`;
            patchAttr(refs.cardEl, 'title', fullTooltip);
          }

          const showSubs = subCount > 0 && isExpanded;
          patchAttr(refs.subListEl, 'hidden', !showSubs);
          if (showSubs) {
            const subItems = item.subagents || [];
            patchKeyedList(refs.subListEl, subItems, {
              keyFn: (sub) => sub.cascadeId,
              sigFn: (sub) =>
                `${locale}:${sub.cascadeId}:${sub.role}:${sub.isRunning}:${sub.stepCount}:${sub.liveActivity?.signature || ''}:${sub.isRunning ? activityTimersMap.has(`sub:${sub.cascadeId}`) : true}`,
              createRow: createLiveSubRow,
              updateRow: (subRefs, sub) => {
                const subAct = sub.liveActivity || {
                  phase: sub.isRunning ? 'thinking' : 'done',
                  actionKey: sub.isRunning ? 'thinking' : 'done',
                  label: sub.isRunning ? t('live.thinking') : t('live.done'),
                  detail: '',
                  stepProgress: '',
                  startedAtMs: sub.lastModifiedMs || 0,
                };
                patchClasses(subRefs.rowEl, { 'is-done': !sub.isRunning });

                const badgeCls = getAgentBadgeClass(sub.index || 1, false);
                const subBadgeText = formatAgentBadgeText({
                  ...sub,
                  isMain: false,
                  index: sub.index || 1,
                });
                patchAttr(subRefs.subBadge, 'class', `agent-badge ${badgeCls}`);
                patchText(subRefs.subBadge, subBadgeText);

                const fallbackRole =
                  sub.agentKind === 'side_question' || sub.isSideQuestion
                    ? `${t('fmt.sideQuestion')}${sub.agentOrdinal || sub.sideIndex ? ` #${sub.agentOrdinal || sub.sideIndex}` : ''}`
                    : `${t('fmt.subAgent')}${sub.agentOrdinal || sub.index ? ` #${sub.agentOrdinal || sub.index}` : ''}`;
                const roleText =
                  sub.customRole !== undefined
                    ? sub.customRole || fallbackRole
                    : sub.role || sub.shortLabel || fallbackRole;
                patchText(subRefs.subRole, roleText);

                const subLabel = sub.isRunning
                  ? formatLiveActivityLabel(subAct, 'live.running')
                  : formatLiveActivityLabel(subAct, 'live.done');
                const subDetail = formatLiveActivityDetail(subAct);
                const subProg = subAct.stepProgress ? ` [${subAct.stepProgress}]` : '';
                const summaryStr = showSessionExtras
                  ? sub.isRunning
                    ? `${subLabel}${subProg}${subDetail ? ` · ${subDetail}` : ''}`
                    : t('live.doneWithSteps', { steps: sub.stepCount || 0 })
                  : [`${subLabel}${subProg}`.trim(), subDetail].filter(Boolean).join(' ');
                patchAttr(subRefs.subSummary, 'hidden', !summaryStr);
                patchText(subRefs.subSummary, summaryStr);

                if (interactive && !showSessionExtras) {
                  patchAttr(
                    subRefs.rowEl,
                    'title',
                    `[${subBadgeText}] ${roleText}${summaryStr ? ` ${summaryStr}` : ''}`
                  );
                }

                if (sub.isRunning) {
                  const subTimerKey = `sub:${sub.cascadeId}`;
                  activeTimerKeys.add(subTimerKey);
                  bindLiveElapsedTimer(
                    subTimerKey,
                    `${sub.cascadeId}:${subAct.signature || subLabel}`,
                    subAct.startedAtMs || sub.lastModifiedMs,
                    subRefs.subElapsed
                  );
                } else {
                  activityTimersMap.delete(`sub:${sub.cascadeId}`);
                  patchText(
                    subRefs.subElapsed,
                    t('header.convMetaSteps', { count: sub.stepCount || 0 })
                  );
                }
              },
            });
          }
        },
      });

      for (const key of [...activityTimersMap.keys()]) {
        if (!activeTimerKeys.has(key)) {
          activityTimersMap.delete(key);
        }
      }
      updateLiveElapsedDisplay();
      ensureLiveTicker();
    }

    onCleanup(() => {
      stopLiveTicker();
    });

    return {
      el: liveActivityBar,
      refs: {
        update,
        pauseTicker,
        resumeTicker,
        stopLiveTicker,
      },
    };
  },
});
