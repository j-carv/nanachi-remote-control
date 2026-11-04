import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

/*
 * Agente ACP falso para os testes do daemon. Roda com `node --import <tsx/esm> fake-agent.ts`
 * (um processo só, para que o pid gravado seja o do agente de verdade).
 *
 * Comportamento pelo texto do prompt:
 *  - "permission": pede permissão e ecoa a opção escolhida (ou "Cancelada")
 *  - "slow": trabalha até receber session/cancel
 *  - "config": emite config_option_update (thought_level vira "high")
 *  - "die": encerra o processo no meio do turno
 *  - "img-inline": manda um PNG inline em agent_message_chunk e em tool_call + tool_call_update (mesmo conteúdo);
 *    FAKE_AGENT_INLINE_IMAGE=<arquivo> usa esse arquivo no lugar do PNG de 1x1
 *  - "img-arquivo": manda resource_link file:// de FAKE_AGENT_IMAGE_FILE (dentro) e de FAKE_AGENT_IMAGE_OUTSIDE (fora)
 *    em tool calls call-link e call-outside
 *  - "flood": conversa pesada para medir o chat (e2e/run-chat-perf.mjs): pensamento, plano, 40 passos com
 *    ~60 chunks de markdown cada, tool call com diff e saída longa, bloco de código largo e um final com
 *    ~600 chunks. Um chunk por evento, em lotes curtos (FLOOD_TICK chunks por pausa de 10 ms).
 *
 * Variáveis de ambiente:
 *  - FAKE_AGENT_STYLE=modes: anuncia `modes` em vez de `configOptions` (exercita a opção sintetizada)
 *  - FAKE_AGENT_PID_DIR: por sessão (<AGENT_SESSION_ID>), grava o pid (.pid), o env que recebeu
 *    (.env.json: cwd, AGENT_SESSION_ID, NANACHI_URL, NANACHI_AGENT_TOKEN, PATH) e cada prompt recebido (.prompts.jsonl)
 *  - FAKE_AGENT_PROMPT_IMAGE=1: anuncia promptCapabilities.image no initialize
 *  - FAKE_AGENT_RESUME: como o agente retoma sessão. `load` (padrão, loadSession: true; reenvia 2 updates
 *    antigos durante o session/load), `resume` (sessionCapabilities.resume, sem histórico) ou `none` (nada: 409).
 *  - FAKE_AGENT_LIST: `none` não anuncia sessionCapabilities.list; `hang` anuncia mas nunca responde session/list
 *    (para testar timeout e 429). Sem a variável, anuncia e responde.
 *  - FAKE_AGENT_STORE=<arquivo>: sessões em JSON (lista de {sessionId, cwd, title, updatedAt (ISO), history}).
 *    session/new acrescenta uma sessão com id novo; session/list pagina o arquivo; session/load reenvia o
 *    `history` da sessão (role user => user_message_chunk, agent => agent_message_chunk). Sem a variável,
 *    session/load reenvia os 2 updates fixos e session/list vem vazia.
 *  - FAKE_AGENT_PAGE_SIZE (padrão 50): tamanho da página do session/list.
 *  - Sempre que PID_DIR está setado, cada método recebido do daemon vai para <AGENT_SESSION_ID>.methods.jsonl.
 *  - FAKE_AGENT_EMPTY_PAGES=N: como o codex-acp, cada página vem N vezes vazia com nextCursor antes do conteúdo.
 *  - FAKE_AGENT_COMMANDS=1: anuncia comandos (available_commands_update) logo depois de session/new e session/load.
 *    Prompt "/eco <texto>" responde só com o texto (agent_message_chunk), sem o eco padrão.
 *    Prompt "/trocar-comandos" anuncia outra lista (só "novo") e encerra o turno.
 */

