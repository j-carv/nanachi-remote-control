import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeUrl from 'node:url';
import type * as AgentCommandModule from '../src/agent-command.js';
import type { AgentConfig } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLauncher } from '../src/accounts/launch.js';
import { resolveAgentCommand } from '../src/agent-command.js';
import { LearningAgents, learningAgentEnv, learningCatalogModels } from '../src/learning-agents.js';
import { LearningError } from '../src/learning-errors.js';
import { removeTempDir } from './temp.js';

// The isolated Node child speaks ACP/NDJSON and the SDK module is synthetic.
// No installed model CLI or credentials are used; fixtures do not establish adapter safety.
const fakeSdk = vi.hoisted(() => ({ path: '' }));
vi.mock('node:url', async (original) => {
  const module = await original<typeof NodeUrl>();
  return {
    ...module,
    pathToFileURL: (path: string) => module.pathToFileURL(
      path.includes('claude-agent-sdk') && fakeSdk.path ? fakeSdk.path : path,
    ),
  };
});
vi.mock('../src/agent-command.js', async (original) => ({
  ...await original<typeof AgentCommandModule>(),
  resolveAgentCommand: vi.fn(),
}));

const MODEL = 'provider-a/exact-model-1';
const REVIEW = '{"summary":"No changes","entries":[]}';
const SCRIPT = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const mode = process.env.LEARNING_FAKE_MODE;
const record = (value) => appendFileSync(process.env.LEARNING_RECORD, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
record({kind:'launch', args, pid:process.pid, account:process.env.CLAUDE_CONFIG_DIR,
  authority:Object.keys(process.env).filter(k => /^(NANACHI_|MCP_|AGENT_SESSION_ID$)/i.test(k))});
if (args[0] === 'auth-gateway') send({ready:true,version:'18.13.2'});
createInterface({input:process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  record({kind:'request', request});
  // OMP uses the acp argument; the configured Claude ACP executable takes no arguments.
  if (args.length === 0 || args[0] === 'acp') {
    if (mode === 'catalog-hang') return;
    if (request.method === 'initialize') send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}});
    if (request.method === 'session/new') send({jsonrpc:'2.0',id:request.id,result:{sessionId:'independent',configOptions:[{
      id:'model',name:'Model',category:'model',type:'select',currentValue:'provider-a/exact-model-1',
      options:[{group:'provider-a',name:'Provider A',options:[{value:mode === 'claude-alias' ? 'default' : mode === 'claude-family' ? 'sonnet' : 'provider-a/exact-model-1',name:'Exact model'}]}]
    }]}});
  } else if (request.path === '/v1/models') {
    send({id:request.id,status:200,body:{data:[{id:mode === 'gateway-missing' ? 'other/model' : 'provider-a/exact-model-1'}]}});
  } else if (request.path === '/v1/chat/completions') {
    const files = process.env.PI_CONFIG_FILES.split(process.platform === 'win32' ? ';' : ':');
    record({kind:'overlay', text:readFileSync(files.at(-1),'utf8')});
    if (mode === 'review-hang') return;
    if (mode === 'review-flood') { process.stdout.write('x'.repeat(5*1024*1024)); return; }
    if (mode === 'provider-error') { send({id:request.id,status:401,body:{error:{message:'SENSITIVE_PROVIDER_BODY secret-token'}}}); return; }
    const text = mode === 'review-large' ? 'x'.repeat(8193) : '{"summary":"No changes","entries":[]}';
    send({id:request.id,status:200,body:{choices:[{message:{content:text}}]}});
  }
});
`;

const SDK_SCRIPT = String.raw`
import { appendFileSync } from 'node:fs';
export function query({prompt, options}) {
  const record = value => appendFileSync(options.env.LEARNING_RECORD, JSON.stringify(value) + '\n');
  const mode = options.env.LEARNING_FAKE_MODE;
  record({kind:'sdk',model:options.model,prompt,tools:options.tools,mcpServers:options.mcpServers,
    strictMcpConfig:options.strictMcpConfig,settingSources:options.settingSources,plugins:options.plugins,
    settings:options.settings,persistSession:options.persistSession,maxTurns:options.maxTurns,
    account:options.env.CLAUDE_CONFIG_DIR,maxOutputTokens:options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    authority:Object.keys(options.env).filter(k => /^(NANACHI_|MCP_|AGENT_SESSION_ID$)/i.test(k))});
  const stream = (async function*() {
    record({kind:'permission',result:await options.canUseTool('Bash',{}, {})});
    if (mode === 'sdk-hang') await new Promise((_resolve,reject) =>
      options.abortController.signal.addEventListener('abort',() => reject(new Error('synthetic abort')),{once:true}));
    if (mode === 'sdk-tool') { yield {type:'assistant',message:{content:[{type:'tool_use',name:'Bash'}]}}; return; }
    yield {type:'result',subtype:'success',is_error:false,result:'{"summary":"No changes","entries":[]}'};
  })();
  return Object.assign(stream, {close() {record({kind:'sdk-close'});}});
}
`;

let root: string;
let recordPath: string;
let scriptPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanachi-learning-agents-'));
  recordPath = join(root, 'record.jsonl');
  scriptPath = join(root, 'independent-agent.mjs');
  await writeFile(scriptPath, SCRIPT);
  fakeSdk.path = join(root, 'synthetic-claude-sdk.mjs');
  await writeFile(fakeSdk.path, SDK_SCRIPT);
  vi.mocked(resolveAgentCommand).mockImplementation((_command, args) => ({ file: process.execPath, args: [scriptPath, ...args], shell: false }));
});

afterEach(async () => {
  vi.resetAllMocks();
  await removeTempDir(root);
});

function agent(mode = ''): AgentConfig {
  return { label: 'Oh My Pi', command: 'omp', args: ['acp'], kind: 'acp', env: {
    LEARNING_RECORD: recordPath, LEARNING_FAKE_MODE: mode,
    NANACHI_AGENT_TOKEN: 'must-not-inherit', MCP_SERVER_URL: 'must-not-inherit', AGENT_SESSION_ID: 'must-not-inherit',
  } };
}

function accounts(): AccountLauncher {
  return {
    choose: vi.fn(() => 'captured-account'),
    effective: vi.fn((_agentId, stored) => stored),
    prepare: vi.fn(async () => undefined),
    env: vi.fn(() => ({ CLAUDE_CONFIG_DIR: join(root, 'account') })),
    labelOf: () => 'Synthetic account', principalOf: () => undefined,
    beginRemoval: async () => () => undefined, isRemoving: () => false,
  };
}

async function frames(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(recordPath, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function review(runtime: LearningAgents, signal = new AbortController().signal) {
  return runtime.review({ agentId: 'omp', accountId: 'captured-account', model: MODEL,
    prompt: '{"evidence":["synthetic"]}', maxOutputTokens: 512, signal });
}

async function untilFrame(predicate: (frame: Record<string, unknown>) => boolean): Promise<void> {
  // Await an actual filesystem event from the independent process, not a guessed sleep.
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(root, { signal: AbortSignal.timeout(5000) }, () => { void inspect(); });
    const inspect = async (): Promise<void> => {
      try {
        if ((await frames()).some(predicate)) { resolve(); watcher.close(); }
      } catch (error) { reject(error); watcher.close(); }
    };
    watcher.on('error', reject);
    watcher.on('close', () => reject(new Error('Synthetic reviewer did not reach the expected protocol state.')));
    void inspect();
  });
}

describe('learning agent model metadata', () => {
  it('preserves advertised IDs and provider group labels without fuzzy routing', () => {
    expect(learningCatalogModels('agent-a', 'Agent A', { configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'provider-a/model-1',
      options: [
        { group: 'provider-a', name: 'Provider A', options: [{ value: 'provider-a/model-1', name: 'Model One' }] },
        { group: 'provider-b', name: 'Provider B', options: [{ value: 'provider-b/model-1', name: 'Model One' }] },
      ],
    }] })).toEqual([
      { id: 'provider-a/model-1', label: 'Model One', provider: 'Provider A', source: 'agent', agentId: 'agent-a' },
      { id: 'provider-b/model-1', label: 'Model One', provider: 'Provider B', source: 'agent', agentId: 'agent-a' },
    ]);
  });

  it('supports legacy advertised models but never synthesizes a default model', () => {
    expect(learningCatalogModels('a', 'A', {})).toEqual([]);
    expect(learningCatalogModels('a', 'A', { models: { availableModels: [{ modelId: 'exact-1', name: 'Exact' }] } }))
      .toEqual([{ id: 'exact-1', label: 'Exact', provider: 'A', source: 'agent', agentId: 'a' }]);
  });

  it('removes tool authority case-insensitively while preserving inference account routing', () => {
    const config = agent();
    const env = learningAgentEnv(config, { CLAUDE_CONFIG_DIR: 'account' }, {
      nAnAcHi_AgEnT_ToKeN: 'secret', MCP_AUTH_TOKEN: 'secret', AGENT_SESSION_ID: 'session',
      OMP_SESSION_ID: 'harness-session', OMP_API_URL: 'harness-url',
      OMP_PROFILE: 'source-profile', OMP_AUTH_BROKER_URL: 'credential-route', OMP_AUTH_BROKER_TOKEN: 'credential-token',
      ANTHROPIC_API_KEY: 'inference-key',
    });
    expect(Object.keys(env).filter((key) => /^(NANACHI_|MCP_|AGENT_SESSION_ID$|OMP_SESSION_|OMP_API_)/i.test(key))).toEqual([]);
    expect(env.OMP_PROFILE).toBe('source-profile');
    expect(env.OMP_AUTH_BROKER_URL).toBe('credential-route');
    expect(env.OMP_AUTH_BROKER_TOKEN).toBe('credential-token');
    expect(env.ANTHROPIC_API_KEY).toBe('inference-key');
    expect(env.CLAUDE_CONFIG_DIR).toBe('account');
  });
});

describe('LearningAgents independent inference', () => {
  it('reports unsupported Codex/agy/terminal capability without advertising usable targets or spawning', async () => {
    const config = agent();
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: {
      codex: { ...config, command: 'codex-acp', args: [] },
      agy: { ...config, command: 'agy' }, terminal: { ...config, kind: 'pty' },
    } });
    const result = await runtime.models(new AbortController().signal);
    expect(result.models).toEqual([]);
    expect(result.errors.map((error) => error.source)).toEqual(['codex', 'agy', 'terminal']);
    expect(() => runtime.assertSupported('codex')).toThrow(LearningError);
    expect(() => runtime.assertSupported('unknown')).toThrow(LearningError);
    expect(resolveAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects custom command arguments instead of dropping configuration or falling back unsafely', () => {
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: {
      omp: { ...agent(), args: ['acp', '--extension', 'unreviewed.js'] },
    } });
    expect(() => runtime.assertSupported('omp')).toThrow(LearningError);
    expect(resolveAgentCommand).not.toHaveBeenCalled();
  });

  it('discovers via new independent ACP session without sending a paid prompt', async () => {
    const launcher = accounts();
    const runtime = new LearningAgents({ home: root, accounts: launcher, agents: { omp: agent() } });
    expect(await runtime.models(new AbortController().signal)).toEqual({ models: [
      { id: MODEL, label: 'Exact model', provider: 'Provider A', source: 'agent', agentId: 'omp' },
    ], errors: [] });
    expect(launcher.choose).toHaveBeenCalledWith('omp', undefined);
    expect(launcher.prepare).toHaveBeenCalledWith('omp', 'captured-account');
    const observed = await frames();
    expect(JSON.stringify(observed)).not.toContain('session/prompt');
    expect(observed.find((frame) => frame.kind === 'launch')?.authority).toEqual([]);
  });

  it('refuses removed captured account rather than silently using principal credentials', async () => {
    const launcher = accounts();
    vi.mocked(launcher.effective).mockReturnValue(null);
    const runtime = new LearningAgents({ home: root, accounts: launcher, agents: { omp: agent() } });
    await expect(review(runtime)).rejects.toThrow('original reviewer account');
    expect(launcher.prepare).not.toHaveBeenCalled();
    expect(resolveAgentCommand).not.toHaveBeenCalled();
  });

  it('rechecks the captured account after profile preparation', async () => {
    const launcher = accounts();
    vi.mocked(launcher.effective).mockReturnValueOnce('captured-account').mockReturnValue(null);
    const runtime = new LearningAgents({ home: root, accounts: launcher, agents: { omp: agent() } });
    await expect(review(runtime)).rejects.toThrow('original reviewer account');
    expect(resolveAgentCommand).not.toHaveBeenCalled();
  });

  it('runs exact omp inference through the real gateway protocol, not an ACP prompt or print agent turn', async () => {
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent() } });
    expect(await review(runtime)).toBe(REVIEW);
    const observed = await frames();
    const launches = observed.filter((frame) => frame.kind === 'launch');
    expect(launches.map((frame) => frame.args)).toEqual([['acp'], ['auth-gateway', 'stdio']]);
    expect(launches.every((frame) => JSON.stringify(frame.authority) === '[]')).toBe(true);
    const request = observed.find((frame) => frame.kind === 'request' &&
      (frame.request as Record<string, unknown>).path === '/v1/chat/completions')?.request as Record<string, unknown>;
    expect(request.body).toMatchObject({ model: MODEL, tools: [], tool_choice: 'none', stream: false, max_tokens: 512 });
    expect(observed.find((frame) => frame.kind === 'overlay')?.text).toContain('modelFallback: false');
    expect(JSON.stringify(observed)).not.toContain('session/prompt');
  });

  it('does not substitute a similar model absent from the ACP catalog', async () => {
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent() } });
    await expect(runtime.review({ agentId: 'omp', accountId: 'captured-account', model: 'model-1', prompt: '{}',
      maxOutputTokens: 512, signal: new AbortController().signal })).rejects.toThrow('exact selected reviewer model');
    expect((await frames()).filter((frame) => frame.kind === 'launch').map((frame) => frame.args)).toEqual([['acp']]);
  });

  it('checks the gateway catalog again before any paid inference', async () => {
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent('gateway-missing') } });
    await expect(review(runtime)).rejects.toThrow('exact selected reviewer model');
    expect(JSON.stringify(await frames())).not.toContain('/v1/chat/completions');
  });

  it('sanitizes provider failures without exposing provider bodies or credentials', async () => {
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent('provider-error') } });
    const error: unknown = await review(runtime).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(LearningError);
    expect(error).toMatchObject({ message: expect.stringContaining('could not complete the independent review') });
    expect(String(error)).not.toContain('SENSITIVE_PROVIDER_BODY');
  });

  it.each(['review-large', 'review-flood'])('bounds independent reviewer output: %s', async (mode) => {
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent(mode) } });
    await expect(review(runtime)).rejects.toThrow('output exceeded');
  });

  it('kills an independent catalog on AbortSignal without sending a prompt', async () => {
    const controller = new AbortController();
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent('catalog-hang') } });
    const result = runtime.models(controller.signal);
    const rejected = expect(result).rejects.toThrow('cancelled or timed out');
    await untilFrame((frame) => frame.kind === 'launch');
    controller.abort();
    await rejected;
    expect(JSON.stringify(await frames())).not.toContain('session/prompt');
    const pid = (await frames()).find((frame) => frame.kind === 'launch')?.pid;
    if (typeof pid !== 'number') throw new Error('Synthetic child PID was not recorded.');
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('kills inference on AbortSignal and never starts another model', async () => {
    const controller = new AbortController();
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent('review-hang') } });
    const result = review(runtime, controller.signal);
    const rejected = expect(result).rejects.toThrow('cancelled or timed out');
    await untilFrame((frame) => frame.kind === 'overlay');
    controller.abort();
    await rejected;
    const launches = (await frames()).filter((frame) => frame.kind === 'launch');
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      const pid = launch.pid;
      if (typeof pid !== 'number') throw new Error('Synthetic child PID was not recorded.');
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it('never spawns for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { omp: agent() } });
    await expect(review(runtime, controller.signal)).rejects.toThrow('cancelled or timed out');
    expect(resolveAgentCommand).not.toHaveBeenCalled();
  });
  it('uses concrete Claude SDK inference with no tools, MCP, hooks, plugins, or saved session', async () => {
    const config = { ...agent(), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    expect(await runtime.review({ agentId: 'claude', accountId: 'captured-account', model: MODEL,
      prompt: '{}', maxOutputTokens: 512, signal: new AbortController().signal })).toBe(REVIEW);
    expect((await frames()).find((frame) => frame.kind === 'sdk')).toMatchObject({
      model: MODEL, tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], plugins: [],
      settings: { disableAllHooks: true }, persistSession: false, maxTurns: 1, maxOutputTokens: '512', authority: [],
      account: join(root, 'account'),
    });
    expect((await frames()).find((frame) => frame.kind === 'permission')).toMatchObject({ result: { behavior: 'deny' } });
  });

  it('omits ambiguous Claude defaults from usable choices and returns a capability explanation', async () => {
    const config = { ...agent('claude-alias'), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    const catalog = await runtime.models(new AbortController().signal);
    expect(catalog.models).toEqual([]);
    expect(catalog.errors).toEqual([{ source: 'claude', message: expect.stringContaining('default does not identify a reviewer model') }]);
    await expect(runtime.review({ agentId: 'claude', accountId: 'captured-account', model: 'default',
      prompt: '{}', maxOutputTokens: 512, signal: new AbortController().signal })).rejects.toThrow('explicit advertised model selector');
    expect((await frames()).some((frame) => frame.kind === 'sdk')).toBe(false);
  });

  it('preserves an explicit advertised Claude family selector unchanged', async () => {
    const config = { ...agent('claude-family'), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    const catalog = await runtime.models(new AbortController().signal);
    expect(catalog.models.map((model) => model.id)).toEqual(['sonnet']);
    expect(catalog.errors).toEqual([]);
    expect(await runtime.review({ agentId: 'claude', accountId: 'captured-account', model: 'sonnet',
      prompt: '{}', maxOutputTokens: 512, signal: new AbortController().signal })).toBe(REVIEW);
    expect((await frames()).find((frame) => frame.kind === 'sdk')?.model).toBe('sonnet');
  });

  it('preserves selected profile inference routing without importing hooks, plugins, or harness authority', async () => {
    await mkdir(join(root, 'account'));
    await writeFile(join(root, 'account', 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://synthetic-gateway.invalid',
        ANTHROPIC_API_KEY: 'synthetic-profile-key',
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_PROFILE: 'synthetic-inference-profile',
        NANACHI_AGENT_TOKEN: 'do-not-copy',
        PATH: 'do-not-copy',
      },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'must-not-run' }] }] },
      enabledPlugins: { 'unsafe-plugin': true },
    }));
    const config = { ...agent(), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    expect(await runtime.review({ agentId: 'claude', accountId: 'captured-account', model: MODEL,
      prompt: '{}', maxOutputTokens: 512, signal: new AbortController().signal })).toBe(REVIEW);
    const observed = (await frames()).find((frame) => frame.kind === 'sdk');
    expect(observed).toMatchObject({ settings: { env: {
      ANTHROPIC_BASE_URL: 'https://synthetic-gateway.invalid', ANTHROPIC_API_KEY: 'synthetic-profile-key',
      CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'synthetic-inference-profile',
    }, disableAllHooks: true, enabledPlugins: {} } });
    expect(JSON.stringify(observed)).not.toContain('must-not-run');
    expect(JSON.stringify(observed)).not.toContain('do-not-copy');
  });

  it('refuses a profile shell credential helper instead of executing it or changing account/provider', async () => {
    await mkdir(join(root, 'account'));
    await writeFile(join(root, 'account', 'settings.json'), JSON.stringify({ apiKeyHelper: 'must-not-run' }));
    const config = { ...agent(), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    await expect(runtime.review({ agentId: 'claude', accountId: 'captured-account', model: MODEL,
      prompt: '{}', maxOutputTokens: 512, signal: new AbortController().signal })).rejects.toThrow('shell credential helper');
    expect((await frames()).some((frame) => frame.kind === 'sdk')).toBe(false);
  });

  it('rejects a Claude tool-use response as data without executing it', async () => {
    const config = { ...agent('sdk-tool'), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    await expect(runtime.review({ agentId: 'claude', accountId: 'captured-account', model: MODEL,
      prompt: '{}', maxOutputTokens: 512, signal: new AbortController().signal })).rejects.toThrow('could not complete the independent review');
    expect((await frames()).filter((frame) => frame.kind === 'launch')).toHaveLength(1);
  });

  it('cancels an independent Claude SDK review through AbortSignal', async () => {
    const config = { ...agent('sdk-hang'), command: 'claude-agent-acp', args: [] };
    const runtime = new LearningAgents({ home: root, accounts: accounts(), agents: { claude: config } });
    const controller = new AbortController();
    const result = runtime.review({ agentId: 'claude', accountId: 'captured-account', model: MODEL,
      prompt: '{}', maxOutputTokens: 512, signal: controller.signal });
    const failure = result.catch((error: unknown) => error);
    try {
      await untilFrame((frame) => frame.kind === 'permission');
    } finally {
      controller.abort();
    }
    expect(await failure).toMatchObject({ message: expect.stringContaining('cancelled or timed out') });
    expect((await frames()).some((frame) => frame.kind === 'sdk-close')).toBe(true);
  });
});
