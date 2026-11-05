import { describe, expect, it } from 'vitest';
import { notificationFromPush } from './payload.js';
import { isPushSupported } from './support.js';
import {
  DEVICES_MESSAGE,
  buildDevicesUrl,
  buildSessionUrl,
  parseDevicesSearch,
  parseDevicesTarget,
  parseOpenDevicesMessage,
  parseOpenSessionMessage,
  parseSessionSearch,
  parseSessionTarget,
  targetRoute,
} from './notificationRoute.js';
import { toSubscriptionRequest } from './subscription.js';
import { urlBase64ToUint8Array } from './vapid.js';

describe('urlBase64ToUint8Array', () => {
  it('decodifica base64url sem padding', () => {
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
  });

  it('aceita - e _ no lugar de + e / e completa o padding', () => {
    // 0xfb 0xff -> base64 "+/8=" -> base64url "-_8" (sem padding)
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]);
  });

  it('aceita a chave com padding também', () => {
    expect([...urlBase64ToUint8Array('-_8=')]).toEqual([0xfb, 0xff]);
  });

  it('devolve Uint8Array pronto para applicationServerKey', () => {
    const key = urlBase64ToUint8Array('AQID');
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('caractere fora do alfabeto base64url lança erro', () => {
    expect(() => urlBase64ToUint8Array('ab+c')).toThrow(TypeError);
    expect(() => urlBase64ToUint8Array('ab c')).toThrow(TypeError);
  });

  it('chave vazia vira bytes vazios', () => {
    expect(urlBase64ToUint8Array('').length).toBe(0);
  });
});

describe('isPushSupported', () => {
  const ALL = { hasServiceWorker: true, hasPushManager: true, hasNotification: true };

  it('suporta quando há service worker, PushManager e Notification', () => {
    expect(isPushSupported(ALL)).toBe(true);
  });

  it.each([
    ['hasServiceWorker', { ...ALL, hasServiceWorker: false }],
    ['hasPushManager', { ...ALL, hasPushManager: false }],
    ['hasNotification', { ...ALL, hasNotification: false }],
  ])('sem %s não suporta (Safari fora da Tela de Início)', (_name, env) => {
    expect(isPushSupported(env)).toBe(false);
  });
});

describe('notificationFromPush', () => {
  const PAYLOAD = {
    title: 'app-api',
    body: 'Terminou',
    machineId: 'm-1',
    workspaceId: 'w-1',
    sessionId: 's-1',
    kind: 'turn_end',
  };

  it('payload válido vira notificação com tag = sessionId e data de navegação', () => {
    expect(notificationFromPush(PAYLOAD)).toEqual({
      title: 'app-api',
      options: {
        body: 'Terminou',
        tag: 's-1',
        data: { machineId: 'm-1', workspaceId: 'w-1', sessionId: 's-1' },
      },
    });
  });

  it('payload inválido ainda mostra uma notificação genérica (o push exige notificação visível)', () => {
    const fallback = notificationFromPush({ title: '' });
    expect(fallback.title).toBe('Nanachi Remote');
    expect(fallback.options.body).toBe('Nova atividade no seu PC');
    expect(fallback.options.data).toBeUndefined();
  });

  it('sem dado nenhum também cai no genérico', () => {
    expect(notificationFromPush(undefined).title).toBe('Nanachi Remote');
    expect(notificationFromPush('texto').title).toBe('Nanachi Remote');
  });
});