const style = process.env.FAKE_AGENT_STYLE === 'modes' ? 'modes' : 'options';
const resume = process.env.FAKE_AGENT_RESUME ?? 'load';
const ACP_SESSION_ID = 'acp-session-1';
const DEADLINE_MS = 15_000;
/** PNG de 1x1 em base64 (só o mime importa para o daemon). FAKE_AGENT_INLINE_IMAGE=<arquivo> troca pelo arquivo. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const INLINE_IMAGE_B64 =
  process.env.FAKE_AGENT_INLINE_IMAGE === undefined
    ? PNG_B64
    : readFileSync(process.env.FAKE_AGENT_INLINE_IMAGE).toString('base64');

interface StoredHistoryItem {
  role: 'user' | 'agent';
  text: string;
}

interface StoredSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  history: StoredHistoryItem[];
}

const state = { mode: 'default', model: 'fast', thought: 'medium' };
const storePath = process.env.FAKE_AGENT_STORE;
const pageSize = Number(process.env.FAKE_AGENT_PAGE_SIZE ?? 50);
const emptyPages = Number(process.env.FAKE_AGENT_EMPTY_PAGES ?? 0);
const listMode = process.env.FAKE_AGENT_LIST ?? 'on';
const announceCommands = process.env.FAKE_AGENT_COMMANDS === '1';
let cancelRequested = false;

const pidDir = process.env.FAKE_AGENT_PID_DIR;
const sessionKey = process.env.AGENT_SESSION_ID ?? 'sem-id';
if (pidDir !== undefined) {
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, `${sessionKey}.pid`), String(process.pid));
  writeFileSync(
    join(pidDir, `${sessionKey}.env.json`),
    JSON.stringify({
      cwd: process.cwd(),
      AGENT_SESSION_ID: process.env.AGENT_SESSION_ID,
      NANACHI_URL: process.env.NANACHI_URL,
      NANACHI_AGENT_TOKEN: process.env.NANACHI_AGENT_TOKEN,
      PATH: process.env.PATH,
    }),
  );
}

/*
 * Todo método que o daemon manda ao agente (requests e notificações) é anotado em <pidDir>/<sessionKey>.methods.jsonl.
 * Serve para provar que o daemon nunca pede delete/close ao agente (ex.: "remover do app" não apaga histórico).
 */
if (pidDir !== undefined) {
  let pending = '';
  process.stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as { method?: unknown };
        if (typeof message.method === 'string') {
          appendFileSync(join(pidDir, `${sessionKey}.methods.jsonl`), `${JSON.stringify(message.method)}\n`);
        }
      } catch {
        /* linha que não é JSON: ignorada */
      }
    }
  });
}

function configOptions(): acp.SessionConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Acesso',
      category: 'mode',
      type: 'select',
      currentValue: state.mode,
      options: [
        { value: 'default', name: 'Padrão' },
        { value: 'plan', name: 'Plano' },
      ],
    },
    {
      id: 'model',
      name: 'Modelo',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: [
        { group: 'rapidos', name: 'Rápidos', options: [{ value: 'fast', name: 'Rápido' }] },
        { group: 'potentes', name: 'Potentes', options: [{ value: 'slow-model', name: 'Potente' }] },
      ],
    },
    {
      id: 'thought',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: state.thought,
      options: [
        { value: 'low', name: 'Baixo' },
        { value: 'medium', name: 'Médio' },
        { value: 'high', name: 'Alto' },
      ],
    },
    { id: 'ultra', name: 'Ultra', category: 'model_config', type: 'boolean', currentValue: false },
  ];
}

function setConfig(configId: string, value: string | boolean): void {
  const option = configOptions().find((item) => item.id === configId);
  if (option === undefined) throw acp.RequestError.invalidParams(undefined, `opção desconhecida: ${configId}`);
  if (option.type === 'boolean') {
    if (typeof value !== 'boolean') throw acp.RequestError.invalidParams(undefined, 'esperava boolean');
    return;
  }
  const values = option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry])).map((o) => o.value);
  if (typeof value !== 'string' || !values.includes(value)) {
    throw acp.RequestError.invalidParams(undefined, `valor inválido: ${String(value)}`);
  }
  if (configId === 'mode') state.mode = value;
  if (configId === 'model') state.model = value;
  if (configId === 'thought') state.thought = value;
}

/** Estado da sessão como o agente devolve em session/new, session/load e session/resume. */
function sessionState(): Pick<acp.NewSessionResponse, 'modes' | 'configOptions'> {
  if (style === 'modes') {
    return {
      modes: {
        currentModeId: state.mode,
        availableModes: [
          { id: 'default', name: 'Padrão' },
          { id: 'plan', name: 'Plano' },
        ],
      },
    };
  }
  return { configOptions: configOptions() };
}

function readStore(): StoredSession[] {
  if (storePath === undefined) return [];
  try {
    return JSON.parse(readFileSync(storePath, 'utf8')) as StoredSession[];
  } catch {
    return [];
  }
}

function writeStore(sessions: StoredSession[]): void {
  if (storePath === undefined) return;
  writeFileSync(storePath, JSON.stringify(sessions));
}

function capabilities(): acp.AgentCapabilities {
  const prompt = process.env.FAKE_AGENT_PROMPT_IMAGE === '1' ? { promptCapabilities: { image: true } } : {};
  const list: acp.SessionCapabilities = listMode === 'none' ? {} : { list: {} };
  if (resume === 'resume') return { sessionCapabilities: { ...list, resume: {} }, ...prompt };
  if (resume === 'none') return { sessionCapabilities: list, ...prompt };
  return { loadSession: true, sessionCapabilities: list, ...prompt };
}

/**
 * Página do session/list. Cursor `<offset>-<k>`: k < emptyPages devolve página vazia (com nextCursor) sem andar
 * o offset, como o codex-acp; depois disso, o conteúdo da página.
 */
