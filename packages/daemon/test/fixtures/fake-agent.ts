import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RequestFileAgentResultSchema } from '@nanachi/shared';

/*
 * Agente ACP falso para os testes do daemon. Roda com `node --import <tsx/esm> fake-agent.ts`
 * (um processo só, para que o pid gravado seja o do agente de verdade).
 *
 * Comportamento pelo texto do prompt:
 *  - "permission": pede permissão e ecoa a opção escolhida (ou "Cancelada")
 *  - "permission-fail": falha o turno depois da resposta à permissão (testa cancelamento de perguntas pendentes)
 *  - "/nanachi-send <JSON>" / "/nanachi-ask <JSON>" / "/nanachi-request-file <JSON>" / "/nanachi-preview <JSON>": call the real ACP MCP stdio descriptor
 *  - "slow": trabalha até receber session/cancel
 *  - "config": emite config_option_update (thought_level vira "high")
 *  - "modo-plano": the agent switches itself to plan and says so with current_mode_update (as omp does on its own)
 *  - "die": encerra o processo no meio do turno
 *  - "LOOP-NEXT=<duração>" / "LOOP-STOP" / "LOOP-FAIL" (modo Loop): marcador de tempo, marcador de parada, ou
 *    prompt rejeitado (erro do turno). Maiúsculas de propósito: a instrução do loop não as usa.
 *  - "img-inline": manda um PNG inline em agent_message_chunk e em tool_call + tool_call_update (mesmo conteúdo);
 *    FAKE_AGENT_INLINE_IMAGE=<arquivo> usa esse arquivo no lugar do PNG de 1x1
 *  - "img-arquivo": manda resource_link file:// de FAKE_AGENT_IMAGE_FILE (dentro) e de FAKE_AGENT_IMAGE_OUTSIDE (fora)
 *    em tool calls call-link e call-outside
 *  - "/subagentes": subagente Claude (Agent, com filhos e um neto), Bash em segundo plano e task do omp com
 *    details.progress; espera session/cancel (ver subagentDemo). Usado por e2e/run-background.mjs.
 *  - "flood": conversa pesada para medir o chat (e2e/run-chat-perf.mjs): pensamento, plano, 40 passos com
 *    ~60 chunks de markdown cada, tool call com diff e saída longa, bloco de código largo e um final com
 *    ~600 chunks. Um chunk por evento, em lotes curtos (FLOOD_TICK chunks por pausa de 10 ms).
 *
 * Variáveis de ambiente:
 *  - FAKE_AGENT_STYLE=modes: anuncia `modes` em vez de `configOptions` (exercita a opção sintetizada)
 *  - FAKE_AGENT_MODE=<mode>: the current mode when the session opens (default `default`; `plan` opens in plan)
 *  - FAKE_AGENT_PID_DIR: por sessão (<AGENT_SESSION_ID>), grava o pid (.pid), o env que recebeu
 *    (.env.json: cwd, AGENT_SESSION_ID, NANACHI_URL, NANACHI_AGENT_TOKEN, PATH, CLAUDE_CONFIG_DIR, CODEX_HOME: as duas
 *    últimas são as pastas de conta dos harnesses, ausentes quando o processo não as recebeu) e cada prompt recebido
 *    (.prompts.jsonl)
 *  - Prompt "/env <NOME>" responde "<NOME>=<valor da variável de ambiente do processo>" (ou "<NOME>=<ausente>"): é como os
 *    testes de contas leem a pasta de conta (CLAUDE_CONFIG_DIR, CODEX_HOME) que o agente recebeu.
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
 *    /mcp has an alternation hint and /usage (hint with choices) answers with raw ANSI SGR escapes, like omp's /usage.
 *    /model is the native picker (the model option of configOptions); "/usage ..." replies in a code block.
 *  - Prompts "/usage..." e "/status..." (comandos de uso, POST /api/sessions/:id/usage) respondem com o texto
 *    de USAGE_REPLY; FAKE_AGENT_USAGE=hang não responde até session/cancel.
 *    "/usage reset" responde a listagem de resets (RESETS_LISTING); "/usage reset anthropic/1" (e /2, /3, /4) responde
 *    uma linha de resgate (RESET_REPLIES). FAKE_AGENT_RESET_DELAY_MS=<ms> segura o resgate antes de responder.
 *    FAKE_AGENT_USAGE_DELAY_MS=<ms> segura a leitura de uso e a listagem de resets (nao o resgate) antes de responder.
 *  - FAKE_AGENT_LOAD_DELAY_MS=<ms>: session/load espera esse tempo antes de responder (retomada em curso nos testes).
 *  - FAKE_AGENT_LOAD_FAIL=1: session/load responde erro (falha da retomada).
 */

