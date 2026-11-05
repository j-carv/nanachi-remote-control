import { describe, expect, it } from 'vitest';
import {
  AgentSessionsResponseSchema,
  AgentsResponseSchema,
  CommandsResponseSchema,
  ConfigOptionsResponseSchema,
  AttachmentResponseSchema,
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  DevicesResponseSchema,
  ErrorResponseSchema,
  EventsResponseSchema,
  FsListResponseSchema,
  GitBranchesResponseSchema,
  GitCheckoutRequestSchema,
  HealthResponseSchema,
  MeResponseSchema,
  PairRequestSchema,
  PairResponseSchema,
  PushKeyResponseSchema,
  PushSubscriptionRequestSchema,
  PushUnsubscribeRequestSchema,
  ResetEntrySchema,
  ResetRedeemRequestSchema,
  ResetRedeemResponseSchema,
  ResetsResponseSchema,
  RootsResponseSchema,
  SessionDiffResponseSchema,
  SessionsResponseSchema,
  UpdateWorkspaceRequestSchema,
  UsageResponseSchema,
  WorkspaceEntriesResponseSchema,
  WorkspaceFileResponseSchema,
  WorkspaceFileWriteRequestSchema,
  WorkspaceFileWriteResponseSchema,
  WorkspaceInfoResponseSchema,
  WorkspaceMkdirRequestSchema,
  WorkspaceRenameRequestSchema,
  WorkspacesResponseSchema,
} from '../src/index.js';

