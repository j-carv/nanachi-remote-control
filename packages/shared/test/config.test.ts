import { describe, expect, it } from 'vitest';
import { AgentConfigSchema, ConfigSchema, DEFAULT_AGENTS } from '../src/index.js';

describe('ConfigSchema', () => {
  it('aplica os defaults do PLAN.md a um objeto vazio', () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed).toEqual({
      port: 7777,
      host: '127.0.0.1',
      allowedRoots: [],
      allowedTailscaleLogins: [],
      corsOrigins: [],
      tailscaleAutoPair: false,
      shellSessions: true,
      reloadQuietMs: 60000,
      deviceInactivityDays: 90,
      agents: {
        omp: { label: 'Oh My Pi', command: 'omp', args: ['acp'], env: {}, kind: 'acp' },
        claude: { label: 'Claude Code', command: 'claude-agent-acp', args: [], env: {}, kind: 'acp' },
        codex: { label: 'Codex', command: 'codex-acp', args: [], env: {}, kind: 'acp' },
        agy: { label: 'Antigravity', command: 'agy', args: ['acp'], env: {}, kind: 'acp' },
      },
    });
  });

  it('deviceInactivityDays: padrão 90, aceita 0 (desliga) e inteiros positivos', () => {
    expect(ConfigSchema.parse({}).deviceInactivityDays).toBe(90);
    expect(ConfigSchema.parse({ deviceInactivityDays: 0 }).deviceInactivityDays).toBe(0);
    expect(ConfigSchema.parse({ deviceInactivityDays: 30 }).deviceInactivityDays).toBe(30);
  });

  it.each([-1, 1.5, '90', null])('deviceInactivityDays: rejeita %s', (value) => {
    expect(ConfigSchema.safeParse({ deviceInactivityDays: value }).success).toBe(false);
  });

  it('DEFAULT_AGENTS traz codex e agy (ACP, via agy acp) além de omp e claude', () => {
    expect(DEFAULT_AGENTS.codex).toEqual({
      label: 'Codex',
      command: 'codex-acp',
      args: [],
      env: {},
      kind: 'acp',
    });
    expect(DEFAULT_AGENTS.agy).toEqual({
      label: 'Antigravity',
      kind: 'acp',
      command: 'agy',
      args: ['acp'],
      env: {},
    });
    expect(DEFAULT_AGENTS.omp?.kind).toBe('acp');
    expect(DEFAULT_AGENTS.claude?.kind).toBe('acp');
  });

  it('não exige machineName (o daemon preenche com o hostname)', () => {
    expect(ConfigSchema.safeParse({}).success).toBe(true);
    expect(ConfigSchema.parse({ machineName: 'PC-SALA' }).machineName).toBe('PC-SALA');
  });

  it('aceita valores explícitos válidos', () => {
    const parsed = ConfigSchema.parse({
      port: 8080,
      host: 'localhost',
      machineName: 'PC',
      allowedRoots: ['C:\\projetos'],
      allowedTailscaleLogins: ['jose@example.com'],
      corsOrigins: ['https://app.example.com'],
    });
    expect(parsed.port).toBe(8080);
    expect(parsed.allowedRoots).toEqual(['C:\\projetos']);
  });

  it.each([0, 65536, -1, 1.5, '7777'])('rejeita porta inválida: %s', (port) => {
    expect(ConfigSchema.safeParse({ port }).success).toBe(false);
  });

  it.each(['127.0.0.1', '::1', 'localhost'])('aceita host loopback %s', (host) => {
    expect(ConfigSchema.parse({ host }).host).toBe(host);
  });

  it.each(['0.0.0.0', '::', '192.168.0.10', 'pc-sala.ts.net', ''])(
    'rejeita host exposto ou inválido %j (o daemon só fica acessível via tailscale serve)',
    (host) => {
      expect(ConfigSchema.safeParse({ host }).success).toBe(false);
    },
  );

  it('rejeita machineName vazio quando informado', () => {
    expect(ConfigSchema.safeParse({ machineName: '' }).success).toBe(false);
  });

  it('rejeita listas com tipos errados', () => {
    expect(ConfigSchema.safeParse({ allowedRoots: 'C:\\' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ corsOrigins: [1] }).success).toBe(false);
  });

  it('aceita agents explícito e substitui o default', () => {
    const parsed = ConfigSchema.parse({
      agents: { claude: { label: 'Claude Code', command: 'claude-agent-acp' } },
    });
    expect(parsed.agents).toEqual({
      claude: { label: 'Claude Code', command: 'claude-agent-acp', args: [], env: {}, kind: 'acp' },
    });
  });

  it('rejeita agente sem command ou com args de tipo errado', () => {
    expect(ConfigSchema.safeParse({ agents: { omp: { label: 'Oh My Pi' } } }).success).toBe(false);
    expect(
      ConfigSchema.safeParse({ agents: { omp: { label: 'Oh My Pi', command: 'omp', args: 'acp' } } })
        .success,
    ).toBe(false);
  });
});

describe('AgentConfigSchema', () => {
  it('aplica defaults de args e env', () => {
    expect(AgentConfigSchema.parse({ label: 'Oh My Pi', command: 'omp' })).toEqual({
      label: 'Oh My Pi',
      command: 'omp',
      args: [],
      env: {},
      kind: 'acp',
    });
  });

  it('aplica kind acp por default', () => {
    expect(AgentConfigSchema.parse({ label: 'Oh My Pi', command: 'omp' }).kind).toBe('acp');
  });

  it.each(['acp', 'pty'] as const)('aceita kind %s', (kind) => {
    expect(AgentConfigSchema.parse({ label: 'X', command: 'x', kind }).kind).toBe(kind);
  });

  it.each(['rpc', '', 'ACP'])('rejeita kind inválido %j', (kind) => {
    expect(AgentConfigSchema.safeParse({ label: 'X', command: 'x', kind }).success).toBe(false);
  });

  it('aceita args e env explícitos', () => {
    const agent = { label: 'Oh My Pi', command: 'omp', args: ['acp'], env: { FOO: 'bar' }, kind: 'acp' };
    expect(AgentConfigSchema.parse(agent)).toEqual(agent);
  });

  it.each([
    { label: '', command: 'omp' },
    { label: 'Oh My Pi', command: '' },
    { command: 'omp' },
    { label: 'Oh My Pi' },
    { label: 'Oh My Pi', command: 'omp', env: { FOO: 1 } },
    { label: 'Oh My Pi', command: 'omp', args: [1] },
  ])('rejeita agente inválido %j', (agent) => {
    expect(AgentConfigSchema.safeParse(agent).success).toBe(false);
  });
});
