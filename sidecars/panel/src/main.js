/**
 * @fileoverview Async entry point for Antigravity Usage & Speed Monitor.
 * Automatically branches between Auxiliary Sidebar Webview mode (`#app-root`)
 * and Main Window Dual-Mount Overlay mode (`window.__AGUsageMonitorBridge`).
 */

import { App } from './App.js';
import { applyAppearanceToRoot } from './core/appearance.js';
import { setI18nLanguage } from './i18n/index.js';
import { startAsyncTelemetryLoop, telemetryStore } from './store/telemetryStore.js';

async function bootstrapApp(mountTarget = document.getElementById('app-root')) {
  if (!mountTarget) return null;
  const appInstance = App();
  mountTarget.appendChild(appInstance.el);

  const syncDocAppearance = (settings) => {
    setI18nLanguage(settings?.language);
    if (typeof document !== 'undefined' && document.documentElement) {
      applyAppearanceToRoot(document.documentElement, settings, { includeFontScale: true });
    }
  };
  syncDocAppearance(telemetryStore.getState().telemetry?.settings);

  const unsubAppearance = telemetryStore.subscribe(
    (st) => st.telemetry?.settings,
    syncDocAppearance
  );

  const stopPolling = startAsyncTelemetryLoop(2000);
  return {
    appInstance,
    stopPolling: () => {
      unsubAppearance();
      stopPolling();
    },
  };
}

function startEntry() {
  if (
    typeof window !== 'undefined' &&
    !window.sidecar?.fetch &&
    typeof document !== 'undefined' &&
    document.documentElement
  ) {
    document.documentElement.setAttribute('data-standalone', 'true');
  }
  bootstrapApp();
}

function init() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      startEntry();
    });
  } else {
    startEntry();
  }
}

init();