function listPage(cursor: string | null | undefined): acp.ListSessionsResponse {
  const [offsetText = '0', emptySeenText = '0'] = (cursor ?? '0-0').split('-');
  const offset = Number(offsetText);
  const emptySeen = Number(emptySeenText);
  if (emptySeen < emptyPages) {
    return { sessions: [], nextCursor: `${offset}-${emptySeen + 1}` };
  }
  const all = readStore();
  const sessions = all.slice(offset, offset + pageSize).map((item) => ({
    sessionId: item.sessionId,
    cwd: item.cwd,
    title: item.title,
    updatedAt: item.updatedAt,
  }));
  const next = offset + pageSize < all.length ? `${offset + pageSize}-0` : null;
  return { sessions, nextCursor: next };
}

function storedSession(sessionId: string): StoredSession | undefined {
  return readStore().find((item) => item.sessionId === sessionId);
}

function userChunk(text: string): acp.SessionUpdate {
  return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
}

function chunk(text: string): acp.SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

/** Comandos anunciados com FAKE_AGENT_COMMANDS=1 (nomes e formas que os agentes reais usam: /loop, /mcp, skill:x). */
const FAKE_COMMANDS: acp.AvailableCommand[] = [
  { name: 'loop', description: 'Repete um prompt em intervalo', input: { hint: '[intervalo] [prompt]' } },
  { name: 'mcp', description: 'Mostra os servidores MCP' },
  { name: 'skill:brainstorming', description: 'Use antes de criar algo novo', input: { hint: 'argumentos' } },
  { name: 'eco', description: 'Devolve o texto informado', input: { hint: 'texto' } },
];

