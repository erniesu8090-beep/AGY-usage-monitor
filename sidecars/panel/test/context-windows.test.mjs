import assert from 'node:assert/strict';
import test from 'node:test';
import { backendHarness } from './backend-harness.mjs';

const argon = 'MODEL_PLACEHOLDER_M430';
const flash = 'MODEL_PLACEHOLDER_M431';
const other = 'MODEL_PLACEHOLDER_M432';
const carbon = 'MODEL_PLACEHOLDER_M427';
const carbonLow = 'MODEL_PLACEHOLDER_M438';
const newCarbonLow = 'MODEL_PLACEHOLDER_M439';
const carbonGroup = 'model:gemini-4-carbon';
const availableModels = {
  'gemini-4-carbon-high': { model: carbon, maxTokens: 1048576, maxOutputTokens: 262144 },
  'gemini-4-carbon-low': { model: carbonLow, maxTokens: 700000, maxOutputTokens: 64000 },
  'gemini-other': { model: other, maxTokens: 250000, maxOutputTokens: 64000 },
};
const carbonModels = [
  { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', modelOrAlias: { model: carbon } },
  { label: 'Gemini 4 Carbon (Low)', modelId: 'gemini-4-carbon-low', modelOrAlias: { model: carbonLow } },
];

test('saves and restores one model at a time using host presets or verified model capacity', async () => {
  const h = backendHarness({
    settings: { contextLimitOverrideTokens: 900000 },
    availableModels,
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Argon', modelOrAlias: { model: argon },
            contextWindowOptions: [{ name: '512K' }, { name: '900K', expensive: true }] },
          { label: 'Flash', modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
          { label: 'Other', modelOrAlias: { model: other } },
          ...carbonModels,
        ],
      },
    },
  });
  const update = h.executeModelContextWindowAction;
  const { contextWindowModels } = await h.buildTelemetryPayloadInternal('');
  const [argonModel, flashModel, otherModel, carbonModel] = JSON.parse(JSON.stringify(contextWindowModels));
  assert.deepEqual(argonModel.options, [{ name: '512K', expensive: false }, { name: '900K', expensive: true }]);
  assert.deepEqual(flashModel.options, [{ name: '256K', expensive: false }]);
  assert.deepEqual(otherModel.options.map(({ tokens }) => tokens), [128000, 186000]);
  assert.equal(carbonModel.id, carbonGroup);
  assert.equal(carbonModel.label, 'Gemini 4 Carbon');
  assert.deepEqual(carbonModel.members, [carbon, carbonLow]);
  assert.deepEqual(carbonModel.options.map(({ tokens }) => tokens), [128000, 256000, 384000, 512000, 636000]);
  assert.equal((await update({ modelId: carbonGroup, option: '768000' })).status, 400);
  h.state.settings.modelContextWindows = { [carbon]: '768000', [carbonLow]: '256000' };
  assert.equal((await update({ modelId: carbonGroup, option: '384000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '384000' });
  assert.equal((await update({ modelId: carbonGroup, option: '512000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '512000' });
  assert.equal((await update({ modelId: carbonGroup, option: null })).status, 200);
  assert.equal((await update({ modelId: flash, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: other, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: '__proto__', option: null })).status, 400);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});

  const [a, b] = await Promise.all([
    update({ modelId: argon, option: '900K' }),
    update({ modelId: flash, option: '256K' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [argon]: '900K', [flash]: '256K' });
  assert.equal((await update({ modelId: argon, option: null })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [flash]: '256K' });
  h.executeResetSettingsAction();
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});
});

test('reports the latest observed threshold separately from the saved group preference', async () => {
  const h = backendHarness({
    availableModels,
    settings: { modelContextWindows: { [carbonGroup]: '512000' } },
    userStatus: { cascadeModelConfigData: { clientModelConfigs: carbonModels } },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: {
      active: { trajectory: {
        steps: [{ metadata: {
          createdAt: '2026-01-01T00:00:00Z',
          finishedGeneratingAt: '2026-01-01T00:00:01Z',
          modelUsage: { model: carbonLow, inputTokens: 20, outputTokens: 20 },
        }, plannerResponse: { response: 'ok' } }],
        generatorMetadata: [{ stepIndices: [0], chatModel: {
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } },
        } }],
      } },
    },
  });
  const result = await h.buildTelemetryPayloadInternal('active');
  assert.equal(result.contextWindowModels.find(({ id }) => id === carbonGroup).reportedLimitTokens, 256000);
  assert.equal(result.settings.modelContextWindows[carbonGroup], '512000');
  const previouslyCached = h.state.saves.find(({ data }) => data.active?.contextLimitTelemetry).data.active;
  const cached = structuredClone(previouslyCached);
  delete cached.contextLimitTelemetry;
  delete cached.steps[0].reportedContextLimitTokens;
  const upgraded = backendHarness({
    availableModels,
    userStatus: h.state.userStatus,
    cache: { active: cached },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: h.state.trajectories,
  });
  const reloaded = await upgraded.buildTelemetryPayloadInternal('active');
  assert.equal(reloaded.contextWindowModels[0].reportedLimitTokens, 256000);
});
