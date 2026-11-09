import { LearningReviewResultSchema, type LearningModel, type LearningSettings } from '@nanachi/shared';
import { LearningError } from './learning-errors.js';
import type { LearningSettingsStore } from './learning-settings.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 65536;
const MAX_MODEL_ROWS = 2000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Derive transport validation from the shared schema, with strict create/update alternatives. */
function reviewJsonSchema(): Record<string, unknown> {
  const schema: unknown = LearningReviewResultSchema.toJSONSchema({
    override: ({ jsonSchema }) => { delete jsonSchema.default; },
  });
  if (!record(schema) || !record(schema.properties) || !record(schema.properties.entries)
    || !record(schema.properties.entries.items) || !record(schema.properties.entries.items.properties)) {
    throw new LearningError('Learning structured output schema is unavailable.');
  }
  const item = schema.properties.entries.items;
  const properties = schema.properties.entries.items.properties;
  const { id: _id, expectedVersion: _expectedVersion, ...createProperties } = properties;
  const { $schema: _dialect, ...root } = schema;
  return {
    ...root,
    required: Object.keys(schema.properties),
    properties: {
      ...schema.properties,
      entries: {
        ...schema.properties.entries,
        items: {
          anyOf: [
            { ...item, properties: createProperties, required: Object.keys(createProperties) },
            { ...item, properties, required: Object.keys(properties) },
          ],
        },
      },
    },
  };
}

const REVIEW_JSON_SCHEMA = reviewJsonSchema();

/** Direct, nonstreaming, tool-free reviewer requests; never follows provider redirects. */
export class HttpLearningProvider {
  constructor(private readonly settings: LearningSettingsStore) {}

