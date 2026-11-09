import { describe, expect, it, vi } from 'vitest';
import { toControlError } from '../src/main/control-errors.js';
import {
  createDaemonApi,
  createTokenAccess,
  DaemonApiError,
  type DaemonApiDeps,
} from '../src/main/daemon-api.js';
import { PairingError } from '../src/main/pairing.js';
import { RootsConfigError } from '../src/main/roots-config.js';
import type { SeedMachine } from '../src/common/types.js';

const BASE = 'http://127.0.0.1:7780';
const TOKEN = 'secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  hasSignal: boolean;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(handler: Handler, overrides: Partial<DaemonApiDeps> = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
      hasSignal: init?.signal instanceof AbortSignal,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as unknown as typeof fetch;
  const token = vi.fn(() => Promise.resolve(TOKEN));
  const refreshToken = vi.fn(() => Promise.resolve(TOKEN));
  const api = createDaemonApi({ baseUrl: () => BASE, token, refreshToken, fetchImpl, ...overrides });
  return { api, calls, token, refreshToken };
}

async function failure(promise: Promise<unknown>): Promise<DaemonApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DaemonApiError);
    return error as DaemonApiError;
  }
  throw new Error('esperava uma falha');
}

describe('daemon api: requests', () => {
  it('reads and changes the same Whisper installation with the Desktop token', async () => {
    const { api, calls } = setup(({ method }) => json(method === 'POST'
      ? { state: 'installing', progress: 15 }
      : { state: method === 'DELETE' ? 'removing' : 'ready' }));
    await expect(api.whisper('status')).resolves.toEqual({ state: 'ready' });
    await expect(api.whisper('install')).resolves.toEqual({ state: 'installing', progress: 15 });
    await expect(api.whisper('remove')).resolves.toEqual({ state: 'removing' });
    expect(calls.map(({ url, method }) => [method, url])).toEqual([
      ['GET', `${BASE}/api/whisper`],
      ['POST', `${BASE}/api/whisper/install`],
      ['DELETE', `${BASE}/api/whisper`],
    ]);
    expect(calls.every(({ headers }) => headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
  it('reads and saves transcription through canonical authenticated endpoints without returning a key', async () => {
    const settings = { provider: 'openai' as const, model: 'gpt-transcribe', baseUrl: '', timeoutMs: 90_000, apiKeyConfigured: true };
    const { api, calls } = setup(({ url }) => json(url.endsWith('/status')
      ? { provider: settings.provider, model: settings.model, state: 'ready' }
      : url.endsWith('/models') ? { models: [{ provider: 'openai', id: 'gpt-transcribe', name: 'GPT Transcribe' }], manual: false } : settings));
    expect(await api.transcriptionSettings()).toEqual(settings);
    expect(await api.setTranscriptionSettings({ provider: settings.provider, model: settings.model, baseUrl: '', timeoutMs: 90_000, apiKey: 'write-only' })).toEqual(settings);
    expect(await api.transcriptionStatus()).toEqual({ provider: 'openai', model: 'gpt-transcribe', state: 'ready' });
    expect(await api.transcriptionModels()).toMatchObject({ manual: false, models: [{ id: 'gpt-transcribe' }] });
    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['GET', `${BASE}/api/transcription/settings`], ['PUT', `${BASE}/api/transcription/settings`],
      ['GET', `${BASE}/api/transcription/status`], ['GET', `${BASE}/api/transcription/models`],
    ]);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ provider: 'openai', model: 'gpt-transcribe', baseUrl: '', timeoutMs: 90_000, apiKey: 'write-only' });
    expect(calls.every(({ headers, hasSignal }) => headers.authorization === `Bearer ${TOKEN}` && hasSignal)).toBe(true);
  });

  it.each([
    { provider: 'openai', model: 'gpt-transcribe', baseUrl: '', timeoutMs: 90_000, apiKeyConfigured: true, apiKey: 'must-not-cross' },
    { provider: 'unknown', model: 'x', baseUrl: '', timeoutMs: 90_000, apiKeyConfigured: true },
    { provider: 'whisper', model: 'x', baseUrl: '', timeoutMs: 1, apiKeyConfigured: false },
  ])('refuses malformed or secret-bearing transcription settings responses', async (body) => {
    const { api } = setup(() => json(body));
    expect((await failure(api.transcriptionSettings())).kind).toBe('bad_response');
  });

  it('validates transcription status and model catalogs instead of forwarding unknown data', async () => {
    const { api } = setup(() => json({ provider: 'custom', model: 'x', state: 'invented', models: [{ id: 'chat model', name: 'x', provider: 'custom' }], manual: true }));
    expect((await failure(api.transcriptionStatus())).kind).toBe('bad_response');
    expect((await failure(api.transcriptionModels())).kind).toBe('bad_response');
  });
  it('lists devices with the Desktop token, marking the one that made the call', async () => {
    const { api, calls } = setup(() =>
      json({
        devices: [
          { id: 'd1', name: 'Nanachi Desktop (PC)', createdAt: 100, lastSeenAt: 200, current: true },
          { id: 'd2', name: 'iPhone', createdAt: 50, lastSeenAt: null, current: false },
        ],
      }),
    );
    expect(await api.devices()).toEqual([
      { id: 'd1', name: 'Nanachi Desktop (PC)', createdAt: 100, lastSeenAt: 200, revoked: false, isThisApp: true },
      { id: 'd2', name: 'iPhone', createdAt: 50, lastSeenAt: null, revoked: false, isThisApp: false },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/devices`, method: 'GET', hasSignal: true });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reads the base address on every call, so a port change is followed', async () => {
    let base = BASE;
    const { api, calls } = setup(() => json({ roots: [] }), { baseUrl: () => base });
    await api.roots();
    base = 'http://127.0.0.1:7791';
    await api.roots();
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/api/roots`, 'http://127.0.0.1:7791/api/roots']);
  });

  it('revokes a device by its encoded id', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 204 }));
    await api.revokeDevice('a/b c');
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/devices/a%2Fb%20c`, method: 'DELETE' });
  });

  it('maps agent accounts: several profiles, and an agent that only has the principal login', async () => {
    const { api, calls } = setup(() =>
      json({
        accounts: [
          {
            agentId: 'claude',
            label: 'Claude Code',
            status: 'logged_in',
            account: 'eu@exemplo.com',
            detail: 'Pro',
            checkedAt: 1,
            supportsAccounts: true,
            profiles: [
              { id: 'default', label: 'Principal', isDefault: true, active: false, status: 'logged_in', account: 'eu@exemplo.com', detail: null, checkedAt: 1 },
              { id: 'work', label: 'Trabalho', isDefault: false, active: true, status: 'logged_out', account: null, detail: null, checkedAt: 1 },
            ],
          },
          { agentId: 'omp', label: 'Oh My Pi', status: 'unknown', account: null, detail: null, checkedAt: 1, supportsAccounts: false, profiles: [] },
        ],
      }),
    );
    expect(await api.accounts()).toEqual([
      {
        agentId: 'claude',
        agentName: 'Claude Code',
        multiAccount: true,
        accounts: [
          { id: 'default', name: 'Principal', principal: true, active: false, status: 'logged_in', identity: 'eu@exemplo.com' },
          { id: 'work', name: 'Trabalho', principal: false, active: true, status: 'logged_out', identity: null },
        ],
      },
      {
        agentId: 'omp',
        agentName: 'Oh My Pi',
        multiAccount: false,
        accounts: [{ id: 'default', name: 'Conta principal', principal: true, active: true, status: 'unknown', identity: null }],
      },
    ]);
    expect(calls[0]?.url).toBe(`${BASE}/api/agents/accounts`);
  });

  it('asks the daemon to check the logins again only when told to', async () => {
    const { api, calls } = setup(() => json({ accounts: [] }));
    await api.accounts(true);
    await api.accounts(false);
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/api/agents/accounts?refresh=1`, `${BASE}/api/agents/accounts`]);
  });

  it('sets the active account with a JSON body', async () => {
    const { api, calls } = setup(() => json({ accountId: 'work' }));
    await api.setActiveAccount('claude', 'work');
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/agents/claude/accounts/active`, method: 'PUT', body: '{"accountId":"work"}' });
    expect(calls[0]?.headers['content-type']).toContain('application/json');
  });

  it('refuses an answer that names another account than the one asked', async () => {
    const { api } = setup(() => json({ accountId: 'other' }));
    expect((await failure(api.setActiveAccount('claude', 'work'))).kind).toBe('bad_response');
  });

  it('reads the roots the running daemon uses', async () => {
    const { api } = setup(() => json({ roots: [{ path: 'C:\\Projetos', name: 'Projetos' }, { path: 'D:\\', name: 'D:\\' }] }));
    expect(await api.roots()).toEqual(['C:\\Projetos', 'D:\\']);
  });

  it('counts workspaces, sessions and the ones a restart would interrupt', async () => {
    const sessions: Record<string, string[]> = {
      w1: ['idle', 'running', 'awaiting_permission', 'stopped'],
      w2: ['starting', 'running', 'error'],
    };
    const { api, calls } = setup((call) => {
      if (call.url.endsWith('/api/workspaces')) {
        return json({ workspaces: [{ id: 'w1', name: 'a', path: 'C:\\a', createdAt: 1, muted: false }, { id: 'w2', name: 'b', path: 'C:\\b', createdAt: 1, muted: false }] });
      }
      const id = /workspaces\/(\w+)\/sessions/.exec(call.url)?.[1] ?? '';
      return json({ sessions: (sessions[id] ?? []).map((status, index) => ({ id: `${id}-${index}`, status })) });
    });
    expect(await api.activity()).toEqual({ workspaces: 2, sessions: 7, busySessions: 3 });
    expect(calls.map((call) => call.url).sort()).toEqual(
      [`${BASE}/api/workspaces`, `${BASE}/api/workspaces/w1/sessions`, `${BASE}/api/workspaces/w2/sessions`].sort(),
    );
  });

  it('counts a workspace that vanished meanwhile as having no sessions', async () => {
    const { api } = setup((call) => {
      if (call.url.endsWith('/api/workspaces')) return json({ workspaces: [{ id: 'w1' }, { id: 'w2' }] });
      if (call.url.includes('/w1/')) return json({ error: 'not_found' }, 404);
      return json({ sessions: [{ id: 's', status: 'running' }] });
    });
    expect(await api.activity()).toEqual({ workspaces: 2, sessions: 1, busySessions: 1 });
  });
});

describe('daemon api: authentication', () => {
  it('on a 401 asks for a fresh token and retries once with it', async () => {
    const refresh = vi.fn(() => Promise.resolve('fresh-token'));
    const { api, calls } = setup(
      (call) => (call.headers.authorization === 'Bearer fresh-token' ? json({ roots: [] }) : json({ error: 'unauthorized' }, 401)),
      { refreshToken: refresh },
    );
    expect(await api.roots()).toEqual([]);
    expect(calls.map((call) => call.headers.authorization)).toEqual([`Bearer ${TOKEN}`, 'Bearer fresh-token']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is unauthorized when the fresh token is the same one, or when the retry is refused too', async () => {
    const same = setup(() => json({ error: 'unauthorized' }, 401));
    expect((await failure(same.api.roots())).kind).toBe('unauthorized');
    expect(same.calls).toHaveLength(1);

    const again = setup(() => json({ error: 'unauthorized' }, 401), { refreshToken: () => Promise.resolve('other') });
    expect((await failure(again.api.roots())).kind).toBe('unauthorized');
    expect(again.calls).toHaveLength(2);
  });

  it('turns a pairing failure into not_paired, or unavailable when the daemon did not answer', async () => {
    const notPaired = setup(() => json({}), { token: () => Promise.reject(new PairingError('rejected', 'o daemon recusou o novo dispositivo (HTTP 403)')) });
    const first = await failure(notPaired.api.devices());
    expect(first.kind).toBe('not_paired');
    expect(first.message).toContain('recusou');
    expect(notPaired.calls).toHaveLength(0);

    const down = setup(() => json({}), { token: () => Promise.reject(new PairingError('network', 'o daemon não respondeu')) });
    expect((await failure(down.api.devices())).kind).toBe('unavailable');
  });

  it('never puts the token in an error', async () => {
    const { api } = setup(() => json({ error: 'internal' }, 500));
    const error = await failure(api.devices());
    expect(`${error.message} ${error.stack ?? ''}`).not.toContain(TOKEN);
    expect(toControlError(error).message).not.toContain(TOKEN);
  });
});

describe('daemon api: failures', () => {
  it.each([
    ['403 forbidden', () => json({ error: 'forbidden' }, 403), 'forbidden'],
    ['404', () => json({ error: 'not_found' }, 404), 'not_found'],
    ['400', () => json({ error: 'invalid_request' }, 400), 'rejected'],
    ['409', () => json({ error: 'account_in_use' }, 409), 'rejected'],
    ['429', () => json({ error: 'rate_limited' }, 429), 'busy'],
    ['500', () => json({ error: 'internal' }, 500), 'server'],
    ['503 without a body', () => new Response('', { status: 503 }), 'server'],
    ['a 200 that is not JSON', () => new Response('<html>', { status: 200 }), 'bad_response'],
    ['a 200 with the wrong shape', () => json({ devices: 'x' }), 'bad_response'],
  ])('maps %s', async (_label, handler, kind) => {
    const { api } = setup(handler);
    expect((await failure(api.devices())).kind).toBe(kind);
  });

  it('keeps the daemon error code of a refusal', async () => {
    const { api } = setup(() => json({ error: 'accounts_unsupported' }, 400));
    const error = await failure(api.setActiveAccount('omp', 'x'));
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(400);
    expect(error.apiCode).toBe('accounts_unsupported');
  });

  it('a device list with a malformed entry is a bad answer, not a shorter list', async () => {
    const { api } = setup(() => json({ devices: [{ id: 'd1', name: 'x', createdAt: 1, lastSeenAt: null, current: false }, { id: 5 }] }));
    expect((await failure(api.devices())).kind).toBe('bad_response');
  });

  it('is unavailable when the connection fails or times out', async () => {
    const refused = setup(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(refused.api.devices())).kind).toBe('unavailable');

    const hung = createDaemonApi({
      baseUrl: () => BASE,
      token: () => Promise.resolve(TOKEN),
      refreshToken: () => Promise.resolve(TOKEN),
      timeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as unknown as typeof fetch,
    });
    expect((await failure(hung.devices())).kind).toBe('unavailable');
  });
});

describe('toControlError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['unavailable', new DaemonApiError('unavailable', 'x'), 'daemon_unavailable'],
    ['not_paired', new DaemonApiError('not_paired', 'x'), 'not_paired'],
    ['unauthorized', new DaemonApiError('unauthorized', 'x', 401), 'unauthorized'],
    ['forbidden', new DaemonApiError('forbidden', 'x', 403), 'unauthorized'],
    ['rejected', new DaemonApiError('rejected', 'x', 400, 'invalid_request'), 'invalid_input'],
    ['not_found', new DaemonApiError('not_found', 'x', 404), 'unknown'],
    ['busy', new DaemonApiError('busy', 'x', 429), 'unknown'],
    ['server', new DaemonApiError('server', 'x', 500), 'unknown'],
    ['bad_response', new DaemonApiError('bad_response', 'x'), 'unknown'],
    ['roots invalid input', new RootsConfigError('invalid_input', 'A pasta "X" não existe.'), 'invalid_input'],
    ['roots io', new RootsConfigError('io', 'Não foi possível gravar'), 'io'],
    ['pairing network', new PairingError('network', 'o daemon não respondeu'), 'daemon_unavailable'],
    ['pairing cli', new PairingError('cli_failed', 'o comando falhou'), 'unknown'],
    ['pairing rejected', new PairingError('rejected', 'recusou'), 'not_paired'],
    ['a plain error', new Error('boom'), 'unknown'],
    ['a string', 'boom', 'unknown'],
  ];

  it.each(cases)('%s', (_label, error, code) => {
    const result = toControlError(error);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
    expect(result.message.length).toBeGreaterThan(10);
  });

  it('writes Portuguese messages without emoji', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const [, error] of cases) {
      const { message } = toControlError(error);
      expect(message).not.toMatch(emoji);
    }
    expect(toControlError(new DaemonApiError('unavailable', 'x')).message).toMatch(/daemon/);
    expect(toControlError(new DaemonApiError('forbidden', 'x', 403)).message).toMatch(/Tailscale/);
  });

  it('keeps the message of an error that already fits the user', () => {
    expect(toControlError(new RootsConfigError('invalid_input', 'A pasta "X" não existe.')).message).toBe('A pasta "X" não existe.');
  });

  it('explains the daemon refusal codes it knows', () => {
    expect(toControlError(new DaemonApiError('rejected', 'x', 400, 'accounts_unsupported')).message).toMatch(/contas/);
    expect(toControlError(new DaemonApiError('rejected', 'x', 409, 'account_in_use')).message).toMatch(/sessão/);
  });
});

describe('createTokenAccess', () => {
  const machine = (baseUrl: string, token = 'tok'): SeedMachine => ({ id: 'm', name: 'PC', baseUrl, token });
  const OWNED = () => ({ owned: true, generation: 'spawned:7780:100' });

  it('uses the token Desktop already holds for the address it is talking to, without any network call', async () => {
    const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'ensured')));
    const access = createTokenAccess({ current: () => machine(BASE, 'held'), ensureMachine }, { baseUrl: () => BASE, daemon: OWNED });
    expect(await access.token()).toBe('held');
    expect(ensureMachine).not.toHaveBeenCalled();
  });

  it('pairs when nothing is held, or when what is held belongs to another address, for a daemon it runs', async () => {
    const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'ensured')));
    expect(await createTokenAccess({ current: () => null, ensureMachine }, { baseUrl: () => BASE, daemon: OWNED }).token()).toBe('ensured');
    expect(
      await createTokenAccess({ current: () => machine('http://127.0.0.1:7777'), ensureMachine }, { baseUrl: () => BASE, daemon: OWNED }).token(),
    ).toBe('ensured');
    expect(ensureMachine).toHaveBeenCalledTimes(2);
  });

  it('refresh goes through the pairing, which checks the token and pairs again only if it was revoked', async () => {
    const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'checked')));
    const access = createTokenAccess({ current: () => machine(BASE, 'held'), ensureMachine }, { baseUrl: () => BASE, daemon: OWNED });
    expect(await access.refresh()).toBe('checked');
    expect(ensureMachine).toHaveBeenCalledTimes(1);
  });

  it('refresh is rate limited: inside the cooldown it answers with the held token and does not pair again', async () => {
    let clock = 0;
    const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'checked')));
    const access = createTokenAccess(
      { current: () => machine(BASE, 'held'), ensureMachine },
      { baseUrl: () => BASE, daemon: OWNED, now: () => clock, repairCooldownMs: 30_000 },
    );
    expect(await access.refresh()).toBe('checked');
    clock = 29_999;
    expect(await access.refresh()).toBe('held');
    expect(ensureMachine).toHaveBeenCalledTimes(1);
    clock = 30_000;
    expect(await access.refresh()).toBe('checked');
    expect(ensureMachine).toHaveBeenCalledTimes(2);
  });

  it('a pairing that failed is not tried again inside the cooldown: the same failure is reported, with no new device', async () => {
    let clock = 0;
    const ensureMachine = vi.fn(() => Promise.reject(new PairingError('network', 'o daemon não respondeu')));
    const access = createTokenAccess(
      { current: () => null, ensureMachine },
      { baseUrl: () => BASE, daemon: OWNED, now: () => clock, repairCooldownMs: 30_000 },
    );
    await expect(access.token()).rejects.toMatchObject({ kind: 'network' });
    clock = 1_000;
    await expect(access.token()).rejects.toMatchObject({ kind: 'network' });
    await expect(access.refresh()).rejects.toMatchObject({ kind: 'network' });
    expect(ensureMachine).toHaveBeenCalledTimes(1);
    clock = 30_000;
    await expect(access.token()).rejects.toMatchObject({ kind: 'network' });
    expect(ensureMachine).toHaveBeenCalledTimes(2);
  });

  it('a successful pairing is not held back: a new address (the port changed) is paired at once', async () => {
    let clock = 0;
    let base = BASE;
    let held: SeedMachine | null = null;
    const ensureMachine = vi.fn(() => {
      held = machine(base, `tok-${base}`);
      return Promise.resolve(held);
    });
    const access = createTokenAccess({ current: () => held, ensureMachine }, { baseUrl: () => base, daemon: OWNED, now: () => clock });
    expect(await access.token()).toBe(`tok-${BASE}`);
    base = 'http://127.0.0.1:7781';
    clock = 1_000;
    expect(await access.token()).toBe('tok-http://127.0.0.1:7781');
    expect(ensureMachine).toHaveBeenCalledTimes(2);
  });

  describe('a daemon Desktop did not start (attached)', () => {
    const FOREIGN = (generation = 'attached:7780:') => () => ({ owned: false, generation });

    it('never pairs: not when asked for a token, not on a 401', async () => {
      const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'ensured')));
      const access = createTokenAccess({ current: () => null, ensureMachine }, { baseUrl: () => BASE, daemon: FOREIGN() });
      for (let round = 0; round < 5; round += 1) {
        await expect(access.token()).rejects.toMatchObject({ kind: 'rejected' });
        await expect(access.refresh()).rejects.toMatchObject({ kind: 'rejected' });
      }
      expect(ensureMachine).not.toHaveBeenCalled();
    });

    it('still uses a token the panel paired for that address', async () => {
      const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'ensured')));
      const access = createTokenAccess({ current: () => machine(BASE, 'held'), ensureMachine }, { baseUrl: () => BASE, daemon: FOREIGN() });
      expect(await access.token()).toBe('held');
      expect(ensureMachine).not.toHaveBeenCalled();
    });

    it('remembers the refusal for that daemon, so the held token is not tried again until another daemon is behind the address', async () => {
      let generation = 'attached:7780:';
      const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'ensured')));
      const access = createTokenAccess(
        { current: () => machine(BASE, 'held'), ensureMachine },
        { baseUrl: () => BASE, daemon: () => ({ owned: false, generation }) },
      );
      expect(await access.token()).toBe('held');
      // The daemon answered 401 to the held token.
      await expect(access.refresh()).rejects.toMatchObject({ kind: 'rejected' });
      await expect(access.token()).rejects.toMatchObject({ kind: 'rejected' });
      await expect(access.token()).rejects.toMatchObject({ kind: 'rejected' });
      generation = 'attached:7781:';
      expect(await access.token()).toBe('held');
      expect(ensureMachine).not.toHaveBeenCalled();
    });

    it('a refusal is about a token: one the panel paired afterwards (a daemon that shares the home) is tried at once', async () => {
      let held: SeedMachine | null = null;
      const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'ensured')));
      const access = createTokenAccess({ current: () => held, ensureMachine }, { baseUrl: () => BASE, daemon: () => ({ owned: false, generation: 'attached:7780:' }) });
      // Nothing is held: refused, without a network call.
      await expect(access.token()).rejects.toMatchObject({ kind: 'rejected' });
      await expect(access.token()).rejects.toMatchObject({ kind: 'rejected' });
      // The sessions window paired Desktop with that daemon.
      held = machine(BASE, 'from-the-panel');
      expect(await access.token()).toBe('from-the-panel');
      // The daemon answers 401 to that one as well: refused again, until yet another token shows up.
      await expect(access.refresh()).rejects.toMatchObject({ kind: 'rejected' });
      await expect(access.token()).rejects.toMatchObject({ kind: 'rejected' });
      held = machine(BASE, 'a-newer-one');
      expect(await access.token()).toBe('a-newer-one');
      expect(ensureMachine).not.toHaveBeenCalled();
    });
  });

  it('end to end: polling a daemon that keeps answering 401 never creates devices', async () => {
    const ensureMachine = vi.fn(() => Promise.resolve(machine(BASE, 'fresh')));
    const fetchImpl = vi.fn(() => Promise.resolve(json({ error: 'unauthorized' }, 401))) as unknown as typeof fetch;

    // Attached: no network call, no pairing, a plain "not paired" every time.
    const attached = createTokenAccess({ current: () => null, ensureMachine }, { baseUrl: () => BASE, daemon: () => ({ owned: false, generation: 'attached:7780:' }) });
    const foreignApi = createDaemonApi({ baseUrl: () => BASE, token: attached.token, refreshToken: attached.refresh, fetchImpl });
    for (let poll = 0; poll < 20; poll += 1) {
      expect((await failure(foreignApi.devices())).kind).toBe('not_paired');
    }
    expect(ensureMachine).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    // Spawned, token rejected over and over: one re-pairing in the cooldown, not one per poll.
    let clock = 0;
    const spawned = createTokenAccess(
      { current: () => machine(BASE, 'held'), ensureMachine },
      { baseUrl: () => BASE, daemon: OWNED, now: () => clock },
    );
    const ownApi = createDaemonApi({ baseUrl: () => BASE, token: spawned.token, refreshToken: spawned.refresh, fetchImpl });
    for (let poll = 0; poll < 20; poll += 1) {
      clock += 5_000;
      expect((await failure(ownApi.devices())).kind).toBe('unauthorized');
    }
    // 20 polls over 100 s with a 30 s cooldown.
    expect(ensureMachine.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
