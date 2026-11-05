import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, pairTailscale, pairTailscaleStatus, type FetchLike } from './api.js';

const BASE = 'http://127.0.0.1:7777';
const PAIR = { token: 'tok-new', deviceId: 'd-1', machineId: 'm-1', machineName: 'PC sala' };

type Call = { url: string; init: RequestInit | undefined };

function recording(respond: () => Response) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GET /api/shells (fetchShells)', () => {
  it('lista os shells do PC com o token da máquina', async () => {
    const fake = recording(() =>
      json({
        shells: [
          { id: 'pwsh', label: 'PowerShell 7', isDefault: true },
          { id: 'cmd', label: 'Prompt de Comando', isDefault: false },
        ],
      }),
    );
    const client = createApiClient({ baseUrl: BASE, token: 'tok' }, fake.fetchFn);
    const shells = await client.fetchShells();
    expect(shells.map((shell) => shell.id)).toEqual(['pwsh', 'cmd']);
    expect(fake.calls[0]?.url).toBe(`${BASE}/api/shells`);
    expect(new Headers(fake.calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('resposta fora do contrato vira erro inesperado', async () => {
    const fake = recording(() => json({ shells: [{ id: 'zsh', label: 'Zsh', isDefault: true }] }));
    const client = createApiClient({ baseUrl: BASE, token: 'tok' }, fake.fetchFn);
    await expect(client.fetchShells()).rejects.toMatchObject({ kind: 'unexpected' });
  });
});

describe('createSession com shell', () => {
  it('manda agent "shell" e o shell escolhido no corpo', async () => {
    const session = {
      id: 's-1',
      workspaceId: 'w-1',
      agent: 'shell',
      kind: 'pty',
      title: 'Terminal · cmd',
      status: 'running',
      worktree: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const fake = recording(() => json(session, 201));
    const client = createApiClient({ baseUrl: BASE, token: 'tok' }, fake.fetchFn);
    await client.createSession({ workspaceId: 'w-1', agent: 'shell', shell: 'cmd' });
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ workspaceId: 'w-1', agent: 'shell', shell: 'cmd' });
  });
});

describe('Entrar com Tailscale: GET /api/pair/tailscale', () => {
  it('disponível: devolve o login, sem token', async () => {
    const fake = recording(() => json({ available: true, login: 'joao@example.invalid' }));
    await expect(pairTailscaleStatus(BASE, fake.fetchFn)).resolves.toEqual({
      available: true,
      login: 'joao@example.invalid',
    });
    expect(fake.calls[0]?.url).toBe(`${BASE}/api/pair/tailscale`);
    expect(new Headers(fake.calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  it('indisponível: só available false', async () => {
    const fake = recording(() => json({ available: false }));
    await expect(pairTailscaleStatus(BASE, fake.fetchFn)).resolves.toEqual({ available: false });
  });

  it('login junto de available false quebra o contrato (erro inesperado)', async () => {
    const fake = recording(() => json({ available: false, login: 'x@example.invalid' }));
    await expect(pairTailscaleStatus(BASE, fake.fetchFn)).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('sem rede vira erro de rede', async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError('failed');
    };
    await expect(pairTailscaleStatus(BASE, fetchFn)).rejects.toMatchObject({ kind: 'network' });
  });

  it('URL inválida não chama a rede', async () => {
    const fake = recording(() => json({ available: false }));
    await expect(pairTailscaleStatus('ftp://pc', fake.fetchFn)).rejects.toBeInstanceOf(ApiError);
    expect(fake.calls).toEqual([]);
  });
});

describe('Entrar com Tailscale: POST /api/pair/tailscale', () => {
  it('manda o nome do aparelho e devolve o pareamento igual ao de código', async () => {
    const fake = recording(() => json(PAIR));
    await expect(pairTailscale({ baseUrl: BASE, deviceName: 'iPhone' }, fake.fetchFn)).resolves.toEqual(PAIR);
    expect(fake.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ deviceName: 'iPhone' });
  });

  it('nome vazio não chama a rede', async () => {
    const fake = recording(() => json(PAIR));
    await expect(pairTailscale({ baseUrl: BASE, deviceName: '' }, fake.fetchFn)).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [400, 'invalid_input'],
  ] as const)('status %i vira %s', async (status, kind) => {
    const fake = recording(() => json({ error: 'x' }, status));
    await expect(pairTailscale({ baseUrl: BASE, deviceName: 'iPhone' }, fake.fetchFn)).rejects.toMatchObject({
      kind,
      status,
    });
  });
});
