/**
 * @fileoverview Preferences Tab 3: `SettingsOtherTab.js` ("其他").
 * Houses Model Identifier Formatting,
 * Local Trajectory Cache Rebuild, and Two-Step Factory Preference Reset.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { setI18nLanguage, t } from '../../i18n/index.js';
import {
  normalizeClientModelDisplayMode,
  normalizeClientOrchestratorIdMode,
  rebuildTrajectoryCache,
  resetAllSettings,
  saveSettingsPatch,
} from '../../store/telemetryStore.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';

function getStepModelDisplayOptions() {
  return [
    { value: 'short', label: t('settings.oth.modelShort') },
    { value: 'upstream', label: t('settings.oth.modelUpstream') },
    { value: 'upstream_compact', label: t('settings.oth.modelUpstreamCompact') },
  ];
}

function getOrchestratorIdDisplayOptions() {
  return [
    { value: 'compact', label: t('settings.oth.orchCompact') },
    { value: 'full', label: t('settings.oth.orchFull') },
  ];
}

export const SettingsOtherTab = defineComponent({
  name: 'SettingsOtherTab',
  setup({ onCleanup }) {
    let draftModelDisplayMode = 'short';
    let draftOrchestratorIdMode = 'compact';
    let latestSettings = null;
    let modelTimer = null;
    let maintTimer = null;
    let resetConfirmTimer = null;
    let resetConfirmArmed = false;
    let isRebuilding = false;
    let isResetting = false;

    const modelStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const maintStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showModelFeedback(text, autoClearMs = 1500) {
      if (modelTimer) {
        clearTimeout(modelTimer);
        modelTimer = null;
      }
      patchText(modelStatusText, text);
      if (text && autoClearMs > 0) {
        modelTimer = setTimeout(() => {
          modelTimer = null;
          patchText(modelStatusText, '');
        }, autoClearMs);
      }
    }

    function showMaintFeedback(text, autoClearMs = 2500) {
      if (maintTimer) {
        clearTimeout(maintTimer);
        maintTimer = null;
      }
      patchText(maintStatusText, text);
      if (text && autoClearMs > 0) {
        maintTimer = setTimeout(() => {
          maintTimer = null;
          patchText(maintStatusText, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: 模型标识显示 ---
    const modelCardTitleEl = h('span', { text: t('settings.oth.modelTitle') });
    const modelFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.modelFormat'),
    });
    const orchFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.orchFormat'),
    });

    const stepModelSelect = CustomSelect({
      modelValue: 'short',
      icon: 'table',
      options: getStepModelDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientModelDisplayMode(val);
        draftModelDisplayMode = nextMode;
        stepModelSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            modelDisplayMode: nextMode,
            showUpstreamModel: nextMode !== 'short',
          });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const orchestratorIdSelect = CustomSelect({
      modelValue: 'compact',
      icon: 'layers',
      options: getOrchestratorIdDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientOrchestratorIdMode(val);
        draftOrchestratorIdMode = nextMode;
        orchestratorIdSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ orchestratorIdMode: nextMode });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const modelPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          modelCardTitleEl,
        ]),
        modelStatusText,
      ]),
      h('div', { className: 'form-row' }, [modelFormatLabelEl, stepModelSelect.el]),
      h('div', { className: 'form-row' }, [orchFormatLabelEl, orchestratorIdSelect.el]),
    ]);

    // --- Card 2: 缓存与重置 ---
    const maintTitleEl = h('span', { text: t('settings.oth.maintTitle') });
    const cacheLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.cacheLabel'),
    });
    const cacheDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.cacheDesc'),
    });

    const rebuildBtnText = h('span', { text: t('settings.oth.rebuildBtn') });
    const rebuildCacheBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isRebuilding) return;
          isRebuilding = true;
          patchAttr(rebuildCacheBtn, 'disabled', true);
          patchText(rebuildBtnText, t('settings.oth.rebuildingBtn'));
          showMaintFeedback(t('settings.oth.rebuildingBtn'), 0);
          try {
            const res = await rebuildTrajectoryCache();
            if (res?.ok !== false) {
              showMaintFeedback(t('settings.oth.rebuildDone'), 2800);
            } else {
              showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
            }
          } catch {
            showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
          } finally {
            isRebuilding = false;
            patchAttr(rebuildCacheBtn, 'disabled', false);
            patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rebuildBtnText]
    );

    const resetLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.resetLabel'),
    });
    const resetDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.resetDesc'),
    });

    const resetBtnText = h('span', { text: t('settings.oth.resetAllBtn') });

    function disarmResetConfirm() {
      resetConfirmArmed = false;
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      patchClasses(resetAllBtn, { 'btn-danger-confirm': false });
      if (!isResetting) {
        patchText(resetBtnText, t('settings.oth.resetAllBtn'));
      }
    }

    const resetAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isResetting) return;
          if (!resetConfirmArmed) {
            resetConfirmArmed = true;
            patchClasses(resetAllBtn, { 'btn-danger-confirm': true });
            patchText(resetBtnText, t('settings.oth.resetConfirmBtn'));
            if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
            resetConfirmTimer = setTimeout(() => {
              disarmResetConfirm();
            }, 3000);
            return;
          }

          disarmResetConfirm();
          isResetting = true;
          patchAttr(resetAllBtn, 'disabled', true);
          patchText(resetBtnText, t('settings.oth.resettingBtn'));
          showMaintFeedback(t('settings.oth.resettingBtn'), 0);
          try {
            const res = await resetAllSettings();
            setI18nLanguage(res?.settings?.language || 'zh-CN');
            showMaintFeedback(t('settings.oth.resetAllDone'), 2800);
          } catch {
            showMaintFeedback(t('settings.saveFailed'), 2800);
          } finally {
            isResetting = false;
            patchAttr(resetAllBtn, 'disabled', false);
            patchText(resetBtnText, t('settings.oth.resetAllBtn'));
          }
        },
      },
      [resetBtnText]
    );

    const maintPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('refresh', { size: 13 }),
          maintTitleEl,
        ]),
        maintStatusText,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [cacheLabelEl, cacheDescEl]),
        rebuildCacheBtn,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [resetLabelEl, resetDescEl]),
        resetAllBtn,
      ]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      modelPanel,
      maintPanel,
    ]);

    function renderSettings(settings) {
      if (!settings) return;
      latestSettings = settings;
      draftModelDisplayMode = normalizeClientModelDisplayMode(
        settings.modelDisplayMode,
        settings.showUpstreamModel
      );
      draftOrchestratorIdMode = normalizeClientOrchestratorIdMode(settings.orchestratorIdMode);
      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
    }

    function refreshLabels() {
      patchText(modelCardTitleEl, t('settings.oth.modelTitle'));
      patchText(modelFormatLabelEl, t('settings.oth.modelFormat'));
      patchText(orchFormatLabelEl, t('settings.oth.orchFormat'));
      patchText(maintTitleEl, t('settings.oth.maintTitle'));
      patchText(cacheLabelEl, t('settings.oth.cacheLabel'));
      patchText(cacheDescEl, t('settings.oth.cacheDesc'));
      patchText(resetLabelEl, t('settings.oth.resetLabel'));
      patchText(resetDescEl, t('settings.oth.resetDesc'));

      if (!isRebuilding) {
        patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
      }
      if (!isResetting) {
        patchText(
          resetBtnText,
          resetConfirmArmed ? t('settings.oth.resetConfirmBtn') : t('settings.oth.resetAllBtn')
        );
      }

      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
    }

    onCleanup(() => {
      if (modelTimer) clearTimeout(modelTimer);
      if (maintTimer) clearTimeout(maintTimer);
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
      stepModelSelect.destroy();
      orchestratorIdSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepModelSelect,
        orchestratorIdSelect,
        rebuildCacheBtn,
        resetAllBtn,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