describe('roteamento da notificação', () => {
  const TARGET = { machineId: 'm-1', workspaceId: 'w 1', sessionId: 's&1' };

  it('buildSessionUrl monta /?machine=&workspace=&session= com encoding', () => {
    expect(buildSessionUrl(TARGET)).toBe('/?machine=m-1&workspace=w+1&session=s%261');
  });

  it('parseSessionSearch lê os três parâmetros de volta', () => {
    expect(parseSessionSearch(buildSessionUrl(TARGET).slice(1))).toEqual(TARGET);
    expect(parseSessionSearch('?machine=m-1&workspace=w-1&session=s-1')).toEqual({
      machineId: 'm-1',
      workspaceId: 'w-1',
      sessionId: 's-1',
    });
  });

  it('query sem algum parâmetro ou vazia não é alvo', () => {
    expect(parseSessionSearch('')).toBeNull();
    expect(parseSessionSearch('?machine=m-1&workspace=w-1')).toBeNull();
    expect(parseSessionSearch('?machine=&workspace=w-1&session=s-1')).toBeNull();
  });

  it('parseOpenSessionMessage aceita só a mensagem open-session válida', () => {
    expect(
      parseOpenSessionMessage({ type: 'open-session', machineId: 'm-1', workspaceId: 'w-1', sessionId: 's-1' }),
    ).toEqual({ machineId: 'm-1', workspaceId: 'w-1', sessionId: 's-1' });
    expect(parseOpenSessionMessage({ type: 'outra', machineId: 'm-1', workspaceId: 'w-1', sessionId: 's-1' })).toBeNull();
    expect(parseOpenSessionMessage({ type: 'open-session' })).toBeNull();
    expect(parseOpenSessionMessage(null)).toBeNull();
  });

  it('dado da notificação clicada vira alvo; lixo vira null', () => {
    expect(parseSessionTarget({ machineId: 'm-1', workspaceId: 'w-1', sessionId: 's-1', kind: 'x' })).toEqual({
      machineId: 'm-1',
      workspaceId: 'w-1',
      sessionId: 's-1',
    });
    expect(parseSessionTarget(undefined)).toBeNull();
    expect(parseSessionTarget({ machineId: 'm-1' })).toBeNull();
  });

  it('alvo vira a rota salva de chat (mesmo formato do lastRoute)', () => {
    expect(targetRoute(TARGET)).toEqual({
      machineId: 'm-1',
      kind: 'chat',
      workspaceId: 'w 1',
      sessionId: 's&1',
    });
  });
});

describe('toSubscriptionRequest', () => {
  it('converte o JSON do PushSubscription no corpo do daemon', () => {
    expect(
      toSubscriptionRequest({
        endpoint: 'https://web.push.apple.com/abc',
        keys: { p256dh: 'p', auth: 'a' },
        expirationTime: null,
      }),
    ).toEqual({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('sem chaves ou endpoint inválido devolve null', () => {
    expect(toSubscriptionRequest({ endpoint: 'https://x.test/a' })).toBeNull();
    expect(toSubscriptionRequest({ endpoint: 'nao-url', keys: { p256dh: 'p', auth: 'a' } })).toBeNull();
    expect(toSubscriptionRequest({})).toBeNull();
  });
});

describe('device_paired (Entrar com Tailscale)', () => {
  const paired = {
    title: 'Nanachi Remote',
    body: 'Novo aparelho entrou com Tailscale: iPhone do João',
    machineId: 'm-1',
    kind: 'device_paired',
  };

  it('mostra o aviso com o texto do daemon e leva para Dispositivos da máquina', () => {
    expect(notificationFromPush(paired)).toEqual({
      title: 'Nanachi Remote',
      options: {
        body: 'Novo aparelho entrou com Tailscale: iPhone do João',
        tag: 'device-paired',
        data: { machineId: 'm-1', screen: 'devices' },
      },
    });
  });

  it('payload de device_paired sem machineId cai no aviso genérico', () => {
    const broken = { title: paired.title, body: paired.body, kind: paired.kind };
    expect(notificationFromPush(broken).options.body).toBe('Nova atividade no seu PC');
  });

  it('o alvo de Dispositivos sai do clique da notificação e não confunde com uma sessão', () => {
    const data = notificationFromPush(paired).options.data;
    expect(parseDevicesTarget(data)).toEqual({ machineId: 'm-1' });
    expect(parseSessionTarget(data)).toBeNull();
  });

  it('URL de abertura e mensagem do service worker levam a Dispositivos', () => {
    expect(buildDevicesUrl({ machineId: 'm-1' })).toBe('/?machine=m-1&screen=devices');
    expect(parseDevicesSearch('?machine=m-1&screen=devices')).toEqual({ machineId: 'm-1' });
    expect(parseDevicesSearch('?machine=m-1&screen=chat')).toBeNull();
    expect(parseDevicesSearch('?machine=m-1&workspace=w&session=s')).toBeNull();
    expect(parseOpenDevicesMessage({ type: DEVICES_MESSAGE, machineId: 'm-1' })).toEqual({ machineId: 'm-1' });
    expect(parseOpenDevicesMessage({ type: 'open-session', machineId: 'm-1' })).toBeNull();
  });

  it('uma sessão continua indo para o chat, sem virar aviso de Dispositivos', () => {
    const data = notificationFromPush({
      title: 'Agente',
      body: 'terminou',
      machineId: 'm-1',
      workspaceId: 'w-1',
      sessionId: 's-1',
      kind: 'turn_end',
    }).options.data;
    expect(parseDevicesTarget(data)).toBeNull();
    expect(parseSessionTarget(data)).toEqual({ machineId: 'm-1', workspaceId: 'w-1', sessionId: 's-1' });
  });
});
