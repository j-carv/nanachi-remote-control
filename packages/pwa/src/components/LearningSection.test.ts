import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LearningSettingsSchema, type LearningSettingsResponse } from '@nanachi/shared';
import { LearningSettingsForm } from './LearningSection.js';

function render(settings: LearningSettingsResponse) {
  return renderToStaticMarkup(createElement(LearningSettingsForm, {
    settings, agents: [{ id: 'fake', label: 'Test agent', kind: 'acp' }],
    catalog: { models: [
      { id: 'a', label: 'Model A', provider: 'Provider A', source: 'agent', agentId: 'fake' },
      { id: 'b', label: 'Model B', provider: 'Provider B', source: 'agent', agentId: 'fake' },
      { id: 'c', label: 'Other agent model', provider: 'Provider C', source: 'agent', agentId: 'other' },
    ], errors: [{ source: 'fake', message: 'Catalog temporarily unavailable' }] },
    modelsLoading: false, modelsFailed: false, onRefresh: () => undefined, onSave: async () => settings,
  }));
}

describe('learning settings consumer', () => {
  it('starts disabled with the same conversation model and exposes every supported source', () => {
    const html = render({ ...LearningSettingsSchema.parse({}), apiKeyConfigured: false });
    expect(html).toMatch(/value="same" selected/);
    for (const source of ['agent', 'openrouter', 'openai', 'ollama']) expect(html).toContain(`value="${source}"`);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).not.toContain('data-slot="learning-api-key"');
    expect(html).not.toContain('data-slot="learning-model-id"');
  });

  it('groups configured agent models by provider without leaking another agent catalog', () => {
    const html = render({ ...LearningSettingsSchema.parse({ reviewer: { source: 'agent', agentId: 'fake', model: 'a' } }), apiKeyConfigured: false });
    expect(html).toContain('<optgroup label="Provider A">');
    expect(html).toContain('<optgroup label="Provider B">');
    expect(html).not.toContain('Other agent model');
    expect(html).toContain('Catalog temporarily unavailable');
    expect(html).not.toContain('data-slot="learning-model-id"');
  });

  it('shows a write-only password and manual model ID only for compatible endpoint sources', () => {
    for (const source of ['openrouter', 'openai', 'ollama'] as const) {
      const html = render({ ...LearningSettingsSchema.parse({ reviewer: { source, baseUrl: 'http://127.0.0.1:11434' } }), apiKeyConfigured: true });
      expect(html).toMatch(/<input(?=[^>]*data-slot="learning-api-key")(?=[^>]*type="password")/);
      expect(html).toMatch(/autocomplete="new-password"/i);
      expect(html).toContain('data-slot="learning-model-id"');
      expect(html).not.toMatch(/data-slot="learning-api-key"[^>]*value="[^"]+"/);
    }
  });
});
