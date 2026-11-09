import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningSettingsSchema, type LearningSettings } from '@nanachi/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningSettingsStore } from '../src/learning-settings.js';
import { HttpLearningProvider } from '../src/learning-providers.js';
import { LearningError } from '../src/learning-errors.js';
import { removeTempDir } from './temp.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function endpoint(handler: (request: IncomingMessage, reply: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Synthetic listener missing');
  return `http://127.0.0.1:${address.port}`;
}

async function provider(source: 'openai' | 'openrouter' | 'ollama', baseUrl: string, key?: string) {
  const home = await mkdtemp(join(tmpdir(), 'nanachi-learning-http-'));
  cleanup.push(() => removeTempDir(home));
  const store = new LearningSettingsStore(home);
  const settings: LearningSettings = LearningSettingsSchema.parse({ enabled: true, reviewer: { source, model: 'synthetic-model', baseUrl } });
  store.update({ ...settings, ...(key === undefined ? {} : { apiKey: key }) });
  const { apiKeyConfigured: _apiKeyConfigured, ...normalized } = store.get();
  return { http: new HttpLearningProvider(store), store, settings: normalized };
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text);
}

const output = JSON.stringify({ summary: 'Synthetic review', entries: [] });

describe('HttpLearningProvider', () => {
  it('uses actual compatible model and completion endpoints with strict data-only requests', async () => {
    const requests: Array<{ path: string | undefined; method: string | undefined; authorization: string | undefined; body?: unknown }> = [];
    const base = await endpoint((request, reply) => {
      void (async () => {
        const row = { path: request.url, method: request.method, authorization: request.headers.authorization };
        if (request.method === 'POST') {
          requests.push({ ...row, body: await body(request) });
          reply.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: output } }] }));
        } else {
          requests.push(row);
          reply.end(JSON.stringify({ data: [{ id: 'exact/vendor:model', name: 'Synthetic model' }] }));
        }
      })();
    });
    const { http, settings } = await provider('openai', `${base}/v1`, 'synthetic-key');
    expect(await http.models(new AbortController().signal)).toEqual([{ id: 'exact/vendor:model', label: 'Synthetic model', provider: 'OpenAI-compatible', source: 'openai' }]);
    expect(await http.review('synthetic prompt', settings, new AbortController().signal)).toBe(output);
    expect(requests.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/v1/models', method: 'GET' }, { path: '/v1/chat/completions', method: 'POST' }]);
    expect(requests.every((row) => row.authorization === 'Bearer synthetic-key')).toBe(true);
    expect(requests[1]?.body).toMatchObject({
      model: 'synthetic-model', stream: false, max_tokens: settings.maxOutputTokens,
      messages: [{ role: 'user', content: 'synthetic prompt' }], tools: [], tool_choice: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'learning_review', strict: true, schema: { type: 'object', additionalProperties: false } } },
    });
  });

  it('uses native Ollama tags/chat, JSON schema format, and bounded prediction options', async () => {
    const paths: string[] = [];
    let requestBody: unknown;
    const base = await endpoint((request, reply) => {
      paths.push(request.url ?? '');
      void (async () => {
        if (request.method === 'POST') {
          requestBody = await body(request);
          reply.end(JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant', content: output } }));
        } else reply.end(JSON.stringify({ models: [{ name: 'synthetic:latest', model: 'synthetic:latest' }] }));
      })();
    });
    const { http, settings } = await provider('ollama', base);
    expect(await http.models(new AbortController().signal)).toEqual([{ id: 'synthetic:latest', label: 'synthetic:latest', provider: 'Ollama', source: 'ollama' }]);
    expect(await http.review('synthetic prompt', settings, new AbortController().signal)).toBe(output);
    expect(paths).toEqual(['/api/tags', '/api/chat']);
    expect(requestBody).toMatchObject({ model: 'synthetic-model', stream: false, tools: [], messages: [{ role: 'user', content: 'synthetic prompt' }], options: { num_predict: settings.maxOutputTokens }, format: { type: 'object', additionalProperties: false } });
  });

  it('uses fixed OpenRouter URLs and refuses missing credentials before any request', async () => {
    const { http, store, settings } = await provider('openrouter', '', 'synthetic-key');
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'vendor/exact' }] } : { choices: [{ message: { content: output }, finish_reason: 'stop' }] }));
    }));
    expect((await http.models(new AbortController().signal))[0]?.id).toBe('vendor/exact');
    expect(await http.review('synthetic', settings, new AbortController().signal)).toBe(output);
    expect(requests.map(({ url }) => url)).toEqual(['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/chat/completions']);
    expect(requests.every(({ init }) => init?.redirect === 'error' && new Headers(init.headers).get('authorization') === 'Bearer synthetic-key')).toBe(true);
    store.update({ ...LearningSettingsSchema.parse(settings), removeApiKey: true });
    await expect(http.review('synthetic', settings, new AbortController().signal)).rejects.toThrow('OpenRouter requires an API key.');
    expect(requests).toHaveLength(2);
  });

  it('rejects redirects without sending credentials to their destination', async () => {
    let leakedRequests = 0;
    const destination = await endpoint((_request, reply) => { leakedRequests += 1; reply.end('{}'); });
    const source = await endpoint((_request, reply) => { reply.writeHead(307, { location: `${destination}/models` }).end('synthetic-secret'); });
    const { http } = await provider('openai', source, 'synthetic-key');
    await expect(http.models(new AbortController().signal)).rejects.toBeInstanceOf(LearningError);
    expect(leakedRequests).toBe(0);
  });

  it('reports unsupported compatible listing without inventing the manual model', async () => {
    const base = await endpoint((_request, reply) => { reply.writeHead(404).end('synthetic-secret'); });
    const { http } = await provider('openai', base);
    await expect(http.models(new AbortController().signal)).rejects.toThrow('Model listing is unsupported. Enter an exact model ID manually.');
  });

  it('sanitizes provider failures and refuses credential use after endpoint changes', async () => {
    let count = 0;
    const base = await endpoint((_request, reply) => { count += 1; reply.writeHead(401).end('synthetic-secret transcript'); });
    const { http, store, settings } = await provider('openai', base, 'synthetic-key');
    await expect(http.review('synthetic prompt', settings, new AbortController().signal)).rejects.toThrow('Learning provider rejected the request. Check the model, credentials, and structured output support.');
    store.update({ ...LearningSettingsSchema.parse(settings), reviewer: { ...settings.reviewer, baseUrl: 'https://changed.example.com/v1' } });
    await expect(http.review('synthetic prompt', settings, new AbortController().signal)).rejects.toThrow('Learning reviewer settings changed.');
    expect(count).toBe(1);
  });

  it('never forwards an omitted old key after switching the configured destination', async () => {
    let authorization: string | undefined;
    const destination = await endpoint((request, reply) => {
      authorization = request.headers.authorization;
      reply.end(JSON.stringify({ data: [{ id: 'local/exact-model' }] }));
    });
    const { http, store, settings } = await provider('openrouter', '', 'synthetic-openrouter-key');
    const updated = store.update({ ...settings, reviewer: { ...settings.reviewer, source: 'openai', baseUrl: destination } });
    expect(updated.apiKeyConfigured).toBe(false);
    expect((await http.models(new AbortController().signal))[0]?.id).toBe('local/exact-model');
    expect(authorization).toBeUndefined();
  });

  it('cancels hanging response bodies through the supplied AbortSignal', async () => {
    let started: () => void = () => { throw new Error('Synthetic response not ready'); };
    const received = new Promise<void>((resolve) => { started = resolve; });
    const base = await endpoint((_request, reply) => { reply.writeHead(200); reply.write('{'); started(); });
    const { http } = await provider('openai', base);
    const controller = new AbortController();
    const pending = http.models(controller.signal);
    const rejection = expect(pending).rejects.toThrow('Learning provider request was canceled or timed out.');
    await received;
    controller.abort(new Error('synthetic-secret'));
    await rejection;
  });

  it('time-bounds reviews even when the caller has not canceled', async () => {
    let started: () => void = () => { throw new Error('Synthetic response not ready'); };
    const received = new Promise<void>((resolve) => { started = resolve; });
    const base = await endpoint((_request, reply) => { reply.writeHead(200); reply.write('{'); started(); });
    const { http, settings } = await provider('openai', base);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const pending = http.review('synthetic prompt', settings, new AbortController().signal);
    const rejection = expect(pending).rejects.toThrow('Learning provider request was canceled or timed out.');
    await received;
    expect(timeout).toHaveBeenCalledWith(settings.timeoutMs);
    deadline.abort(new Error('synthetic-secret timeout'));
    await rejection;
  });

  it('never retries without structured output when Ollama rejects the requested schema', async () => {
    let requests = 0;
    const base = await endpoint((_request, reply) => { requests += 1; reply.writeHead(400).end('synthetic-secret unsupported schema'); });
    const { http, settings } = await provider('ollama', base);
    await expect(http.review('synthetic prompt', settings, new AbortController().signal)).rejects.toThrow('Learning provider rejected the request. Check the model, credentials, and structured output support.');
    expect(requests).toBe(1);
  });

  it('sanitizes malformed JSON and never returns invalid advertised model rows', async () => {
    let requests = 0;
    const base = await endpoint((_request, reply) => {
      requests += 1;
      reply.end(requests === 1 ? '{synthetic-secret' : JSON.stringify({ data: [{ id: `synthetic${String.fromCharCode(10)}secret` }] }));
    });
    const { http } = await provider('openai', base);
    await expect(http.models(new AbortController().signal)).rejects.toThrow('Learning provider returned invalid JSON.');
    await expect(http.models(new AbortController().signal)).rejects.toThrow('Learning model catalog has an invalid format.');
  });

  it.each(['synthetic model', ' model', `synthetic${String.fromCharCode(9)}model`])('rejects whitespace in catalog model ID %j', async (id) => {
    const base = await endpoint((_request, reply) => reply.end(JSON.stringify({ data: [{ id }] })));
    const { http } = await provider('openai', base);
    await expect(http.models(new AbortController().signal)).rejects.toThrow('Learning model catalog has an invalid format.');
  });

  it('preserves a literal backslash escape in an advertised model ID rather than treating it as a control character', async () => {
    const id = `synthetic${String.fromCharCode(92)}nmodel`;
    const base = await endpoint((_request, reply) => reply.end(JSON.stringify({ data: [{ id }] })));
    const { http } = await provider('openai', base);
    expect((await http.models(new AbortController().signal))[0]?.id).toBe(id);
  });

  it('bounds streamed HTTP bytes even without Content-Length', async () => {
    const base = await endpoint((_request, reply) => { reply.writeHead(200); reply.write(' '.repeat(1024 * 1024)); reply.end(' '.repeat(1024 * 1024)); });
    const { http } = await provider('openai', base);
    await expect(http.models(new AbortController().signal)).rejects.toThrow('Learning provider response exceeded the byte limit.');
  });

  it('bounds model rows and reviewer output independently', async () => {
    const base = await endpoint((request, reply) => {
      reply.end(JSON.stringify(request.method === 'GET'
        ? { data: Array.from({ length: 2001 }, (_, i) => ({ id: `model-${i}` })) }
        : { choices: [{ message: { content: 'x'.repeat(65537) } }] }));
    });
    const { http, settings } = await provider('openai', base);
    await expect(http.models(new AbortController().signal)).rejects.toThrow('Learning model catalog exceeded the row limit.');
    await expect(http.review('synthetic', settings, new AbortController().signal)).rejects.toThrow('Learning reviewer output exceeded the character limit.');
  });

  it('rejects tool calls, incomplete output, and disabled paid reviews', async () => {
    let count = 0;
    const base = await endpoint((_request, reply) => { count += 1; reply.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: output, tool_calls: [{ id: 'not-allowed' }] } }] })); });
    const { http, settings } = await provider('openai', base);
    await expect(http.review('synthetic', settings, new AbortController().signal)).rejects.toThrow(LearningError);
    await expect(http.review('synthetic', { ...settings, enabled: false }, new AbortController().signal)).rejects.toThrow('Automatic learning is disabled.');
    expect(count).toBe(1);
  });
});
