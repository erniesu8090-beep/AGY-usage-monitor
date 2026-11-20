/**
 * @fileoverview Shared Decoupled Capsule Bar Primitives & Widget (`CapsuleBarWidget.js`).
 * Powers both the live host window capsule (`WindowOverlayShell.js`) and the
 * real-UI structure preview (`SettingsStructureTab.js`), ensuring 100% DOM/CSS parity.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { t } from '../../i18n/index.js';
import { createSvgIcon, SVG_NS } from '../../icons/SvgIcon.js';
import { resolveCapsuleMetricPresentation } from '../../registries/metricRegistry.js';
import {
  normalizeClientTopbarSlots,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';

export const RING_RADIUS = 5.2;
export const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

/**
 * Compute shared context ring + 1..5 capsule slot metric payload from telemetry & scoped conversation.
 */
export function buildCapsuleSlotContext(
  data,
  { scopedConv = null, overviewConv = null, ctxAgent = null, aggregated = null } = {}
) {
  if (!data) return { hasTelemetry: false };
  const activeConv = data.activeConversation || {};
  const overviewActive = overviewConv || scopedConv || aggregated || activeConv;
  const capActive = scopedConv || aggregated || activeConv || {};
  const ctx = ctxAgent?.context || overviewActive.context || activeConv.context || {};
  const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
  const totalTokens = Number(ctx.totalTokens || 0);
  const usedPct =
    limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
  const dashOffset = +(
    RING_CIRCUMFERENCE *
    (1 - Math.max(0, Math.min(100, usedPct)) / 100)
  ).toFixed(2);

  const isRunning = Boolean(aggregated?.isRunning || activeConv.isRunning);
  const capInTok = Math.max(0, Number(capActive.inputTokens || 0));
  const capCacheTok = Math.max(0, Number(capActive.cacheReadTokens || 0));
  const capOutTok = Math.max(0, Number(capActive.outputTokens || 0));
  const sessionTokens =
    Number(capActive.stepCount || 0) > 0 ||
    capActive.totalTokens != null ||
    capInTok + capCacheTok + capOutTok > 0
      ? Math.max(0, Number(capActive.totalTokens ?? capInTok + capCacheTok + capOutTok))
      : null;

  return {
    hasTelemetry: true,
    usedPct,
    dashOffset,
    isRunning,
    tps: scopedConv?.latestTokPerSec ?? aggregated?.latestTokPerSec ?? activeConv.latestTokPerSec ?? null,
    avgTps: scopedConv?.avgTokPerSec ?? aggregated?.avgTokPerSec ?? activeConv.avgTokPerSec ?? null,
    ttft: scopedConv?.latestTtftSec ?? aggregated?.latestTtftSec ?? activeConv.latestTtftSec ?? null,
    stepCost:
      scopedConv?.latestStepCostUsd ??
      aggregated?.latestStepCostUsd ??
      activeConv.latestStepCostUsd ??
      null,
    sessionCost:
      scopedConv?.sessionCostUsd ?? aggregated?.sessionCostUsd ?? activeConv.sessionCostUsd ?? null,
    cacheHitPct:
      Number(capActive.stepCount || 0) > 0
        ? capActive.latestCacheHitPct ?? capActive.sessionCacheHitPct ?? null
        : null,
    latestPromptTokens: capActive.latestPromptTokens ?? null,
    sessionTokens,
    quotas: data.quotas,
  };
}

/**
 * Create a single reusable capsule metric slot node (`0..4`) with an optional SVG context ring.
 */
export function createCapsuleSlotNode(slotIndex, initialMetric) {
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 14 14');
  ringSvg.setAttribute('class', 'wm-ring-svg');
  ringSvg.setAttribute('aria-hidden', 'true');

  const ringTrack = document.createElementNS(SVG_NS, 'circle');
  ringTrack.setAttribute('cx', '7');
  ringTrack.setAttribute('cy', '7');
  ringTrack.setAttribute('r', String(RING_RADIUS));
  ringTrack.setAttribute('class', 'wm-ring-track');

  const ringFill = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('cx', '7');
  ringFill.setAttribute('cy', '7');
  ringFill.setAttribute('r', String(RING_RADIUS));
  ringFill.setAttribute('class', 'wm-ring-fill');
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

  const isNone = initialMetric === 'none';
  const isCtx = initialMetric === 'context';
  const textSpan = h('span', {
    className: isCtx ? 'wm-slot-text wm-ctx-pct' : 'wm-slot-text',
    text: isNone
      ? ''
      : isCtx
        ? '--%'
        : initialMetric === 'tps'
          ? '-- t/s'
          : initialMetric === 'ttft'
            ? '--s'
            : t('capsule.quotaUnknown'),
  });
  const el = h(
    'span',
    {
      className: isNone
        ? 'wm-cap-slot'
        : isCtx
          ? 'wm-cap-slot wm-ctx-seg'
          : initialMetric === 'tps'
            ? 'wm-cap-slot wm-seg-speed'
            : initialMetric === 'ttft'
              ? 'wm-cap-slot wm-seg-metric'
              : 'wm-cap-slot wm-seg-quota',
      hidden: isNone,
      'data-slot-idx': String(slotIndex),
      'data-metric': initialMetric,
      'data-vis-rank': isNone ? '' : String(slotIndex + 1),
    },
    isCtx ? [ringSvg, textSpan] : [textSpan]
  );

  return {
    el,
    ringSvg,
    ringFill,
    textSpan,
    ringMounted: isCtx,
  };
}

