import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptionSettingsSchema, type TranscriptionSettingsResponse } from '@nanachi/shared';
import { setLanguage } from '../i18n/index.js';
import { TranscriptionSettingsForm, type TranscriptionSettingsFormProps } from './TranscriptionSettings.js';

const defaults: TranscriptionSettingsResponse = { ...TranscriptionSettingsSchema.parse({}), apiKeyConfigured: false };
function render(settings = defaults, extra: Partial<TranscriptionSettingsFormProps> = {}) {
  return renderToStaticMarkup(createElement(TranscriptionSettingsForm, {
    settings, catalog: null, modelsLoading: false, modelsFailed: false,
    onRefresh: () => undefined, onSave: async () => settings, ...extra,
  }));
}

afterEach(() => setLanguage('pt-BR'));

describe('voice dictation settings', () => {
  it('keeps the exact offline Whisper model as the default without exposing remote credentials', () => {
    setLanguage('en');
    const html = render();
    expect(html).toMatch(/value="whisper" selected/);
    expect(html).toContain('ggml-base-q5_1.bin');
    expect(html).toContain('transcribes offline on this PC');
    expect(html).toContain('never sent automatically');
    expect(html).toContain('60 seconds');
    for (const provider of ['openai', 'groq', 'custom']) expect(html).toContain(`value="${provider}"`);
    expect(html).not.toContain('data-slot="transcription-api-key"');
    expect(html).not.toContain('data-slot="transcription-refresh-models"');
    expect(html).toMatch(/data-slot="transcription-save"[^>]*disabled/);
  });

  it('shows verified cloud catalogs and identifies deprecated OpenAI choices', () => {
    setLanguage('en');
    const html = render({ ...defaults, provider: 'openai', model: 'gpt-transcribe', apiKeyConfigured: true }, {
      catalog: { models: [
        { provider: 'openai', id: 'gpt-transcribe', name: 'GPT Transcribe' },
        { provider: 'openai', id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe', deprecated: true },
        { provider: 'groq', id: 'whisper-large-v3', name: 'Other provider model' },
      ], manual: false },
    });
    expect(html).toContain('value="gpt-transcribe" selected');
    expect(html).toContain('GPT-4o Transcribe · Deprecated');
    expect(html).not.toContain('Other provider model');
    expect(html).toContain('Cloud providers receive your audio and may charge');
    expect(html).toContain('Native Whisper installation is not required');
    expect(html).toContain('does not verify the API key');
    expect(html).not.toContain('data-slot="transcription-base-url"');
    expect(html).not.toContain('data-slot="transcription-model-id"');
  });

  it('uses an empty write-only password for saved keys and allows an optional custom key', () => {
    for (const provider of ['openai', 'groq', 'custom'] as const) {
      const html = render({ ...defaults, provider, model: 'speech-model', apiKeyConfigured: true });
      expect(html).toMatch(/<input(?=[^>]*data-slot="transcription-api-key")(?=[^>]*type="password")/);
      expect(html).not.toMatch(/data-slot="transcription-api-key"[^>]*value="[^"]+"/);
      expect(html).toMatch(/autocomplete="new-password"/i);
    }
    const html = render({ ...defaults, provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', model: 'parakeet' });
    const key = html.match(/<input[^>]*data-slot="transcription-api-key"[^>]*>/)?.[0];
    expect(key).toBeDefined();
    expect(key).not.toContain('required');
    expect(html).toContain('data-slot="transcription-model-id"');
    expect(html).toContain('pattern="\\S+"');
  });

  it('keeps manual IDs usable when the custom catalog is empty or fails', () => {
    setLanguage('en');
    const settings: TranscriptionSettingsResponse = { ...defaults, provider: 'custom', model: 'qwen-asr', baseUrl: 'https://speech.example/v1' };
    const html = render(settings, { catalog: { models: [], manual: true }, modelsFailed: true });
    expect(html).toContain('value="qwen-asr"');
    expect(html).toContain('data-slot="transcription-model-id"');
    expect(html).toContain('Could not discover models');
    expect(html).toContain('No models were listed');
    expect(html).toContain('POST /audio/transcriptions');
    expect(html).toContain('Ordinary LLM or Ollama chat endpoints cannot transcribe audio');
    expect(html).toContain('max="180000"');
    expect(html).toContain('min="5000"');
    expect(html).not.toContain('data-slot="whisper-install-progress"');
  });

  it('announces catalog loading and disables duplicate discovery', () => {
    const html = render({ ...defaults, provider: 'groq', model: 'whisper-large-v3-turbo' }, { modelsLoading: true });
    expect(html).toMatch(/<button(?=[^>]*data-slot="transcription-refresh-models")(?=[^>]*disabled)(?=[^>]*aria-busy="true")/);
  });
});

it('can save a custom connection before choosing a model from its catalog', () => {
  const html = render({ ...defaults, provider: 'custom', baseUrl: 'http://localhost:8000/v1', model: '' });
  expect(html.match(/<input[^>]*data-slot="transcription-model-id"[^>]*>/)?.[0]).not.toContain('required');
  expect(html.match(/<select[^>]*data-slot="transcription-model"[^>]*>/)?.[0]).not.toContain('required');
});
