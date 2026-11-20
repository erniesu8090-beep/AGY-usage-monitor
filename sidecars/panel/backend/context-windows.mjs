/** @fileoverview 宿主上报的模型上下文档位与逐次请求配置。 */

export function isContextWindowModelId(value) {
  return typeof value === 'string' && /^MODEL_[A-Z0-9_]{1,120}$/.test(value) &&
    value !== 'MODEL_UNSPECIFIED' && value !== 'MODEL_UNKNOWN';
}

export function isContextWindowSettingId(value) {
  return isContextWindowModelId(value) || (typeof value === 'string' && /^model:[a-z0-9][a-z0-9._-]{0,119}$/.test(value));
}

export function isContextWindowOption(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 &&
    value.trim() === value && value.toLowerCase() !== 'default' && !/[\x00-\x1f\x7f]/.test(value);
}

export function getContextWindowModels(clientConfigs, catalog) {
  const capacities = new Map();
  const upstreamIds = new Map();
  const thinkingLevels = new Set();
  for (const [key, info] of Object.entries(catalog || {})) {
    const { model, maxTokens, maxOutputTokens } = info || {};
    if (isContextWindowModelId(model)) upstreamIds.set(model, upstreamIds.has(model) ? '' : key);
    if (Number.isInteger(info?.thinkingLevel) && info.thinkingLevel > 0) thinkingLevels.add(model);
    if (!Number.isSafeInteger(maxTokens) || !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens <= 0 || maxTokens <= maxOutputTokens) continue;
    // 宿主校验压缩阈值时会从模型总窗口中扣除输出预算。
    const capacity = maxTokens - maxOutputTokens;
    capacities.set(model, Math.min(capacity, capacities.get(model) ?? capacity));
  }
  const models = new Map();
  for (const config of Array.isArray(clientConfigs) ? clientConfigs : []) {
    const id = config?.modelOrAlias?.model;
    if (!isContextWindowModelId(id) || config.disabled || models.has(id)) continue;
    const options = Array.isArray(config.contextWindowOptions) ? config.contextWindowOptions : [];
    const byName = new Map();
    for (const option of options) {
      if (!isContextWindowOption(option?.name) || byName.has(option.name)) continue;
      byName.set(option.name, {
        name: option.name,
        expensive: option.expensive === true,
      });
    }
    const reportedId = typeof config.modelId === 'string' ? config.modelId.trim() : '';
    const upstreamId = (reportedId && reportedId !== id ? reportedId : upstreamIds.get(id) || '').toLowerCase();
    const label = config.label || id;
    const effort = upstreamId.match(/-(low|medium|high|xhigh|extra-high|extra|max)$/);
    const labelEffort = typeof label === 'string' && label.match(/\s+\((low|medium|high|xhigh|extra[ -]high|extra|max)\)$/i);
    const isEffortVariant = effort && (thinkingLevels.has(id) ||
      labelEffort && effort[1].replace('-', '') === labelEffort[1].toLowerCase().replace(/[ -]/g, ''));
    const baseId = isEffortVariant ? upstreamId.slice(0, effort.index) : upstreamId;
    const groupId = `model:${baseId}`;
    models.set(id, {
      id,
      groupId: isContextWindowSettingId(groupId) ? groupId : id,
      label: isEffortVariant ? (labelEffort ? label.slice(0, labelEffort.index) : baseId) : label,
      capacity: capacities.get(id) || 0,
      options: [...byName.values()],
    });
  }
  return [...models.values()];
}

export function getContextWindowGroups(models) {
  const byId = new Map();
  for (const model of models) {
    const group = byId.get(model.groupId);
    if (group) group.members.push(model);
    else byId.set(model.groupId, { id: model.groupId, label: model.label, members: [model] });
  }
  return [...byId.values()].map(({ id, label, members }) => {
    const options = members[0].options.filter(({ name }) =>
      members.every((member) => member.options.some((option) => option.name === name))
    ).map(({ name }) => ({
      name,
      expensive: members.some(({ options }) => options.some((option) => option.name === name && option.expensive)),
    }));
    const capacity = Math.min(...members.map((member) => member.capacity));
    if (!options.length && capacity) {
      for (const tokens of new Set([128000, 256000, 384000, 512000, 768000, 900000, capacity])) {
        if (tokens <= capacity && !options.some(({ name }) => name === String(tokens))) {
          options.push({ name: String(tokens), tokens });
        }
      }
    }
    return { id, label, members: members.map((member) => member.id), capacity, options };
  });
}

export function resolveContextWindowOption(model, value) {
  if (!value) return null;
  if (model.options.some(({ name, tokens }) => name === value && !tokens)) return value;
  const tokens = Number(value);
  return Number.isSafeInteger(tokens) && String(tokens) === value && tokens > 0 && tokens <= model.capacity ? tokens : null;
}

export function resolveContextWindowRules(models, preferences) {
  const byId = new Map(models.map((model) => [model.id, model]));
  const rules = {};
  for (const group of getContextWindowGroups(models)) {
    const saved = preferences[group.id];
    // 不同推理档的旧设置有冲突时，保留各自的值，直到用户选定统一上限。
    const previous = new Set(group.members.map((id) => preferences[id]).filter(Boolean));
    const shared = saved || (previous.size === 1 ? previous.values().next().value : null);
    if (resolveContextWindowOption(group, shared) !== null) {
      for (const id of group.members) rules[id] = resolveContextWindowOption(byId.get(id), shared);
    } else if (!saved) {
      for (const id of group.members) {
        const option = resolveContextWindowOption(byId.get(id), preferences[id]);
        if (option !== null) rules[id] = option;
      }
    }
  }
  return rules;
}