const style = process.env.FAKE_AGENT_STYLE === 'modes' ? 'modes' : 'options';
const resume = process.env.FAKE_AGENT_RESUME ?? 'load';
const loadDelayMs = Number(process.env.FAKE_AGENT_LOAD_DELAY_MS ?? 0);
const loadFails = process.env.FAKE_AGENT_LOAD_FAIL === '1';
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

const state = { mode: process.env.FAKE_AGENT_MODE ?? 'default', model: 'fast', thought: 'medium' };
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
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
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

let sessionMcpServers: acp.McpServer[] = [];

/** Record the ACP definition without publishing its bearer token. */
function recordMcp(method: string, params: { cwd: string; mcpServers?: acp.McpServer[] | null }): void {
  sessionMcpServers = params.mcpServers ?? [];
  if (pidDir === undefined) return;
  const mcpServers = sessionMcpServers.map((server) => {
    if ('type' in server) return server;
    return {
      ...server,
      env: server.env.map((entry) => entry.name === 'NANACHI_AGENT_TOKEN'
        ? { name: entry.name, value: '<redacted>', matchesSessionToken: entry.value === process.env.NANACHI_AGENT_TOKEN }
        : entry),
    };
  });
  appendFileSync(join(pidDir, `${sessionKey}.mcp.jsonl`), `${JSON.stringify({ method, cwd: params.cwd, mcpServers })}\n`);
}

/** Consume the real ACP descriptor with an SDK client, just as an ACP harness would. */
async function callNanachiTool(name: 'phone_send' | 'ask_user' | 'request_file' | 'open_preview', input: Record<string, unknown>): Promise<string> {
  const descriptor = sessionMcpServers.find((server) => server.name === 'nanachi-remote' && !('type' in server));
  if (descriptor === undefined || 'type' in descriptor) throw new Error('Nanachi MCP not configured');
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: descriptor.command,
      args: descriptor.args,
      env: Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])),
      cwd: process.cwd(),
      stderr: 'pipe',
    }));
    const listed = await client.listTools();
    if (!listed.tools.some((tool) => tool.name === name)) throw new Error(`${name} not discovered`);
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 320_000 });
    if (name === 'request_file') {
      const fileResult = RequestFileAgentResultSchema.parse(result.structuredContent);
      const publicResult = fileResult.status === 'received' ? { status: fileResult.status, file: fileResult.file } : fileResult;
      // Assert the agent can consume the private path without echoing that path into chat history.
      const fileAvailable = fileResult.status === 'received' && isAbsolute(fileResult.path)
        && readFileSync(fileResult.path).length === fileResult.file.size;
      return JSON.stringify({ isError: result.isError, structuredContent: publicResult, fileAvailable });
    }
    return JSON.stringify(result);
  } finally {
    await client.close();
  }
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
  {
    name: 'mcp',
    description: 'Mostra os servidores MCP',
    input: { hint: '[reconnect|enable|disable [<server>|all]]' },
  },
  { name: 'skill:brainstorming', description: 'Use antes de criar algo novo', input: { hint: 'argumentos' } },
  { name: 'eco', description: 'Devolve o texto informado', input: { hint: 'texto' } },
  { name: 'model', description: 'Troca o modelo da sessão' },
  {
    name: 'usage',
    description: 'Mostra o uso da conta',
    input: { hint: '[show|reset [provider/credential-id|provider/active]]' },
  },
];

