/**
 * @fileoverview Theme accent palette & panel font-scale appearance engine.
 * Applies CSS custom properties cleanly to Sidebar `:root` and Shadow DOM hosts,
 * while strictly isolating `#ag-usage-monitor-capsule` from font scaling.
 */

export const THEME_ACCENT_PRESETS = Object.freeze([
  { key: 'host', labelKey: 'settings.gen.accentHost', cssColor: '' },
  { key: 'blue', labelKey: 'settings.gen.accentBlue', cssColor: 'hsl(217 84% 53%)' },
  { key: 'emerald', labelKey: 'settings.gen.accentEmerald', cssColor: 'hsl(152 66% 39%)' },
  { key: 'amber', labelKey: 'settings.gen.accentAmber', cssColor: 'hsl(34 88% 46%)' },
  { key: 'violet', labelKey: 'settings.gen.accentViolet', cssColor: 'hsl(262 76% 58%)' },
  { key: 'cyan', labelKey: 'settings.gen.accentCyan', cssColor: 'hsl(191 82% 41%)' },
  { key: 'rose', labelKey: 'settings.gen.accentRose', cssColor: 'hsl(346 78% 54%)' },
]);

const FONT_SCALE_FACTORS = Object.freeze({
  sm: 0.92,
  md: 1,
  lg: 1.14,
  xl: 1.28,
});

const PANEL_SCALE_FACTORS = Object.freeze({
  sm: 1,
  md: 1,
  lg: 1.09,
  xl: 1.18,
});

export function normalizeClientThemeAccent(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return THEME_ACCENT_PRESETS.some((p) => p.key === val) ? val : 'host';
}

export function normalizeClientFontScale(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONT_SCALE_FACTORS, val) ? val : 'md';
}

function setOrClearStyleVar(el, propName, value) {
  if (!el || !el.style) return;
  if (value) {
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, value);
    } else {
      el.style[propName] = value;
    }
  } else if (typeof el.style.removeProperty === 'function') {
    el.style.removeProperty(propName);
  } else if (typeof el.style.setProperty === 'function') {
    el.style.setProperty(propName, '');
  }
}

/**
 * Synchronize theme accent and (optionally) font scale tokens onto a root/host element.
 *
 * @param {HTMLElement | null | undefined} targetEl
 * @param {object | null | undefined} settings
 * @param {{ includeFontScale?: boolean }} [options]
 */
export function applyAppearanceToRoot(targetEl, settings, { includeFontScale = true } = {}) {
  if (!targetEl || !targetEl.style) return;
  const accentKey = normalizeClientThemeAccent(settings?.themeAccent);
  const preset = THEME_ACCENT_PRESETS.find((p) => p.key === accentKey) || THEME_ACCENT_PRESETS[0];

  if (preset.key !== 'host' && preset.cssColor) {
    setOrClearStyleVar(targetEl, '--user-accent-primary', preset.cssColor);
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '#ffffff');
  } else {
    setOrClearStyleVar(targetEl, '--user-accent-primary', '');
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '');
  }
  targetEl.setAttribute?.('data-accent', preset.key);

  if (includeFontScale) {
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    const factor = FONT_SCALE_FACTORS[scaleKey] ?? 1;
    const panelFactor = PANEL_SCALE_FACTORS[scaleKey] ?? 1;
    setOrClearStyleVar(targetEl, '--ui-font-scale', factor === 1 ? '' : String(factor));
    setOrClearStyleVar(targetEl, '--ui-panel-scale', panelFactor === 1 ? '' : String(panelFactor));
    targetEl.setAttribute?.('data-font-scale', scaleKey);
  } else {
    setOrClearStyleVar(targetEl, '--ui-font-scale', '');
    setOrClearStyleVar(targetEl, '--ui-panel-scale', '');
    if (typeof targetEl.removeAttribute === 'function') {
      targetEl.removeAttribute('data-font-scale');
    }
  }
}
