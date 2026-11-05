import {
  MeResponseSchema,
  PairResponseSchema,
  TailscalePairStatusResponseSchema,
  type MeResponse,
} from '@nanachi/shared';
import { describe, expect, it, vi } from 'vitest';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();
const LOGIN = 'joao@exemplo.com';
const OTHER_LOGIN = 'outro@exemplo.com';
/** Peer de loopback (o tailscale serve chega assim) e um peer de fora. */
const LOOPBACK = '127.0.0.1';
const REMOTE = '10.0.0.5';

const enabled = { allowedTailscaleLogins: [LOGIN], tailscaleAutoPair: true };

function asLogin(login: string | undefined, remoteAddress = LOOPBACK): { headers: Record<string, string>; remoteAddress: string } {
  return { headers: login === undefined ? {} : { 'tailscale-user-login': login }, remoteAddress };
}

function deviceRow(daemon: TestDaemon, deviceId: string): { pair_method: string } | undefined {
  return daemon.db.prepare<[string], { pair_method: string }>('SELECT pair_method FROM devices WHERE id = ?').get(deviceId);
}

describe('GET /api/pair/tailscale', () => {
  it('flag desligado: available false, mesmo com login permitido', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN] } });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/pair/tailscale', ...asLogin(LOGIN) });
    expect(res.statusCode).toBe(200);
    expect(TailscalePairStatusResponseSchema.parse(res.json<unknown>())).toEqual({ available: false });
  });

  it('header ausente: available false, sem login, sem token', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/pair/tailscale', ...asLogin(undefined) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it('login que não está na allowlist: available false (a rota responde, não 403)', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/pair/tailscale', ...asLogin(OTHER_LOGIN) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it('peer que não é loopback: o header é ignorado, available false', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/pair/tailscale', ...asLogin(LOGIN, REMOTE) });
    expect(res.json()).toEqual({ available: false });
  });

  it('flag ligado, loopback e login permitido: available true com o login', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/pair/tailscale', ...asLogin(LOGIN) });
    expect(TailscalePairStatusResponseSchema.parse(res.json<unknown>())).toEqual({ available: true, login: LOGIN });
  });
});

describe('POST /api/pair/tailscale', () => {
  it('pareia sem código: mesma resposta do pareamento por código, token que funciona', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPhone' },
      ...asLogin(LOGIN),
    });

    expect(res.statusCode).toBe(200);
    const body = PairResponseSchema.parse(res.json<unknown>());
    expect(body.machineId).toBe(daemon.machine.id);
    const me = await daemon.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${body.token}`, 'tailscale-user-login': LOGIN },
    });
    expect(MeResponseSchema.parse(me.json<MeResponse>()).deviceId).toBe(body.deviceId);
  });

  it('grava o método do pareamento no device: tailscale aqui, code no pareamento por código', async () => {
    const daemon = await env.start({ config: enabled });
    const viaTailscale = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPhone' },
      ...asLogin(LOGIN),
    });
    const viaCode = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code: issueCode(daemon), deviceName: 'iPad' },
      ...asLogin(LOGIN),
    });

    expect(deviceRow(daemon, viaTailscale.json<{ deviceId: string }>().deviceId)?.pair_method).toBe('tailscale');
    expect(deviceRow(daemon, viaCode.json<{ deviceId: string }>().deviceId)?.pair_method).toBe('code');
  });

  it('flag desligado: 403 pair_unavailable e nenhum device criado', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN] } });
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPhone' },
      ...asLogin(LOGIN),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'pair_unavailable' });
    expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(0);
  });

  it('header ausente, login fora da lista ou peer remoto: 403', async () => {
    const daemon = await env.start({ config: enabled });
    for (const attempt of [asLogin(undefined), asLogin(OTHER_LOGIN), asLogin(LOGIN, REMOTE)]) {
      const res = await daemon.app.inject({
        method: 'POST',
        url: '/api/pair/tailscale',
        payload: { deviceName: 'x' },
        ...attempt,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('corpo inválido: 400 invalid_body', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: '' },
      ...asLogin(LOGIN),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_body' });
  });

  it('limite de tentativas: 5 falhas no minuto bloqueiam (429), inclusive a que seria válida', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN] } });
    const attempt = () =>
      daemon.app.inject({ method: 'POST', url: '/api/pair/tailscale', payload: { deviceName: 'x' }, ...asLogin(LOGIN) });

    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(403);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_attempts' });
  });

  it('o limite é por login: outro login continua com as tentativas dele', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN, OTHER_LOGIN], tailscaleAutoPair: true } });
    for (let i = 0; i < 5; i++) {
      await daemon.app.inject({ method: 'POST', url: '/api/pair/tailscale', payload: { deviceName: '' }, ...asLogin(LOGIN) });
    }
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPad' },
      ...asLogin(OTHER_LOGIN),
    });
    expect(res.statusCode).toBe(200);
  });

  it('pareamento novo avisa os outros devices (não o novo), mesmo com WS aberto', async () => {
    const onDevicePaired = vi.fn();
    const daemon = await env.start({ config: enabled, onDevicePaired });
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPhone' },
      ...asLogin(LOGIN),
    });
    const { deviceId } = res.json<{ deviceId: string }>();

    expect(onDevicePaired).toHaveBeenCalledTimes(1);
    expect(onDevicePaired).toHaveBeenCalledWith({ id: deviceId, name: 'iPhone' });
  });

  it('recusado não avisa ninguém', async () => {
    const onDevicePaired = vi.fn();
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN] }, onDevicePaired });
    await daemon.app.inject({ method: 'POST', url: '/api/pair/tailscale', payload: { deviceName: 'x' }, ...asLogin(LOGIN) });
    expect(onDevicePaired).not.toHaveBeenCalled();
  });

  it('um aviso que falha não derruba o pareamento', async () => {
    const daemon = await env.start({
      config: enabled,
      onDevicePaired: () => {
        throw new Error('push fora do ar');
      },
    });
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPhone' },
      ...asLogin(LOGIN),
    });
    expect(res.statusCode).toBe(200);
    expect(PairResponseSchema.parse(res.json<unknown>()).deviceId).toBeTruthy();
  });
});

describe('checagem Tailscale global com peer loopback', () => {
  it('um header de login permitido vindo de peer remoto não passa nas rotas /api', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN] } });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'tailscale-user-login': LOGIN },
      remoteAddress: REMOTE,
    });
    expect(res.statusCode).toBe(403);
  });

  it('o mesmo header vindo de loopback passa', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: [LOGIN] } });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'tailscale-user-login': LOGIN },
      remoteAddress: LOOPBACK,
    });
    expect(res.statusCode).toBe(200);
  });

  it('a rota não exige Bearer: o pedido sem Authorization é aceito', async () => {
    const daemon = await env.start({ config: enabled });
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair/tailscale',
      payload: { deviceName: 'iPhone' },
      ...asLogin(LOGIN),
    });
    expect(res.statusCode).toBe(200);
  });
});
