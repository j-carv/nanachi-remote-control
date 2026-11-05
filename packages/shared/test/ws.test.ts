import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
} from '../src/index.js';

const sessionValue = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  accountId: null,
  worktree: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const eventValue = {
  seq: 1,
  sessionId: 's-1',
  ts: 1_700_000_000_000,
  kind: 'agent_message_chunk',
  text: 'olá',
};

describe('ClientMessageSchema', () => {
  it('aceita ping', () => {
    expect(ClientMessageSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  it('rejeita type desconhecido', () => {
    expect(ClientMessageSchema.safeParse({ type: 'hello' }).success).toBe(false);
  });

  it('rejeita objeto sem type', () => {
    expect(ClientMessageSchema.safeParse({}).success).toBe(false);
  });

  describe('subscribe', () => {
    it('aceita sessionId e afterSeq 0', () => {
      const msg = { type: 'subscribe', sessionId: 's-1', afterSeq: 0 };
      expect(ClientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita afterSeq alto', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'subscribe', sessionId: 's-1', afterSeq: 9999 })
          .success,
      ).toBe(true);
    });

    it.each([-1, 1.5, '3', null])('rejeita afterSeq inválido %j', (afterSeq) => {
      expect(
        ClientMessageSchema.safeParse({ type: 'subscribe', sessionId: 's-1', afterSeq }).success,
      ).toBe(false);
    });

    it('rejeita afterSeq ausente', () => {
      expect(ClientMessageSchema.safeParse({ type: 'subscribe', sessionId: 's-1' }).success).toBe(
        false,
      );
    });

    it('rejeita sessionId vazio', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'subscribe', sessionId: '', afterSeq: 0 }).success,
      ).toBe(false);
    });
  });

  describe('unsubscribe', () => {
    it('aceita sessionId', () => {
      expect(ClientMessageSchema.parse({ type: 'unsubscribe', sessionId: 's-1' })).toEqual({
        type: 'unsubscribe',
        sessionId: 's-1',
      });
    });

    it('rejeita sem sessionId', () => {
      expect(ClientMessageSchema.safeParse({ type: 'unsubscribe' }).success).toBe(false);
    });
  });

  describe('prompt', () => {
    it('aceita texto de 1 caractere', () => {
      const msg = { type: 'prompt', sessionId: 's-1', text: 'a' };
      expect(ClientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita texto com exatamente 100000 caracteres', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'prompt',
          sessionId: 's-1',
          text: 'a'.repeat(100_000),
        }).success,
      ).toBe(true);
    });

    it('rejeita texto vazio', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'prompt', sessionId: 's-1', text: '' }).success,
      ).toBe(false);
    });

    it('rejeita texto com 100001 caracteres', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'prompt',
          sessionId: 's-1',
          text: 'a'.repeat(100_001),
        }).success,
      ).toBe(false);
    });

    it('rejeita text ausente ou não string', () => {
      expect(ClientMessageSchema.safeParse({ type: 'prompt', sessionId: 's-1' }).success).toBe(
        false,
      );
      expect(
        ClientMessageSchema.safeParse({ type: 'prompt', sessionId: 's-1', text: 1 }).success,
      ).toBe(false);
    });

    it('rejeita sem sessionId', () => {
      expect(ClientMessageSchema.safeParse({ type: 'prompt', text: 'oi' }).success).toBe(false);
    });
  });

  describe('prompt com anexos', () => {
    const attachments = ['f-1', 'f-2'];

    it('aceita anexos com texto', () => {
      const msg = { type: 'prompt', sessionId: 's-1', text: 'veja', attachments };
      expect(ClientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita texto vazio quando há ao menos 1 anexo', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'prompt',
          sessionId: 's-1',
          text: '',
          attachments: ['f-1'],
        }).success,
      ).toBe(true);
    });

    it('rejeita texto vazio com lista de anexos vazia', () => {
      const result = ClientMessageSchema.safeParse({
        type: 'prompt',
        sessionId: 's-1',
        text: '',
        attachments: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['text']);
    });

    it('aceita até 10 anexos', () => {
      const ten = Array.from({ length: 10 }, (_, i) => `f-${i}`);
      expect(
        ClientMessageSchema.safeParse({ type: 'prompt', sessionId: 's-1', text: 'x', attachments: ten })
          .success,
      ).toBe(true);
    });

    it('rejeita mais de 10 anexos', () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `f-${i}`);
      expect(
        ClientMessageSchema.safeParse({
          type: 'prompt',
          sessionId: 's-1',
          text: 'x',
          attachments: eleven,
        }).success,
      ).toBe(false);
    });

    it('rejeita fileId vazio na lista', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'prompt',
          sessionId: 's-1',
          text: 'x',
          attachments: [''],
        }).success,
      ).toBe(false);
    });

    it('rejeita attachments que não é lista de strings', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'prompt',
          sessionId: 's-1',
          text: 'x',
          attachments: 'f-1',
        }).success,
      ).toBe(false);
    });
  });

  describe('permission_response', () => {
    it('aceita optionId string', () => {
      const msg = { type: 'permission_response', sessionId: 's-1', requestId: 'r-1', optionId: 'allow' };
      expect(ClientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita optionId null (cancelar)', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'permission_response',
          sessionId: 's-1',
          requestId: 'r-1',
          optionId: null,
        }).success,
      ).toBe(true);
    });

    it('rejeita optionId ausente', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'permission_response',
          sessionId: 's-1',
          requestId: 'r-1',
        }).success,
      ).toBe(false);
    });

    it('rejeita requestId ausente', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'permission_response',
          sessionId: 's-1',
          optionId: 'allow',
        }).success,
      ).toBe(false);
    });
  });

  describe('cancel', () => {
    it('aceita sessionId', () => {
      expect(ClientMessageSchema.parse({ type: 'cancel', sessionId: 's-1' })).toEqual({
        type: 'cancel',
        sessionId: 's-1',
      });
    });

    it('rejeita sem sessionId', () => {
      expect(ClientMessageSchema.safeParse({ type: 'cancel' }).success).toBe(false);
    });
  });

  describe('set_config', () => {
    it('aceita value string', () => {
      const msg = { type: 'set_config', sessionId: 's-1', configId: 'model', value: 'opus' };
      expect(ClientMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita value boolean', () => {
      const msg = { type: 'set_config', sessionId: 's-1', configId: 'fast', value: false };
      expect(ClientMessageSchema.parse(msg)).toEqual(msg);
    });

    it.each([1, null, ['opus'], { a: 1 }])('rejeita value inválido %j', (value) => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'set_config',
          sessionId: 's-1',
          configId: 'model',
          value,
        }).success,
      ).toBe(false);
    });

    it('rejeita configId vazio', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'set_config',
          sessionId: 's-1',
          configId: '',
          value: 'x',
        }).success,
      ).toBe(false);
    });

    it('rejeita value ausente', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'set_config', sessionId: 's-1', configId: 'model' })
          .success,
      ).toBe(false);
    });
  });

  describe('terminal_input', () => {
    it('aceita data simples e sequências de controle (Ctrl+C, setas)', () => {
      for (const data of ['ls\r', '\u0003', '\u001b[A']) {
        const msg = { type: 'terminal_input', sessionId: 's-1', data };
        expect(ClientMessageSchema.parse(msg)).toEqual(msg);
      }
    });

    it('aceita data com exatamente 65536 caracteres', () => {
      const data = 'a'.repeat(65536);
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_input', sessionId: 's-1', data }).success,
      ).toBe(true);
    });

    it('rejeita data vazio ou acima de 65536 caracteres', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_input', sessionId: 's-1', data: '' })
          .success,
      ).toBe(false);
      expect(
        ClientMessageSchema.safeParse({
          type: 'terminal_input',
          sessionId: 's-1',
          data: 'a'.repeat(65537),
        }).success,
      ).toBe(false);
    });

    it('rejeita data ausente ou não string', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_input', sessionId: 's-1' }).success,
      ).toBe(false);
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_input', sessionId: 's-1', data: 1 }).success,
      ).toBe(false);
    });

    it('rejeita sessionId vazio', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_input', sessionId: '', data: 'x' }).success,
      ).toBe(false);
    });
  });

  describe('terminal_resize', () => {
    it('aceita cols e rows nos limites', () => {
      for (const [cols, rows] of [
        [10, 5],
        [500, 200],
        [80, 24],
      ] as const) {
        const msg = { type: 'terminal_resize', sessionId: 's-1', cols, rows };
        expect(ClientMessageSchema.parse(msg)).toEqual(msg);
      }
    });

    it.each([
      { cols: 9, rows: 24 },
      { cols: 501, rows: 24 },
      { cols: 80, rows: 4 },
      { cols: 80, rows: 201 },
      { cols: 80.5, rows: 24 },
      { cols: '80', rows: 24 },
      { cols: 80 },
      { rows: 24 },
    ])('rejeita dimensões inválidas %j', (dims) => {
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_resize', sessionId: 's-1', ...dims })
          .success,
      ).toBe(false);
    });

    it('rejeita sessionId vazio', () => {
      expect(
        ClientMessageSchema.safeParse({ type: 'terminal_resize', sessionId: '', cols: 80, rows: 24 })
          .success,
      ).toBe(false);
    });
  });
});