/**
 * Reply shaped like omp's `/usage`: a code block with raw SGR escapes in the bars, one block per window. The PWA
 * must show the cards (62% and 21%) and no escape codes. The account is synthetic.
 */
const USAGE_REPLY = [
  '```',
  'Usage (1s ago)',
  '',
  'Openai Codex',
  '  Models with usage data',
  '    openai-codex/gpt-5.6-sol',
  '- 5 hours',
  '  fake@example.com · plan: plus: 62.00% used (38.0% left)  ← in use by this session',
  '  [\u001b[38;2;0;180;255m██████████████\u001b[39m░░░░░░░░░░] 62%',
  '  resets in 2h',
  '- 7 days',
  '  fake@example.com · plan: plus: 21.00% used (79.0% left)',
  '  [\u001b[38;2;52;211;153m█████\u001b[39m░░░░░░░░░░░░░░░░░░░] 21%',
  '  resets in 5d',
  '```',
  '',
].join('\n');

/**
 * Reply of `/usage reset` (no argument): omp's listing shape (docs/PLAN.md, rate-limit resets). The first line has an
 * SGR escape, which the daemon must strip. Accounts are synthetic.
 */
const RESETS_LISTING = [
  '\u001b[1mSaved rate-limit resets:\u001b[22m',
  '- fake@example.com · Org [Anthropic · anthropic/1]: 2 saved, 1 usable now, expires in 3 days (active)',
  '- other@example.com [OpenAI Codex · openai-codex/2]: 1 saved, 0 usable now (not constrained)',
  '',
  'Spend one with `/usage reset <provider>/<credential id>` or `/usage reset <provider>/active`.',
  '',
].join('\n');

/** One-line replies of `/usage reset <provider>/<id>`, by target (the outcomes of the contract). */
const RESET_REPLIES: Readonly<Record<string, string>> = {
  'anthropic/1': '\u001b[32mReset applied for fake@example.com (Anthropic) — 5h session limit refreshed.\u001b[39m',
  'anthropic/2': 'fake@example.com (Anthropic): that reset was already redeemed.',
  'anthropic/3': 'fake@example.com (Anthropic): no saved resets available to spend.',
  'anthropic/4':
    "fake@example.com (Anthropic): nothing to reset right now — your covered limits aren't constrained, so no credit was spent.",
};