describe('HealthResponseSchema', () => {
  const valid = { ok: true, machineId: 'm-1', machineName: 'PC', version: '0.0.0' };

  it('aceita a resposta de /api/health', () => {
    expect(HealthResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejeita ok diferente de true', () => {
    expect(HealthResponseSchema.safeParse({ ...valid, ok: false }).success).toBe(false);
  });

  it('rejeita campos ausentes', () => {
    const { version: _version, ...withoutVersion } = valid;
    expect(HealthResponseSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe('PairRequestSchema', () => {
  it('aceita código de 6 dígitos e nome de dispositivo', () => {
    expect(PairRequestSchema.parse({ code: '000123', deviceName: 'iPhone do João' })).toEqual({
      code: '000123',
      deviceName: 'iPhone do João',
    });
  });

  it.each(['12345', '1234567', '12345a', ' 123456', '', '12 456', '١٢٣٤٥٦'])(
    'rejeita código inválido: %j',
    (code) => {
      expect(PairRequestSchema.safeParse({ code, deviceName: 'x' }).success).toBe(false);
    },
  );

  it('rejeita code que não é string', () => {
    expect(PairRequestSchema.safeParse({ code: 123456, deviceName: 'x' }).success).toBe(false);
  });

  it('rejeita deviceName vazio', () => {
    expect(PairRequestSchema.safeParse({ code: '123456', deviceName: '' }).success).toBe(false);
  });

  it('aceita deviceName com exatamente 64 caracteres', () => {
    expect(
      PairRequestSchema.safeParse({ code: '123456', deviceName: 'a'.repeat(64) }).success,
    ).toBe(true);
  });

  it('rejeita deviceName com mais de 64 caracteres', () => {
    expect(
      PairRequestSchema.safeParse({ code: '123456', deviceName: 'a'.repeat(65) }).success,
    ).toBe(false);
  });
});

describe('PairResponseSchema', () => {
  it('aceita a resposta de /api/pair', () => {
    const body = { token: 'tok', deviceId: 'd-1', machineId: 'm-1', machineName: 'PC' };
    expect(PairResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita token ausente', () => {
    expect(
      PairResponseSchema.safeParse({ deviceId: 'd', machineId: 'm', machineName: 'PC' }).success,
    ).toBe(false);
  });
});

describe('MeResponseSchema', () => {
  it('aceita a resposta de /api/me', () => {
    const body = { deviceId: 'd-1', deviceName: 'iPhone', machineId: 'm-1', machineName: 'PC' };
    expect(MeResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita deviceName vazio', () => {
    expect(
      MeResponseSchema.safeParse({
        deviceId: 'd',
        deviceName: '',
        machineId: 'm',
        machineName: 'PC',
      }).success,
    ).toBe(false);
  });
});

const workspace = {
  id: 'w-1',
  name: 'app',
  path: 'C:\\projetos\\app',
  createdAt: 1_700_000_000_000,
  muted: false,
};

const session = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'starting',
  accountId: null,
  worktree: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('RootsResponseSchema', () => {
  it('aceita a lista de raízes permitidas', () => {
    const body = { roots: [{ path: 'C:\\projetos', name: 'projetos' }] };
    expect(RootsResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita lista vazia', () => {
    expect(RootsResponseSchema.safeParse({ roots: [] }).success).toBe(true);
  });

  it('rejeita raiz sem name', () => {
    expect(RootsResponseSchema.safeParse({ roots: [{ path: 'C:\\' }] }).success).toBe(false);
  });

  it('rejeita roots que não é array', () => {
    expect(RootsResponseSchema.safeParse({ roots: 'C:\\' }).success).toBe(false);
  });
});

describe('FsListResponseSchema', () => {
  it('aceita listagem com parent string', () => {
    const body = {
      path: 'C:\\projetos\\app',
      parent: 'C:\\projetos',
      dirs: [{ name: 'src', path: 'C:\\projetos\\app\\src' }],
    };
    expect(FsListResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita parent null na raiz permitida', () => {
    const body = { path: 'C:\\projetos', parent: null, dirs: [] };
    expect(FsListResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita parent ausente (precisa ser string ou null)', () => {
    expect(
      FsListResponseSchema.safeParse({ path: 'C:\\projetos', dirs: [] }).success,
    ).toBe(false);
  });

  it('rejeita entrada de dirs sem path', () => {
    expect(
      FsListResponseSchema.safeParse({
        path: 'C:\\',
        parent: null,
        dirs: [{ name: 'src' }],
      }).success,
    ).toBe(false);
  });
});

describe('AgentsResponseSchema', () => {
  it('aceita a lista de agentes configurados', () => {
    const body = { agents: [{ id: 'omp', label: 'Oh My Pi', kind: 'acp' }] };
    expect(AgentsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita agente sem label', () => {
    expect(AgentsResponseSchema.safeParse({ agents: [{ id: 'omp' }] }).success).toBe(false);
  });

  it('cada agente traz kind (acp ou pty)', () => {
    const body = {
      agents: [
        { id: 'omp', label: 'Oh My Pi', kind: 'acp' },
        { id: 'agy', label: 'Antigravity', kind: 'pty' },
      ],
    };
    expect(AgentsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita agente sem kind ou com kind desconhecido', () => {
    expect(
      AgentsResponseSchema.safeParse({ agents: [{ id: 'omp', label: 'Oh My Pi' }] }).success,
    ).toBe(false);
    expect(
      AgentsResponseSchema.safeParse({ agents: [{ id: 'omp', label: 'Oh My Pi', kind: 'rpc' }] })
        .success,
    ).toBe(false);
  });
});

describe('WorkspacesResponseSchema', () => {
  it('aceita lista de workspaces (vazia ou não)', () => {
    expect(WorkspacesResponseSchema.parse({ workspaces: [] })).toEqual({ workspaces: [] });
    expect(WorkspacesResponseSchema.parse({ workspaces: [workspace] })).toEqual({
      workspaces: [workspace],
    });
  });

  it('rejeita workspace inválido dentro da lista', () => {
    expect(
      WorkspacesResponseSchema.safeParse({ workspaces: [{ ...workspace, path: '' }] }).success,
    ).toBe(false);
  });
});

describe('CreateWorkspaceRequestSchema', () => {
  it('aceita só path', () => {
    expect(CreateWorkspaceRequestSchema.parse({ path: 'C:\\projetos\\app' })).toEqual({
      path: 'C:\\projetos\\app',
    });
  });

  it('aceita path com name', () => {
    expect(CreateWorkspaceRequestSchema.parse({ path: 'C:\\app', name: 'App' })).toEqual({
      path: 'C:\\app',
      name: 'App',
    });
  });

  it('rejeita path vazio ou ausente', () => {
    expect(CreateWorkspaceRequestSchema.safeParse({ path: '' }).success).toBe(false);
    expect(CreateWorkspaceRequestSchema.safeParse({ name: 'App' }).success).toBe(false);
  });

  it('rejeita name vazio quando informado', () => {
    expect(CreateWorkspaceRequestSchema.safeParse({ path: 'C:\\app', name: '' }).success).toBe(
      false,
    );
  });
});

describe('SessionsResponseSchema', () => {
  it('aceita lista de sessões', () => {
    expect(SessionsResponseSchema.parse({ sessions: [session] })).toEqual({ sessions: [session] });
  });

  it('rejeita sessão com status inválido', () => {
    expect(
      SessionsResponseSchema.safeParse({ sessions: [{ ...session, status: 'done' }] }).success,
    ).toBe(false);
  });
});

describe('CreateSessionRequestSchema', () => {
  it('aceita workspaceId e agent', () => {
    const body = { workspaceId: 'w-1', agent: 'omp' };
    expect(CreateSessionRequestSchema.parse(body)).toEqual(body);
  });

  it('aceita config com string e boolean', () => {
    const body = { workspaceId: 'w-1', agent: 'omp', config: { model: 'opus', fast: true } };
    expect(CreateSessionRequestSchema.parse(body)).toEqual(body);
  });

  it('aceita config vazio', () => {
    expect(
      CreateSessionRequestSchema.safeParse({ workspaceId: 'w-1', agent: 'omp', config: {} }).success,
    ).toBe(true);
  });

  it('rejeita config com valor que não é string nem boolean', () => {
    expect(
      CreateSessionRequestSchema.safeParse({
        workspaceId: 'w-1',
        agent: 'omp',
        config: { effort: 3 },
      }).success,
    ).toBe(false);
    expect(
      CreateSessionRequestSchema.safeParse({
        workspaceId: 'w-1',
        agent: 'omp',
        config: { model: null },
      }).success,
    ).toBe(false);
  });

  it('rejeita agent ausente', () => {
    expect(CreateSessionRequestSchema.safeParse({ workspaceId: 'w-1' }).success).toBe(false);
  });

  it('rejeita workspaceId vazio', () => {
    expect(CreateSessionRequestSchema.safeParse({ workspaceId: '', agent: 'omp' }).success).toBe(
      false,
    );
  });

  it('aceita worktree true e false (opcional)', () => {
    expect(
      CreateSessionRequestSchema.parse({ workspaceId: 'w-1', agent: 'omp', worktree: true }),
    ).toEqual({ workspaceId: 'w-1', agent: 'omp', worktree: true });
    expect(
      CreateSessionRequestSchema.parse({ workspaceId: 'w-1', agent: 'omp', worktree: false }),
    ).toEqual({ workspaceId: 'w-1', agent: 'omp', worktree: false });
  });

  it('rejeita worktree que não é boolean', () => {
    expect(
      CreateSessionRequestSchema.safeParse({ workspaceId: 'w-1', agent: 'omp', worktree: 'yes' })
        .success,
    ).toBe(false);
  });
});

describe('ConfigOptionsResponseSchema', () => {
  it('aceita a lista de opções (vazia ou com itens)', () => {
    expect(ConfigOptionsResponseSchema.parse({ configOptions: [] })).toEqual({ configOptions: [] });
    const configOptions = [{ id: 'mode', name: 'Acesso', type: 'boolean', currentValue: true }];
    expect(ConfigOptionsResponseSchema.parse({ configOptions })).toEqual({ configOptions });
  });

  it('rejeita configOptions ausente ou opção inválida', () => {
    expect(ConfigOptionsResponseSchema.safeParse({}).success).toBe(false);
    expect(ConfigOptionsResponseSchema.safeParse({ configOptions: [{ id: 'x', name: 'X' }] }).success).toBe(false);
  });
});

describe('CommandsResponseSchema', () => {
  it('aceita a lista de comandos (vazia ou com itens)', () => {
    expect(CommandsResponseSchema.parse({ commands: [] })).toEqual({ commands: [] });
    const commands = [{ name: 'loop', description: 'Repete', hint: '[intervalo] [prompt]' }];
    expect(CommandsResponseSchema.parse({ commands })).toEqual({ commands });
  });

  it('rejeita commands ausente ou item sem nome', () => {
    expect(CommandsResponseSchema.safeParse({}).success).toBe(false);
    expect(CommandsResponseSchema.safeParse({ commands: [{ description: 'x', hint: null }] }).success).toBe(false);
  });
});

describe('EventsResponseSchema', () => {
  const event = {
    seq: 1,
    sessionId: 's-1',
    ts: 1_700_000_000_000,
    kind: 'user_message',
    text: 'oi',
  };

  it('aceita lista vazia e lista com eventos', () => {
    expect(EventsResponseSchema.parse({ events: [] })).toEqual({ events: [] });
    expect(EventsResponseSchema.parse({ events: [event] })).toEqual({ events: [event] });
  });

  it('rejeita evento com kind desconhecido', () => {
    expect(
      EventsResponseSchema.safeParse({ events: [{ ...event, kind: 'nope' }] }).success,
    ).toBe(false);
  });
});

describe('UpdateWorkspaceRequestSchema', () => {
  it('aceita muted boolean', () => {
    expect(UpdateWorkspaceRequestSchema.parse({ muted: true })).toEqual({ muted: true });
    expect(UpdateWorkspaceRequestSchema.parse({ muted: false })).toEqual({ muted: false });
  });

  it.each([{}, { muted: 'sim' }, { muted: 1 }, { muted: null }])('rejeita corpo inválido %j', (body) => {
    expect(UpdateWorkspaceRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('AttachmentResponseSchema', () => {
  it('aceita FileInfo de anexo gravado', () => {
    const body = { fileId: 'f-1', name: 'print.png', mime: 'image/png', size: 2048 };
    expect(AttachmentResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita resposta sem size', () => {
    expect(
      AttachmentResponseSchema.safeParse({ fileId: 'f-1', name: 'a.txt', mime: 'text/plain' })
        .success,
    ).toBe(false);
  });
});

describe('PushKeyResponseSchema', () => {
  it('aceita publicKey', () => {
    expect(PushKeyResponseSchema.parse({ publicKey: 'BNcRd' })).toEqual({ publicKey: 'BNcRd' });
  });

  it('rejeita publicKey vazia ou ausente', () => {
    expect(PushKeyResponseSchema.safeParse({ publicKey: '' }).success).toBe(false);
    expect(PushKeyResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('PushSubscriptionRequestSchema', () => {
  const valid = {
    endpoint: 'https://web.push.apple.com/QGb4',
    keys: { p256dh: 'BPk3', auth: 'x9Lw' },
  };

  it('aceita endpoint https com keys', () => {
    expect(PushSubscriptionRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejeita endpoint que não é URL', () => {
    expect(PushSubscriptionRequestSchema.safeParse({ ...valid, endpoint: 'nao-url' }).success).toBe(
      false,
    );
  });

  it('rejeita keys incompletas', () => {
    expect(
      PushSubscriptionRequestSchema.safeParse({ ...valid, keys: { p256dh: 'BPk3' } }).success,
    ).toBe(false);
    expect(
      PushSubscriptionRequestSchema.safeParse({ ...valid, keys: { p256dh: '', auth: 'x' } }).success,
    ).toBe(false);
  });

  it('rejeita keys ausente', () => {
    expect(PushSubscriptionRequestSchema.safeParse({ endpoint: valid.endpoint }).success).toBe(false);
  });
});

describe('PushUnsubscribeRequestSchema', () => {
  it('aceita endpoint URL', () => {
    const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' };
    expect(PushUnsubscribeRequestSchema.parse(body)).toEqual(body);
  });

  it('rejeita endpoint ausente ou não URL', () => {
    expect(PushUnsubscribeRequestSchema.safeParse({}).success).toBe(false);
    expect(PushUnsubscribeRequestSchema.safeParse({ endpoint: 'abc' }).success).toBe(false);
  });
});

describe('WorkspaceInfoResponseSchema', () => {
  const info = { branch: 'main', changedFiles: 3, instructions: ['CLAUDE.md', 'AGENTS.md'] };

  it('aceita info de repositório git', () => {
    expect(WorkspaceInfoResponseSchema.parse(info)).toEqual(info);
  });

  it('aceita workspace não-git: branch e changedFiles null, sem instruções', () => {
    const body = { branch: null, changedFiles: null, instructions: [] };
    expect(WorkspaceInfoResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita changedFiles 0 (árvore limpa)', () => {
    expect(WorkspaceInfoResponseSchema.safeParse({ ...info, changedFiles: 0 }).success).toBe(true);
  });

  it.each([
    { changedFiles: -1 },
    { changedFiles: 1.5 },
    { changedFiles: '3' },
    { branch: 3 },
    { instructions: 'CLAUDE.md' },
    { instructions: [1] },
  ])('rejeita info inválida %j', (patch) => {
    expect(WorkspaceInfoResponseSchema.safeParse({ ...info, ...patch }).success).toBe(false);
  });

  it('rejeita campo ausente', () => {
    const { instructions: _instructions, ...withoutInstructions } = info;
    expect(WorkspaceInfoResponseSchema.safeParse(withoutInstructions).success).toBe(false);
  });
});

describe('SessionDiffResponseSchema', () => {
  const file = {
    path: 'src/a.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1 +1,2 @@\n-a\n+b\n+c\n',
  };

  it('aceita diff com arquivos', () => {
    const body = { files: [file], truncated: false };
    expect(SessionDiffResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita diff vazio (sem alterações ou não-git)', () => {
    expect(SessionDiffResponseSchema.parse({ files: [], truncated: false })).toEqual({
      files: [],
      truncated: false,
    });
  });

  const diffWith = (fileFields: Record<string, unknown>) =>
    SessionDiffResponseSchema.safeParse({ files: [{ ...file, ...fileFields }], truncated: false })
      .success;

  it.each(['added', 'modified', 'deleted', 'renamed'])('aceita status %s', (status) => {
    expect(diffWith({ status })).toBe(true);
  });

  it.each(['copied', 'unmodified', ''])('rejeita status inválido %j', (status) => {
    expect(diffWith({ status })).toBe(false);
  });

  it.each([{ additions: -1 }, { deletions: 1.5 }, { additions: '2' }, { path: '' }])(
    'rejeita arquivo inválido %j',
    (fields) => {
      expect(diffWith(fields)).toBe(false);
    },
  );

  it('rejeita arquivo sem patch', () => {
    const { patch: _patch, ...withoutPatch } = file;
    expect(
      SessionDiffResponseSchema.safeParse({ files: [withoutPatch], truncated: false }).success,
    ).toBe(false);
  });

  it('rejeita truncated ausente', () => {
    expect(SessionDiffResponseSchema.safeParse({ files: [] }).success).toBe(false);
  });
});

describe('DevicesResponseSchema', () => {
  const device = {
    id: 'd-1',
    name: 'iPhone',
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_500_000,
    current: true,
  };

  it('aceita lista de dispositivos', () => {
    const body = { devices: [device, { ...device, id: 'd-2', current: false }] };
    expect(DevicesResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita lista vazia', () => {
    expect(DevicesResponseSchema.parse({ devices: [] })).toEqual({ devices: [] });
  });

  it('aceita lastSeenAt null (dispositivo que nunca usou a API)', () => {
    const body = { devices: [{ ...device, lastSeenAt: null }] };
    expect(DevicesResponseSchema.parse(body).devices[0]?.lastSeenAt).toBeNull();
  });

  it.each([
    { lastSeenAt: 1.5 },
    { lastSeenAt: '2024' },
    { createdAt: -1 },
    { name: '' },
    { current: 'yes' },
  ])('rejeita dispositivo inválido %j', (patch) => {
    expect(DevicesResponseSchema.safeParse({ devices: [{ ...device, ...patch }] }).success).toBe(
      false,
    );
  });

  it('rejeita lastSeenAt ausente (o daemon sempre envia, mesmo null)', () => {
    const { lastSeenAt: _lastSeenAt, ...withoutLastSeen } = device;
    expect(DevicesResponseSchema.safeParse({ devices: [withoutLastSeen] }).success).toBe(false);
  });

  it('rejeita current ausente', () => {
    const { current: _current, ...withoutCurrent } = device;
    expect(DevicesResponseSchema.safeParse({ devices: [withoutCurrent] }).success).toBe(false);
  });
});

describe('AgentSessionsResponseSchema', () => {
  const listed = {
    acpSessionId: 'sess-1',
    title: 'Refatorar parser',
    updatedAt: 1_700_000_000_000,
    linkedSessionId: null,
  };

  it('aceita a listagem com sessões, título, data e cursor', () => {
    const body = { supported: true, sessions: [listed], nextCursor: 'p2' };
    expect(AgentSessionsResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita agente sem suporte (lista vazia, sem cursor)', () => {
    const body = { supported: false, sessions: [], nextCursor: null };
    expect(AgentSessionsResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita título e data nulos e linkedSessionId preenchido', () => {
    const body = {
      supported: true,
      sessions: [{ ...listed, title: null, updatedAt: null, linkedSessionId: 's-1' }],
      nextCursor: null,
    };
    expect(AgentSessionsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita supported ausente e nextCursor vazio', () => {
    expect(AgentSessionsResponseSchema.safeParse({ sessions: [], nextCursor: null }).success).toBe(false);
    expect(
      AgentSessionsResponseSchema.safeParse({ supported: true, sessions: [], nextCursor: '' }).success,
    ).toBe(false);
  });

  it('rejeita updatedAt em texto (o daemon converte o ISO para ms)', () => {
    expect(
      AgentSessionsResponseSchema.safeParse({
        supported: true,
        sessions: [{ ...listed, updatedAt: '2026-11-03T10:00:00Z' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('CreateSessionRequestSchema com retomada do PC', () => {
  it('aceita resumeAcpSessionId e resumeTitle junto com config', () => {
    const body = {
      workspaceId: 'w-1',
      agent: 'claude',
      resumeAcpSessionId: 'sess-1',
      resumeTitle: 'Refatorar parser',
      config: { model: 'opus' },
    };
    expect(CreateSessionRequestSchema.parse(body)).toEqual(body);
  });

  it('resumeAcpSessionId vazio é inválido', () => {
    expect(
      CreateSessionRequestSchema.safeParse({ workspaceId: 'w-1', agent: 'claude', resumeAcpSessionId: '' })
        .success,
    ).toBe(false);
  });

  it('resumeTitle vazio é inválido', () => {
    expect(
      CreateSessionRequestSchema.safeParse({
        workspaceId: 'w-1',
        agent: 'claude',
        resumeAcpSessionId: 'sess-1',
        resumeTitle: '',
      }).success,
    ).toBe(false);
  });
});

describe('UsageResponseSchema', () => {
  const body = { agent: 'claude', text: '## Usage\n5-hour limit 10%', fetchedAt: 1_700_000_000_000 };

  it('aceita a resposta de /usage com o texto cru (ANSI incluso)', () => {
    const raw = { ...body, text: '\u001b[38;2;156;163;176m██\u001b[39m 62%' };
    expect(UsageResponseSchema.parse(raw)).toEqual(raw);
  });

  it('aceita texto vazio', () => {
    expect(UsageResponseSchema.safeParse({ ...body, text: '' }).success).toBe(true);
  });

  it('rejeita agente vazio', () => {
    expect(UsageResponseSchema.safeParse({ ...body, agent: '' }).success).toBe(false);
  });

  it('rejeita fetchedAt fracionado ou negativo', () => {
    expect(UsageResponseSchema.safeParse({ ...body, fetchedAt: 1.5 }).success).toBe(false);
    expect(UsageResponseSchema.safeParse({ ...body, fetchedAt: -1 }).success).toBe(false);
  });

  it('rejeita campo ausente', () => {
    const { text: _text, ...withoutText } = body;
    expect(UsageResponseSchema.safeParse(withoutText).success).toBe(false);
  });

  it('aceita cached: true (resposta do cache) e omitido (leitura nova)', () => {
    expect(UsageResponseSchema.parse({ ...body, cached: true })).toEqual({ ...body, cached: true });
    expect(UsageResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita cached com outro valor', () => {
    expect(UsageResponseSchema.safeParse({ ...body, cached: false }).success).toBe(false);
  });
});

describe('ResetEntrySchema', () => {
  const entry = {
    target: 'anthropic/1',
    accountLabel: 'fake@example.com · Org',
    providerLabel: 'Anthropic',
    available: 2,
    usable: 1,
    expiresAt: 'in 3 days',
    note: 'exhausted',
    active: true,
  };

  it('aceita uma entrada completa', () => {
    expect(ResetEntrySchema.parse(entry)).toEqual(entry);
  });

  it('aceita providerLabel, expiresAt e note nulos', () => {
    const plain = { ...entry, providerLabel: null, expiresAt: null, note: null, active: false };
    expect(ResetEntrySchema.parse(plain)).toEqual(plain);
  });

  it('rejeita contagens negativas ou fracionárias', () => {
    expect(ResetEntrySchema.safeParse({ ...entry, available: -1 }).success).toBe(false);
    expect(ResetEntrySchema.safeParse({ ...entry, usable: 1.5 }).success).toBe(false);
  });

  it('rejeita target vazio ou com mais de 200 caracteres', () => {
    expect(ResetEntrySchema.safeParse({ ...entry, target: '' }).success).toBe(false);
    expect(ResetEntrySchema.safeParse({ ...entry, target: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejeita active fora de boolean', () => {
    expect(ResetEntrySchema.safeParse({ ...entry, active: 'yes' }).success).toBe(false);
  });
});

describe('ResetsResponseSchema', () => {
  const entry = {
    target: 'openai-codex/next',
    accountLabel: 'Conta',
    providerLabel: 'OpenAI Codex',
    available: 1,
    usable: 1,
    expiresAt: null,
    note: null,
    active: true,
  };
  const body = { agent: 'omp', entries: [entry], message: null, fetchedAt: 1_700_000_000_000 };

  it('aceita a lista com entradas', () => {
    expect(ResetsResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita lista vazia com a mensagem do agente', () => {
    const empty = { ...body, entries: [], message: 'No provider accounts found. Use /login to add one.' };
    expect(ResetsResponseSchema.parse(empty)).toEqual(empty);
  });

  it('aceita cached: true (resposta do cache) e omitido (leitura nova)', () => {
    expect(ResetsResponseSchema.parse({ ...body, cached: true })).toEqual({ ...body, cached: true });
    expect(ResetsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita cached com outro valor', () => {
    expect(ResetsResponseSchema.safeParse({ ...body, cached: false }).success).toBe(false);
  });

  it('rejeita entradas com formato inválido', () => {
    expect(ResetsResponseSchema.safeParse({ ...body, entries: [{ target: 'x' }] }).success).toBe(false);
  });
});

describe('ResetRedeemRequestSchema', () => {
  it('aceita um target não vazio', () => {
    expect(ResetRedeemRequestSchema.parse({ target: 'anthropic/1' })).toEqual({ target: 'anthropic/1' });
  });

  it('rejeita target ausente, vazio ou longo demais', () => {
    expect(ResetRedeemRequestSchema.safeParse({}).success).toBe(false);
    expect(ResetRedeemRequestSchema.safeParse({ target: '' }).success).toBe(false);
    expect(ResetRedeemRequestSchema.safeParse({ target: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('ResetRedeemResponseSchema', () => {
  it('aceita cada resultado possível', () => {
    for (const outcome of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed', 'failed']) {
      const body = { outcome, message: 'Reset applied for fake@example.com (Anthropic).' };
      expect(ResetRedeemResponseSchema.parse(body)).toEqual(body);
    }
  });

  it('rejeita resultado fora da lista', () => {
    expect(ResetRedeemResponseSchema.safeParse({ outcome: 'nothingToReset', message: '' }).success).toBe(false);
  });
});

describe('ErrorResponseSchema', () => {
  it('aceita só o código de erro', () => {
    expect(ErrorResponseSchema.parse({ error: 'not_found' })).toEqual({ error: 'not_found' });
  });

  it('aceita details com dados extras (ex.: arquivos sujos)', () => {
    const body = { error: 'dirty_worktree', details: { dirty: ['a.txt'] } };
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('rejeita código vazio', () => {
    expect(ErrorResponseSchema.safeParse({ error: '' }).success).toBe(false);
  });
});

describe('GitBranchesResponseSchema', () => {
  const branch = { name: 'main', current: true, upstream: 'origin/main', lastCommitAt: 1_700_000_000_000 };

  it('aceita branch atual, lista e alterações', () => {
    const body = { isRepo: true, current: 'main', detachedAt: null, branches: [branch], dirty: ['a.txt'] };
    expect(GitBranchesResponseSchema.parse(body)).toEqual(body);
  });

  it('aceita HEAD destacado (current null, detachedAt com o commit)', () => {
    const body = { isRepo: true, current: null, detachedAt: 'abc1234', branches: [], dirty: [] };
    expect(GitBranchesResponseSchema.parse(body)).toEqual(body);
  });

  it('pasta que não é repositório: { isRepo: false } sem campos de branch', () => {
    expect(GitBranchesResponseSchema.parse({ isRepo: false })).toEqual({ isRepo: false });
  });

  it('isRepo é obrigatório e vem como booleano (sem ele, a resposta não casa com nenhum caso)', () => {
    expect(GitBranchesResponseSchema.safeParse({ current: 'main', detachedAt: null, branches: [], dirty: [] }).success).toBe(false);
    expect(GitBranchesResponseSchema.safeParse({ isRepo: 'sim' }).success).toBe(false);
  });

  it('aceita upstream null', () => {
    expect(GitBranchesResponseSchema.safeParse({ isRepo: true, current: 'x', detachedAt: null, branches: [{ ...branch, upstream: null }], dirty: [] }).success).toBe(true);
  });

  it('rejeita mais de 200 alterações', () => {
    const dirty = Array.from({ length: 201 }, (_, i) => `f${i}.txt`);
    expect(GitBranchesResponseSchema.safeParse({ isRepo: true, current: 'x', detachedAt: null, branches: [], dirty }).success).toBe(false);
  });

  it('rejeita lastCommitAt negativo', () => {
    expect(GitBranchesResponseSchema.safeParse({ isRepo: true, current: 'x', detachedAt: null, branches: [{ ...branch, lastCommitAt: -1 }], dirty: [] }).success).toBe(false);
  });
});

describe('GitCheckoutRequestSchema', () => {
  it('aceita só o nome da branch', () => {
    expect(GitCheckoutRequestSchema.parse({ branch: 'feature/x' })).toEqual({ branch: 'feature/x' });
  });

  it('aceita create true', () => {
    expect(GitCheckoutRequestSchema.parse({ branch: 'nova', create: true })).toEqual({ branch: 'nova', create: true });
  });

  it('rejeita nome vazio', () => {
    expect(GitCheckoutRequestSchema.safeParse({ branch: '' }).success).toBe(false);
  });

  it('rejeita nome que começa com hífen (opção do git)', () => {
    expect(GitCheckoutRequestSchema.safeParse({ branch: '--force' }).success).toBe(false);
  });

  it('rejeita @{ (expansão do git, ex.: @{-1})', () => {
    expect(GitCheckoutRequestSchema.safeParse({ branch: '@{-1}' }).success).toBe(false);
  });

  it('rejeita create que não é booleano', () => {
    expect(GitCheckoutRequestSchema.safeParse({ branch: 'x', create: 'sim' }).success).toBe(false);
  });
});

describe('workspace files schemas', () => {
  const entry = { name: 'src', type: 'dir', size: 0, mtimeMs: 1_700_000_000_000.5, ignored: false };

  it('WorkspaceEntriesResponseSchema aceita entradas de todos os tipos', () => {
    const body = {
      entries: [entry, { ...entry, name: 'a.ts', type: 'file', size: 12, ignored: true }, { ...entry, name: 'l', type: 'symlink' }],
    };
    expect(WorkspaceEntriesResponseSchema.parse(body)).toEqual(body);
  });

  it('WorkspaceEntriesResponseSchema rejeita tipo desconhecido e ignored ausente', () => {
    expect(WorkspaceEntriesResponseSchema.safeParse({ entries: [{ ...entry, type: 'socket' }] }).success).toBe(false);
    const { ignored: _ignored, ...withoutIgnored } = entry;
    expect(WorkspaceEntriesResponseSchema.safeParse({ entries: [withoutIgnored] }).success).toBe(false);
  });

  it('WorkspaceFileResponseSchema aceita o arquivo lido e rejeita encoding diferente de utf8', () => {
    const file = { path: 'a.txt', content: 'oi\r\n', encoding: 'utf8', size: 4, mtimeMs: 1, etag: 'abc' };
    expect(WorkspaceFileResponseSchema.parse(file)).toEqual(file);
    expect(WorkspaceFileResponseSchema.safeParse({ ...file, encoding: 'latin1' }).success).toBe(false);
  });

  it('WorkspaceFileWriteRequestSchema exige baseEtag (null para criar)', () => {
    expect(WorkspaceFileWriteRequestSchema.parse({ path: 'a.txt', content: '', baseEtag: null }).baseEtag).toBeNull();
    expect(WorkspaceFileWriteRequestSchema.parse({ path: 'a.txt', content: '', baseEtag: 'e1' }).baseEtag).toBe('e1');
    expect(WorkspaceFileWriteRequestSchema.safeParse({ path: 'a.txt', content: '' }).success).toBe(false);
    expect(WorkspaceFileWriteRequestSchema.safeParse({ path: 'a.txt', content: '', baseEtag: '' }).success).toBe(false);
  });

  it('WorkspaceFileWriteResponseSchema, mkdir e rename aceitam o formato do daemon', () => {
    expect(WorkspaceFileWriteResponseSchema.parse({ path: 'a.txt', size: 3, mtimeMs: 2, etag: 'e2' })).toEqual({
      path: 'a.txt',
      size: 3,
      mtimeMs: 2,
      etag: 'e2',
    });
    expect(WorkspaceMkdirRequestSchema.parse({ path: 'pasta' })).toEqual({ path: 'pasta' });
    expect(WorkspaceRenameRequestSchema.parse({ from: 'a', to: 'b' })).toEqual({ from: 'a', to: 'b' });
    expect(WorkspaceRenameRequestSchema.safeParse({ from: 'a' }).success).toBe(false);
  });
});