describe('ServerMessageSchema', () => {
  it('aceita hello com machineId e machineName', () => {
    const msg = { type: 'hello', machineId: 'm-1', machineName: 'PC' };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejeita hello sem machineName', () => {
    expect(ServerMessageSchema.safeParse({ type: 'hello', machineId: 'm-1' }).success).toBe(false);
  });

  it('aceita pong', () => {
    expect(ServerMessageSchema.parse({ type: 'pong' })).toEqual({ type: 'pong' });
  });

  it('rejeita type desconhecido', () => {
    expect(ServerMessageSchema.safeParse({ type: 'ping' }).success).toBe(false);
  });

  describe('event', () => {
    it('aceita evento de sessão', () => {
      const msg = { type: 'event', event: eventValue };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('rejeita evento com kind desconhecido', () => {
      expect(
        ServerMessageSchema.safeParse({ type: 'event', event: { ...eventValue, kind: 'nope' } })
          .success,
      ).toBe(false);
    });

    it('rejeita event ausente', () => {
      expect(ServerMessageSchema.safeParse({ type: 'event' }).success).toBe(false);
    });
  });

  describe('session', () => {
    it('aceita sessão', () => {
      const msg = { type: 'session', session: sessionValue };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('rejeita sessão com status inválido', () => {
      expect(
        ServerMessageSchema.safeParse({
          type: 'session',
          session: { ...sessionValue, status: 'done' },
        }).success,
      ).toBe(false);
    });

    it('aceita session sem configOptions (o campo não existe mais na Session)', () => {
      expect(ServerMessageSchema.safeParse({ type: 'session', session: sessionValue }).success).toBe(true);
    });
  });

  describe('commands', () => {
    const commands = [{ name: 'loop', description: 'Repete', hint: null }];

    it('aceita sessionId e a lista de comandos', () => {
      const msg = { type: 'commands', sessionId: 's-1', commands };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita lista vazia (o agente zerou os comandos)', () => {
      expect(ServerMessageSchema.safeParse({ type: 'commands', sessionId: 's-1', commands: [] }).success).toBe(true);
    });

    it('rejeita sem sessionId, sem lista ou com item sem nome', () => {
      expect(ServerMessageSchema.safeParse({ type: 'commands', commands }).success).toBe(false);
      expect(ServerMessageSchema.safeParse({ type: 'commands', sessionId: 's-1' }).success).toBe(false);
      expect(
        ServerMessageSchema.safeParse({ type: 'commands', sessionId: 's-1', commands: [{ name: '', description: 'x', hint: null }] })
          .success,
      ).toBe(false);
    });
  });

  describe('config_options', () => {
    const configOptions = [
      { id: 'model', name: 'Modelo', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
    ];

    it('aceita sessionId e a lista de opções', () => {
      const msg = { type: 'config_options', sessionId: 's-1', configOptions };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita lista vazia', () => {
      expect(ServerMessageSchema.safeParse({ type: 'config_options', sessionId: 's-1', configOptions: [] }).success).toBe(true);
    });

    it('rejeita sem sessionId, sem lista ou com opção inválida', () => {
      expect(ServerMessageSchema.safeParse({ type: 'config_options', configOptions }).success).toBe(false);
      expect(ServerMessageSchema.safeParse({ type: 'config_options', sessionId: 's-1' }).success).toBe(false);
      expect(
        ServerMessageSchema.safeParse({ type: 'config_options', sessionId: 's-1', configOptions: [{ id: 'x', name: 'X' }] })
          .success,
      ).toBe(false);
    });
  });

  describe('session_removed', () => {
    it('aceita sessionId', () => {
      const msg = { type: 'session_removed', sessionId: 's-1' };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('rejeita sem sessionId ou com sessionId vazio', () => {
      expect(ServerMessageSchema.safeParse({ type: 'session_removed' }).success).toBe(false);
      expect(ServerMessageSchema.safeParse({ type: 'session_removed', sessionId: '' }).success).toBe(false);
    });
  });

  describe('error', () => {
    it('aceita message sem sessionId', () => {
      const msg = { type: 'error', message: 'prompt recusado' };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('aceita message com sessionId', () => {
      const msg = { type: 'error', message: 'falhou', sessionId: 's-1' };
      expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    });

    it('rejeita sem message', () => {
      expect(ServerMessageSchema.safeParse({ type: 'error', sessionId: 's-1' }).success).toBe(false);
    });
  });
});

describe('parseClientMessage', () => {
  it('retorna ok com o valor para ping válido', () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({
      ok: true,
      value: { type: 'ping' },
    });
  });

  it('retorna ok com o valor para prompt válido', () => {
    expect(parseClientMessage('{"type":"prompt","sessionId":"s-1","text":"oi"}')).toEqual({
      ok: true,
      value: { type: 'prompt', sessionId: 's-1', text: 'oi' },
    });
  });

  it('retorna erro para JSON inválido sem lançar', () => {
    const result = parseClientMessage('{"type":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual(expect.any(String));
  });

  it('retorna erro para string vazia sem lançar', () => {
    expect(parseClientMessage('').ok).toBe(false);
  });

  it('retorna erro para type desconhecido', () => {
    const result = parseClientMessage('{"type":"nope"}');
    expect(result.ok).toBe(false);
  });

  it('retorna erro quando o JSON é válido mas não é objeto', () => {
    expect(parseClientMessage('"ping"').ok).toBe(false);
    expect(parseClientMessage('null').ok).toBe(false);
  });

  it('retorna erro com mensagem que cita o campo inválido', () => {
    const result = parseClientMessage('{"type":"prompt","sessionId":"s-1","text":""}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('text');
  });

  it('não aceita mensagens do servidor', () => {
    expect(parseClientMessage('{"type":"pong"}').ok).toBe(false);
    expect(parseClientMessage('{"type":"error","message":"x"}').ok).toBe(false);
  });
});

describe('parseServerMessage', () => {
  it('retorna ok para hello válido', () => {
    expect(
      parseServerMessage('{"type":"hello","machineId":"m-1","machineName":"PC"}'),
    ).toEqual({
      ok: true,
      value: { type: 'hello', machineId: 'm-1', machineName: 'PC' },
    });
  });

  it('retorna ok para pong', () => {
    expect(parseServerMessage('{"type":"pong"}')).toEqual({ ok: true, value: { type: 'pong' } });
  });

  it('retorna erro para JSON inválido sem lançar', () => {
    const result = parseServerMessage('não é json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual(expect.any(String));
  });

  it('retorna erro com mensagem que cita o campo inválido', () => {
    const result = parseServerMessage('{"type":"hello","machineId":"m-1"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('machineName');
  });

  it('não aceita mensagens do cliente', () => {
    expect(parseServerMessage('{"type":"ping"}').ok).toBe(false);
    expect(parseServerMessage('{"type":"cancel","sessionId":"s-1"}').ok).toBe(false);
  });
});
