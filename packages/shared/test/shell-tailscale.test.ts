import { describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  CreateSessionRequestSchema,
  DevicePairedPushPayloadSchema,
  SHELL_AGENT_ID,
  ShellIdSchema,
  ShellsResponseSchema,
  SessionEventSchema,
  TailscalePairRequestSchema,
  TailscalePairStatusResponseSchema,
} from '../src/index.js';

describe('shell schemas', () => {
  it('aceita só os quatro shells conhecidos', () => {
    for (const id of ['powershell', 'pwsh', 'cmd', 'bash']) {
      expect(ShellIdSchema.parse(id)).toBe(id);
    }
    expect(ShellIdSchema.safeParse('zsh').success).toBe(false);
    expect(ShellIdSchema.safeParse('/bin/sh').success).toBe(false);
  });

  it('o id reservado do terminal de workspace é "shell"', () => {
    expect(SHELL_AGENT_ID).toBe('shell');
  });

  it('CreateSessionRequest aceita o shell opcional', () => {
    const parsed = CreateSessionRequestSchema.parse({ workspaceId: 'w-1', agent: 'shell', shell: 'cmd' });
    expect(parsed.shell).toBe('cmd');
    expect(CreateSessionRequestSchema.safeParse({ workspaceId: 'w-1', agent: 'shell', shell: 'zsh' }).success).toBe(false);
  });

  it('GET /api/shells lista id, rótulo e qual é o padrão', () => {
    const body = ShellsResponseSchema.parse({
      shells: [
        { id: 'pwsh', label: 'PowerShell', isDefault: true },
        { id: 'cmd', label: 'cmd.exe', isDefault: false },
      ],
    });
    expect(body.shells).toHaveLength(2);
    expect(ShellsResponseSchema.safeParse({ shells: [{ id: 'pwsh', label: '', isDefault: true }] }).success).toBe(false);
  });

  it('terminal_exit aceita reason "reload" e exitCode null (shell encerrado pelo reload)', () => {
    const event = SessionEventSchema.parse({
      seq: 9,
      sessionId: 's-1',
      ts: 1,
      kind: 'terminal_exit',
      exitCode: null,
      reason: 'reload',
    });
    expect(event.kind === 'terminal_exit' && event.reason).toBe('reload');
    // Evento antigo, sem reason, continua valendo.
    expect(
      SessionEventSchema.safeParse({ seq: 10, sessionId: 's-1', ts: 1, kind: 'terminal_exit', exitCode: 0 }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({ seq: 10, sessionId: 's-1', ts: 1, kind: 'terminal_exit', exitCode: 0, reason: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('config', () => {
  it('shellSessions liga por padrão e tailscaleAutoPair desliga', () => {
    const config = ConfigSchema.parse({});
    expect(config.shellSessions).toBe(true);
    expect(config.tailscaleAutoPair).toBe(false);
  });

  it('aceita os dois flags explícitos', () => {
    const config = ConfigSchema.parse({ shellSessions: false, tailscaleAutoPair: true });
    expect(config.shellSessions).toBe(false);
    expect(config.tailscaleAutoPair).toBe(true);
  });
});

describe('Entrar com Tailscale', () => {
  it('status: available é obrigatório; login só vem junto', () => {
    expect(TailscalePairStatusResponseSchema.parse({ available: false })).toEqual({ available: false });
    expect(TailscalePairStatusResponseSchema.parse({ available: true, login: 'jose@exemplo.com' })).toEqual({
      available: true,
      login: 'jose@exemplo.com',
    });
    expect(TailscalePairStatusResponseSchema.safeParse({ login: 'x' }).success).toBe(false);
  });

  it('pedido: deviceName de 1 a 64 caracteres', () => {
    expect(TailscalePairRequestSchema.parse({ deviceName: 'iPhone' })).toEqual({ deviceName: 'iPhone' });
    expect(TailscalePairRequestSchema.safeParse({ deviceName: '' }).success).toBe(false);
    expect(TailscalePairRequestSchema.safeParse({ deviceName: 'x'.repeat(65) }).success).toBe(false);
    expect(TailscalePairRequestSchema.safeParse({}).success).toBe(false);
  });

  it('payload de push de pareamento não tem campos de sessão', () => {
    const payload = DevicePairedPushPayloadSchema.parse({
      title: 'Nanachi Remote',
      body: 'Novo aparelho entrou com Tailscale: iPhone',
      machineId: 'm-1',
      kind: 'device_paired',
    });
    expect(payload.kind).toBe('device_paired');
    expect(
      DevicePairedPushPayloadSchema.safeParse({
        title: 't',
        body: 'b',
        machineId: 'm-1',
        kind: 'turn_end',
      }).success,
    ).toBe(false);
  });
});