async function announce(notify: (update: acp.SessionUpdate) => Promise<void>): Promise<void> {
  if (!announceCommands) return;
  await notify({ sessionUpdate: 'available_commands_update', availableCommands: FAKE_COMMANDS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `/subagentes` (see the header): the tool calls a Claude subagent, a background Bash and an omp task leave in the
 * chat. Everything is sent at once, then the turn waits for session/cancel, so the running state can be seen; the
 * subagent completes when the turn ends. Claude's lineage and tool name travel in `_meta.claudeCode`.
 */
async function subagentDemo(notify: (update: acp.SessionUpdate) => Promise<void>): Promise<void> {
  const claude = (toolName: string, parentToolUseId?: string) => ({
    claudeCode: parentToolUseId === undefined ? { toolName } : { toolName, parentToolUseId },
  });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'sub-agent',
    title: 'Agent',
    kind: 'think',
    status: 'in_progress',
    rawInput: { description: 'Revisar o parser', subagent_type: 'Explore' },
    _meta: claude('Agent'),
  });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'sub-read',
    title: 'Ler parser.ts',
    kind: 'read',
    status: 'completed',
    locations: [{ path: 'src/parser.ts' }],
    _meta: claude('Read', 'sub-agent'),
  });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'sub-nested',
    title: 'Agent',
    kind: 'think',
    status: 'in_progress',
    rawInput: { description: 'Conferir os tipos', subagent_type: 'general-purpose' },
    _meta: claude('Agent', 'sub-agent'),
  });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'sub-nested-read',
    title: 'Ler types.ts',
    kind: 'read',
    status: 'completed',
    _meta: claude('Read', 'sub-nested'),
  });
  await notify({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-nested', status: 'completed' });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'sub-tests',
    title: 'Ler testes',
    kind: 'read',
    status: 'completed',
    _meta: claude('Read', 'sub-agent'),
  });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'bash-bg',
    title: 'Bash',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'npm test', description: 'Testes em segundo plano', run_in_background: true },
    _meta: claude('Bash'),
  });
  await notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'omp-task',
    title: 'Compilar e testar',
    kind: 'other',
    status: 'in_progress',
    rawInput: { tasks: [{ task: 'Compilar pacote' }, { task: 'Testes unitários' }] },
  });
  await notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'omp-task',
    rawOutput: {
      details: {
        progress: [
          { id: 'job-1', task: 'Compilar pacote', status: 'running' },
          { id: 'job-2', task: 'Testes unitários', status: 'running' },
        ],
      },
    },
  });
  await notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'omp-task',
    rawOutput: {
      details: {
        progress: [
          { id: 'job-1', task: 'Compilar pacote', status: 'completed' },
          { id: 'job-2', task: 'Testes unitários', status: 'running' },
        ],
      },
    },
  });
  await notify(chunk('Subagentes disparados.'));

  const deadline = Date.now() + DEADLINE_MS;
  while (!cancelRequested && Date.now() < deadline) await sleep(20);
  await notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'sub-agent',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Análise pronta' } }],
  });
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
    recordMcp('session/new', params);
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
    recordMcp('session/load', params);
    if (loadFails) throw acp.RequestError.invalidParams(undefined, 'falha simulada no session/load');
    if (loadDelayMs > 0) await sleep(loadDelayMs);
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
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    recordMcp('session/resume', params);
    return sessionState();
  })
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
    if (text.startsWith('/nanachi-send ')) {
      await notify(chunk(await callNanachiTool('phone_send', JSON.parse(text.slice('/nanachi-send '.length)) as Record<string, unknown>)));
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('/nanachi-ask ')) {
      await notify(chunk(await callNanachiTool('ask_user', JSON.parse(text.slice('/nanachi-ask '.length)) as Record<string, unknown>)));
      return { stopReason: cancelRequested ? 'cancelled' : 'end_turn' };
    }
    if (text.startsWith('/nanachi-request-file ')) {
      await notify(chunk(await callNanachiTool('request_file', JSON.parse(text.slice('/nanachi-request-file '.length)) as Record<string, unknown>)));
      return { stopReason: cancelRequested ? 'cancelled' : 'end_turn' };
    }
    if (text.startsWith('/nanachi-preview ')) {
      await notify(chunk(await callNanachiTool('open_preview', JSON.parse(text.slice('/nanachi-preview '.length)) as Record<string, unknown>)));
      return { stopReason: 'end_turn' };
    }
    if (text.includes('die')) process.exit(7);
    if (text.startsWith('/eco ')) {
      await notify(chunk(text.slice('/eco '.length)));
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('/env ')) {
      const name = text.slice('/env '.length).trim();
      await notify(chunk(`${name}=${process.env[name] ?? '<ausente>'}`));
      return { stopReason: 'end_turn' };
    }
    // Loop (modo dynamic): palavras em maiúsculas no prompt do usuário. A instrução do loop não as contém, então
    // o eco não dispara nada. LOOP-NEXT=<duração> responde com esse marcador; LOOP-STOP com o de parada;
    // LOOP-FAIL rejeita o prompt, como um agente que quebra no turno.
    // Os blocos de texto são concatenados sem separador: a duração para em qualquer coisa que não seja letra ou dígito.
    const nextMarker = /LOOP-NEXT=([0-9a-z]+)/.exec(text);
    if (nextMarker !== null) {
      await notify(chunk(`Passo feito. [[nanachi-loop-next: ${nextMarker[1] ?? ''}]]`));
      return { stopReason: 'end_turn' };
    }
    if (text.includes('LOOP-STOP')) {
      await notify(chunk('Tudo pronto. [[nanachi-loop-stop]]'));
      return { stopReason: 'end_turn' };
    }
    if (text.includes('LOOP-FAIL')) {
      throw acp.RequestError.internalError(undefined, 'falha simulada do turno');
    }
    if (text.startsWith('/usage') || text.startsWith('/status')) {
      // FAKE_AGENT_USAGE=hang: não responde ao comando de uso até receber session/cancel (testa o timeout).
      if (process.env.FAKE_AGENT_USAGE === 'hang') {
        const deadline = Date.now() + DEADLINE_MS;
        while (!cancelRequested && Date.now() < deadline) await sleep(20);
        return { stopReason: cancelRequested ? 'cancelled' : 'end_turn' };
      }
      // /usage reset: listing; /usage reset <provider>/<id>: one redeem. FAKE_AGENT_RESET_DELAY_MS holds the redeem
      // (the concurrency tests need a redeem still in flight). The fake never spends anything.
      const readDelay = Number(process.env.FAKE_AGENT_USAGE_DELAY_MS ?? 0);
      if (text === '/usage reset') {
        if (readDelay > 0) await sleep(readDelay);
        await notify(chunk(RESETS_LISTING));
        return { stopReason: 'end_turn' };
      }
      const redeem = /^\/usage reset (\S+)$/.exec(text);
      if (redeem !== null) {
        const delay = Number(process.env.FAKE_AGENT_RESET_DELAY_MS ?? 0);
        if (delay > 0) await sleep(delay);
        const target = redeem[1] ?? '';
        await notify(chunk(RESET_REPLIES[target] ?? `Could not find the stored account ${target}`));
        return { stopReason: 'end_turn' };
      }
      if (readDelay > 0) await sleep(readDelay);
      await notify(chunk(USAGE_REPLY));
      return { stopReason: 'end_turn' };
    }
    if (text === '/trocar-comandos') {
      await notify({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'novo', description: 'Lista trocada' }],
      });
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('/subagentes')) {
      await subagentDemo(notify);
      return { stopReason: cancelRequested ? 'cancelled' : 'end_turn' };
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

    // "permission-repeat": pede o mesmo tool call duas vezes sem esperar a primeira resposta (o daemon cancela a primeira).
    if (text.includes('permission-repeat')) {
      const ask = () =>
        client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'call-repeat', title: 'Executar comando', kind: 'execute' },
          options: [
            { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
            { optionId: 'reject', name: 'Rejeitar', kind: 'reject_once' },
          ],
        });
      await Promise.all([ask(), ask()]);
      return { stopReason: cancelRequested ? 'cancelled' : 'end_turn' };
    }

    if (text.includes('permission')) {
      const toolCall: acp.RequestPermissionRequest['toolCall'] = text.includes('permission-edit')
        ? {
            toolCallId: 'call-edit',
            title: 'Edit example.ts',
            name: 'Edit',
            kind: 'edit',
            rawInput: { file_path: 'example.ts', old_string: '1', new_string: '2' },
          }
        : { toolCallId: 'call-2', title: 'Executar comando', kind: 'execute' };
      const response = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall,
        options: [
          { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
          { optionId: 'reject', name: 'Rejeitar', kind: 'reject_once' },
        ],
      });
      const answer =
        response.outcome.outcome === 'selected' ? `Escolhida: ${response.outcome.optionId}` : 'Cancelada';
      await notify(chunk(answer));
      if (text === 'permission-fail') throw new Error('synthetic failure after a real permission response');
    }

    if (text.includes('modo-plano')) {
      state.mode = 'plan';
      await notify({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
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