/**
 * Patch 5 pre-allocated capsule slots and 4 separators in-place via `metricRegistry`.
 */
export function syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx) {
  let visRank = 0;
  const visRanks = [0, 0, 0, 0, 0];
  for (let i = 0; i < capsuleSlots.length; i += 1) {
    const slot = capsuleSlots[i];
    const metricKey = i < slotKeys.length ? slotKeys[i] : 'none';
    const pres = resolveCapsuleMetricPresentation(metricKey, slotCtx, RING_CIRCUMFERENCE);
    if (pres.hidden) {
      patchAttr(slot.el, 'hidden', true);
      patchAttr(slot.el, 'data-metric', 'none');
      patchAttr(slot.el, 'data-vis-rank', '');
      continue;
    }
    visRank += 1;
    visRanks[i] = visRank;
    patchAttr(slot.el, 'hidden', false);
    patchAttr(slot.el, 'data-metric', pres.metric);
    patchAttr(slot.el, 'data-vis-rank', String(visRank));

    if (pres.showRing && !slot.ringMounted) {
      slot.el.insertBefore(slot.ringSvg, slot.textSpan);
      slot.ringMounted = true;
    } else if (!pres.showRing && slot.ringMounted) {
      slot.ringSvg.remove();
      slot.ringMounted = false;
    }

    const toneCls =
      pres.toneClass || (pres.danger ? 'tone-danger' : pres.warn ? 'tone-warn' : '');
    const fullSegClass = `${pres.segClass}${pres.running ? ' state-running' : ''}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.el, 'class', fullSegClass);
    const fullTextClass = `${pres.textClass}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.textSpan, 'class', fullTextClass);
    patchText(slot.textSpan, pres.text);

    if (pres.showRing) {
      slot.ringFill.setAttribute('stroke-dashoffset', String(pres.dashOffset));
      patchClasses(slot.ringFill, { 'tone-warn': pres.warn, 'tone-danger': pres.danger });
    }
  }

  for (let s = 0; s < capsuleSeps.length; s += 1) {
    const sepEl = capsuleSeps[s];
    const nextRank = visRanks[s + 1] || 0;
    const showSep = nextRank >= 2;
    patchAttr(sepEl, 'hidden', !showSep);
    patchAttr(sepEl, 'data-sep-for-rank', showSep ? String(nextRank) : '');
  }
}

/**
 * Standalone Capsule Bar Preview Widget mounting `.wm-capsule-btn` inside the preview bar.
 */
export const CapsuleBarWidget = defineComponent({
  name: 'CapsuleBarWidget',
  setup() {
    const capsuleSlots = [
      createCapsuleSlotNode(0, 'tps'),
      createCapsuleSlotNode(1, 'ttft'),
      createCapsuleSlotNode(2, 'context'),
      createCapsuleSlotNode(3, 'none'),
      createCapsuleSlotNode(4, 'none'),
    ];
    const capsuleSeps = [
      h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
      h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    ];

    const capsuleBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-capsule-btn',
        tabindex: '-1',
        'aria-hidden': 'true',
      },
      [
        capsuleSlots[0].el,
        capsuleSeps[0],
        capsuleSlots[1].el,
        capsuleSeps[1],
        capsuleSlots[2].el,
        capsuleSeps[2],
        capsuleSlots[3].el,
        capsuleSeps[3],
        capsuleSlots[4].el,
      ]
    );

    const capsuleCluster = h('div', { className: 'preview-capsule-cluster' }, [capsuleBtn]);

    const titlebarLeftMock = h('div', { className: 'preview-host-left is-titlebar' }, [
      h('span', { className: 'preview-win-title', text: 'Antigravity' }),
    ]);

    const hostBarEl = h(
      'div',
      { className: 'preview-capsule-bar' },
      [titlebarLeftMock, capsuleCluster]
    );

    const rootEl = h('div', { className: 'capsule-preview-widget' }, [hostBarEl]);

    function update({ data } = {}) {
      const settings = data?.settings || {};
      const slotKeys = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);

      if (!data) {
        patchClasses(capsuleBtn, { 'is-running': false });
        syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, { hasTelemetry: false });
        return;
      }

      const { scopedConv, ctxAgent, aggregated } = resolveScopedConversation(
        data,
        'all',
        'auto'
      );
      const slotCtx = buildCapsuleSlotContext(data, { scopedConv, ctxAgent, aggregated });

      patchClasses(capsuleBtn, { 'is-running': slotCtx.isRunning });
      syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
    }

    return {
      el: rootEl,
      refs: {
        update,
        capsuleBtn,
        capsuleSlots,
        capsuleSeps,
        hostBarEl,
      },
    };
  },
});