  async models(signal: AbortSignal): Promise<LearningModel[]> {
    const settings = this.settings.get();
    const source = settings.reviewer.source;
    if (source !== 'openrouter' && source !== 'openai' && source !== 'ollama') return [];
    const payload = await this.request(settings, source === 'ollama' ? '/api/tags' : '/models', signal);
    const rows = record(payload) ? payload[source === 'ollama' ? 'models' : 'data'] : undefined;
    if (!Array.isArray(rows)) throw new LearningError('Learning model catalog has an invalid format.');
    if (rows.length > MAX_MODEL_ROWS) throw new LearningError('Learning model catalog exceeded the row limit.');
    const models: LearningModel[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const id: unknown = record(row) ? source === 'ollama' ? row.model ?? row.name : row.id : undefined;
      const label: unknown = record(row) && typeof row.name === 'string' ? row.name : id;
      if (typeof id !== 'string' || id.length === 0 || id.length > 500 || /[\s\u0000-\u001f\u007f]/u.test(id)
        || typeof label !== 'string' || label.trim() === '' || label.length > 500 || /[\u0000-\u001f\u007f]/u.test(label)) {
        throw new LearningError('Learning model catalog has an invalid format.');
      }
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label, provider: source === 'ollama' ? 'Ollama' : source === 'openrouter' ? 'OpenRouter' : 'OpenAI-compatible', source });
    }
    return models;
  }

  async review(prompt: string, settings: LearningSettings, signal: AbortSignal): Promise<string> {
    if (!settings.enabled || !this.settings.get().enabled) throw new LearningError('Automatic learning is disabled.');
    if (settings.reviewer.model.trim() === '') throw new LearningError('Select an exact learning reviewer model ID first.');
    if (prompt.length > settings.maxInputChars) throw new LearningError('Learning reviewer input exceeded the character limit.');
    const source = settings.reviewer.source;
    if (source !== 'openrouter' && source !== 'openai' && source !== 'ollama') throw new LearningError('The selected reviewer is not an HTTP provider.');
    const native = source === 'ollama';
    const messages = [{ role: 'user', content: prompt }];
    const payload = await this.request(settings, native ? '/api/chat' : '/chat/completions', signal, native ? {
      model: settings.reviewer.model, messages, stream: false, tools: [],
      format: REVIEW_JSON_SCHEMA, options: { num_predict: settings.maxOutputTokens },
    } : {
      model: settings.reviewer.model, messages, stream: false,
      max_tokens: settings.maxOutputTokens, tools: [], tool_choice: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'learning_review', strict: true, schema: REVIEW_JSON_SCHEMA } },
    });
    let message: unknown;
    if (native) {
      if (!record(payload) || payload.done !== true || (payload.done_reason !== undefined && payload.done_reason !== 'stop')) {
        throw new LearningError('Learning provider returned incomplete reviewer output.');
      }
      message = payload.message;
    } else {
      const choice: unknown = record(payload) && Array.isArray(payload.choices) && payload.choices.length === 1 ? payload.choices[0] : undefined;
      if (!record(choice) || (choice.finish_reason !== undefined && choice.finish_reason !== 'stop')) {
        throw new LearningError('Learning provider returned incomplete reviewer output.');
      }
      message = choice.message;
    }
    if (!record(message) || typeof message.content !== 'string' || message.content.trim() === ''
      || (message.tool_calls !== undefined && message.tool_calls !== null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))
      || (message.function_call !== undefined && message.function_call !== null) || (message.refusal !== undefined && message.refusal !== null)) {
      throw new LearningError('Learning provider returned invalid or tool-enabled reviewer output.');
    }
    if (message.content.length > MAX_OUTPUT_CHARS) throw new LearningError('Learning reviewer output exceeded the character limit.');
    return message.content;
  }

  private async request(settings: LearningSettings, path: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<unknown> {
    const source = settings.reviewer.source;
    if (source !== 'openrouter' && source !== 'openai' && source !== 'ollama') throw new LearningError('The selected reviewer is not an HTTP provider.');
    const current = this.settings.get();
    // Never send a newly configured credential to an old request's former origin.
    if (current.reviewer.source !== source || current.reviewer.baseUrl !== settings.reviewer.baseUrl) {
      throw new LearningError('Learning reviewer settings changed.');
    }
    const key = this.settings.apiKey();
    if (source === 'openrouter' && key === undefined) throw new LearningError('OpenRouter requires an API key.');
    const base = source === 'openrouter' ? 'https://openrouter.ai/api/v1' : settings.reviewer.baseUrl;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? Math.min(settings.timeoutMs, 30000) : settings.timeoutMs)]);
    let response: Response | undefined;
    try {
      combined.throwIfAborted();
      response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new LearningError('Learning provider redirects are not allowed.');
      if (!response.ok) {
        if (body === undefined && source === 'openai' && [404, 405, 501].includes(response.status)) {
          throw new LearningError('Model listing is unsupported. Enter an exact model ID manually.');
        }
        throw new LearningError('Learning provider rejected the request. Check the model, credentials, and structured output support.');
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new LearningError('Learning provider response exceeded the byte limit.');
      if (response.body === null) throw new LearningError('Learning provider returned an empty response.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let text = '';
      try {
        for (;;) {
          combined.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new LearningError('Learning provider response exceeded the byte limit.');
          text += decoder.decode(chunk.value, { stream: true });
        }
        combined.throwIfAborted();
        text += decoder.decode();
      } finally {
        try { await reader.cancel(); } catch { /* Provider errors and abort reasons are private. */ }
        reader.releaseLock();
      }
      try { return JSON.parse(text); }
      catch { throw new LearningError('Learning provider returned invalid JSON.'); }
    } catch (error) {
      if (combined.aborted) throw new LearningError('Learning provider request was canceled or timed out.');
      if (error instanceof LearningError) throw error;
      throw new LearningError('Learning provider connection failed. Check the endpoint and connection; redirects are not allowed.');
    } finally {
      try { await response?.body?.cancel(); } catch { /* Never leak a transport exception. */ }
    }
  }
}