async function announce(notify: (update: acp.SessionUpdate) => Promise<void>): Promise<void> {
  if (!announceCommands) return;
  await notify({ sessionUpdate: 'available_commands_update', availableCommands: FAKE_COMMANDS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FLOOD_STEPS = 40;
const FLOOD_CHUNKS_PER_STEP = 60;
const FLOOD_TAIL_CHUNKS = 600;
const FLOOD_TICK = 8;
const FLOOD_FRAGMENTS = [
  'Vou ajustar **o parser** de `eventos` e conferir ',
  'o [contrato](https://exemplo.com/contrato) antes de seguir. ',
  '\n- item com `código inline` e *ênfase*\n',
  'Sem mudar a API pública; só o caminho interno. ',
  '\n| coluna | valor |\n|---|---|\n| a | 1 |\n\n',
  'Depois rodo os testes do pacote compartilhado. ',
];
const FLOOD_WIDE_LINE = `const configuracaoDoAgente = { ${'chave: "valor-longo-para-testar-rolagem-horizontal", '.repeat(4)}};`;

/** Conversa pesada (modo "flood"): ver o cabeçalho do arquivo. Os chunks passam por `notify`, um a um. */
async function flood(notify: (update: acp.SessionUpdate) => Promise<void>): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await notify({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `Pensando no módulo ${index}. ` },
    });
  }
  await notify({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Ler o estado atual', priority: 'high', status: 'completed' },
      { content: 'Ajustar o parser', priority: 'high', status: 'in_progress' },
      { content: 'Rodar os testes', priority: 'medium', status: 'pending' },
      { content: 'Atualizar a documentação', priority: 'low', status: 'pending' },
    ],
  });

  let sent = 0;
  const say = async (text: string) => {
    await notify(chunk(text));
    sent += 1;
    if (sent % FLOOD_TICK === 0) await sleep(10);
  };

  for (let step = 0; step < FLOOD_STEPS; step += 1) {
    await say(`\n### Passo ${step + 1}\n\n`);
    for (let index = 0; index < FLOOD_CHUNKS_PER_STEP; index += 1) {
      await say(FLOOD_FRAGMENTS[index % FLOOD_FRAGMENTS.length] ?? '');
    }
    const toolCallId = `flood-${step}`;
    const path = `src/modulo-${step}.ts`;
    await notify({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Editar ${path}`,
      kind: 'edit',
      status: 'pending',
      locations: [{ path }],
      content: [
        {
          type: 'diff',
          path,
          oldText: Array.from({ length: 30 }, (_, line) => `export const linha${line} = ${line};`).join('\n'),
          newText: Array.from({ length: 30 }, (_, line) =>
            line === 7 ? FLOOD_WIDE_LINE : `export const linha${line} = ${line + step};`,
          ).join('\n'),
        },
      ],
    });
    await notify({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: Array.from({ length: 120 }, (_, line) => `saída ${step}.${line}: ok ${'.'.repeat(line % 40)}`).join('\n'),
          },
        },
      ],
    });
  }

  await say('\n### Código\n\n```ts\n');
  await say(`${FLOOD_WIDE_LINE}\n${'// comentário de linha comprida para o bloco de código. '.repeat(3)}\n`);
  await say('```\n\n');
  for (let index = 0; index < FLOOD_TAIL_CHUNKS; index += 1) {
    await say(FLOOD_FRAGMENTS[index % FLOOD_FRAGMENTS.length] ?? '');
  }
  await say('\n\nFIM-DO-FLOOD');
}

acp.agent()
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: capabilities(),
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    const sessionId = storePath === undefined ? ACP_SESSION_ID : randomUUID();
    if (storePath !== undefined) {
      writeStore([
        ...readStore(),
        { sessionId, cwd: params.cwd, title: null, updatedAt: new Date().toISOString(), history: [] },
      ]);
    }
    await announce((update) => client.notify(acp.methods.client.session.update, { sessionId, update }));
    return { sessionId, ...sessionState() };
  })
  .onRequest(acp.methods.agent.session.list, ({ params }) => {
    if (listMode === 'hang') return new Promise<acp.ListSessionsResponse>(() => undefined);
    return listPage(params.cursor);
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    // Histórico antigo reenviado durante o load: o daemon não pode gravar nem repassar isto (no resume normal).
    const items: acp.SessionUpdate[] =
      storePath === undefined
        ? [chunk('historico 1'), chunk('historico 2')]
        : (storedSession(params.sessionId)?.history ?? []).map((item) =>
            item.role === 'user' ? userChunk(item.text) : chunk(item.text),
          );
    if (storePath !== undefined && storedSession(params.sessionId) === undefined) {
      throw acp.RequestError.invalidParams(undefined, `sessão desconhecida: ${params.sessionId}`);
    }
    for (const update of items) {
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
    }
    await announce((update) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update }));
    return sessionState();
  })
  .onRequest(acp.methods.agent.session.resume, () => sessionState())
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    setConfig(params.configId, params.value);
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    setConfig('mode', params.modeId);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancelRequested = true;
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    cancelRequested = false;
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
    const notify = (update: acp.SessionUpdate) =>
      client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });

    if (pidDir !== undefined) {
      appendFileSync(join(pidDir, `${sessionKey}.prompts.jsonl`), `${JSON.stringify(params.prompt)}\n`);
    }
    if (text.includes('die')) process.exit(7);
    if (text.startsWith('/eco ')) {
      await notify(chunk(text.slice('/eco '.length)));
      return { stopReason: 'end_turn' };
    }
    if (text === '/trocar-comandos') {
      await notify({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'novo', description: 'Lista trocada' }],
      });
      return { stopReason: 'end_turn' };
    }
    if (text.includes('flood')) {
      await flood(notify);
      return { stopReason: 'end_turn' };
    }

    await notify(chunk('Eco: '));
    await notify(chunk(text));
    await notify({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Editar a.txt',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'a.txt' }],
      content: [{ type: 'diff', path: 'a.txt', oldText: 'antigo', newText: 'novo' }],
    });
    await notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });

    if (text.includes('img-inline')) {
      const image: acp.ContentBlock = { type: 'image', data: INLINE_IMAGE_B64, mimeType: 'image/png' };
      await notify({ sessionUpdate: 'agent_message_chunk', content: image });
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-img',
        title: 'Ler teste.png',
        kind: 'read',
        status: 'in_progress',
        content: [{ type: 'content', content: image }],
      });
      await notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-img', content: [{ type: 'content', content: image }] });
    }

    if (text.includes('img-arquivo')) {
      const inside = process.env.FAKE_AGENT_IMAGE_FILE ?? '';
      const outside = process.env.FAKE_AGENT_IMAGE_OUTSIDE ?? '';
      for (const [toolCallId, path] of [
        ['call-link', inside],
        ['call-outside', outside],
      ] as const) {
        await notify({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Ler arquivo',
          kind: 'read',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'resource_link', name: 'teste.png', uri: pathToFileURL(path).href, mimeType: 'image/png' },
            },
          ],
        });
      }
    }

    if (text.includes('permission')) {
      const response = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call-2', title: 'Executar comando', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
          { optionId: 'reject', name: 'Rejeitar', kind: 'reject_once' },
        ],
      });
      const answer =
        response.outcome.outcome === 'selected' ? `Escolhida: ${response.outcome.optionId}` : 'Cancelada';
      await notify(chunk(answer));
    }

    if (text.includes('config')) {
      state.thought = 'high';
      await notify({ sessionUpdate: 'config_option_update', configOptions: configOptions() });
    }

    if (text.includes('slow')) {
      await notify(chunk('Trabalhando'));
      const deadline = Date.now() + DEADLINE_MS;
      while (!cancelRequested && Date.now() < deadline) await sleep(20);
    }

    return { stopReason: cancelRequested ? 'cancelled' : 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

process.stdin.on('end', () => process.exit(0));
