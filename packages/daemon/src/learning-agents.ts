import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, LearningModel, LearningModelsResponse } from '@nanachi/shared';
import type { AccountLauncher } from './accounts/launch.js';
import { resolveAgentCommand, type AgentCommand } from './agent-command.js';
import { envValue, mergeEnv } from './agent-env.js';
import { agentBinDirs, withPathPrepended } from './agent-path.js';
import { killProcessTree } from './agent-process.js';
import { LearningError } from './learning-errors.js';

export interface LearningAgentsOptions {
  agents: Readonly<Record<string, AgentConfig>>;
  accounts: AccountLauncher;
  home: string;
}

export interface LearningAgentReview {
  agentId: string;
  accountId: string | null;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

type Child = ChildProcessByStdio<Writable, Readable, Readable>;
type Adapter = 'omp' | 'claude';
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const CANCELLED = 'Learning reviewer was cancelled or timed out.';
const FAILED = 'Learning agent could not complete the independent review. Check its installation, model, and account.';
const UNSUPPORTED = 'This agent does not provide a supported inference-only reviewer. Select Oh My Pi, Claude Code, or an HTTP reviewer.';
const MODEL_UNAVAILABLE = 'The exact selected reviewer model is not advertised by this agent and account.';
const NO_ACCOUNT = 'The original reviewer account is no longer available. Select an available reviewer account.';
const OUTPUT_LIMIT = 'Learning agent output exceeded the independent reviewer output limit.';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new LearningError(CANCELLED);
}

/** Keep inference credentials/profile routing, never the primary session's tool authority. */
export function learningAgentEnv(agent: AgentConfig, account: NodeJS.ProcessEnv, inherited = process.env): NodeJS.ProcessEnv {
  const env = withPathPrepended(mergeEnv([inherited, agent.env, account]), agentBinDirs());
  for (const key of Object.keys(env)) {
    if (/^(?:NANACHI_|MCP_|OMP_|PI_AGENT_|PI_SESSION_|CLAUDE_CODE_SSE_|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_CODE_REMOTE_|CLAUDE_CODE_SESSION_|AGENT_SESSION_ID$|CLAUDECODE$|CODEX_THREAD_ID$)/i.test(key)) {
      // These name the inference credential/profile route, not an external tool harness.
      if (!/^(?:OMP_PROFILE|OMP_AUTH_BROKER_URL|OMP_AUTH_BROKER_TOKEN)$/i.test(key)) delete env[key];
    }
  }
  return env;
}

function adapterOf(agent: AgentConfig): Adapter | undefined {
  if (agent.kind !== 'acp') return undefined;
  const command = basename(agent.command).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  if (command === 'omp' && agent.args.length === 1 && agent.args[0] === 'acp') return 'omp';
  if (agent.command === 'claude-agent-acp' && agent.args.length === 0) return 'claude';
  return undefined;
}

/** Catalog is untrusted metadata; only exact nonempty advertised IDs are usable. */
export function learningCatalogModels(
  agentId: string,
  label: string,
  response: { configOptions?: readonly acp.SessionConfigOption[] | null; models?: unknown },
): LearningModel[] {
  const models = new Map<string, LearningModel>();
  for (const option of response.configOptions ?? []) {
    if (option.category !== 'model' || option.type !== 'select') continue;
    const items = option.options.flatMap((entry) =>
      'group' in entry
        ? entry.options.map((item) => ({ item, provider: entry.name }))
        : [{ item: entry, provider: label }],
    );
    for (const { item, provider } of items) {
      if (item.value.length === 0 || item.value.length > 500) continue;
      models.set(item.value, {
        id: item.value,
        label: item.name.slice(0, 500),
        provider: provider.slice(0, 200),
        source: 'agent',
        agentId,
      });
    }
  }
  // Some installed ACP adapters still advertise legacy session.models instead of config options.
  if (models.size === 0 && record(response.models) && Array.isArray(response.models.availableModels)) {
    for (const item of response.models.availableModels) {
      if (!record(item) || typeof item.modelId !== 'string' || item.modelId.length === 0 || item.modelId.length > 500) continue;
      models.set(item.modelId, {
        id: item.modelId,
        label: typeof item.name === 'string' && item.name.length > 0 ? item.name.slice(0, 500) : item.modelId,
        provider: label.slice(0, 200), source: 'agent', agentId,
      });
    }
  }
  return [...models.values()];
}

/** A bounded child scope. No stderr/provider error bytes ever become public errors. */
class ReviewerChild {
  readonly child: Child;
  readonly failed: Promise<never>;
  private readonly closed: Promise<void>;
  private readonly onAbort: () => void;
  private stopped = false;
  private killed = false;
  private rejectFailure!: (error: LearningError) => void;

  constructor(command: AgentCommand, cwd: string, env: NodeJS.ProcessEnv, private readonly signal: AbortSignal) {
    checkSignal(signal);
    this.child = spawn(command.file, command.args, {
      cwd, env, shell: command.shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.failed = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
    void this.failed.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.child.once('close', resolve);
      this.child.once('error', () => { this.fail(FAILED); resolve(); });
    });
    this.child.once('exit', () => { if (!this.stopped) this.fail(FAILED); });
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.on('error', () => this.fail(FAILED));
    let bytes = 0;
    let diagnostics = 0;
    this.child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_WIRE_BYTES) this.fail(OUTPUT_LIMIT);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.byteLength;
      if (diagnostics > MAX_DIAGNOSTIC_BYTES) this.fail(OUTPUT_LIMIT);
    });
    this.onAbort = () => this.fail(CANCELLED);
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
  }

  fail(message: string): void {
    this.rejectFailure(new LearningError(message));
    this.kill();
  }

  private kill(): void {
    const child = this.child;
    if (this.killed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    this.killed = true;
    killProcessTree(child.pid, () => {
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid!, 'SIGKILL'); return; } catch { /* The child may already have exited. */ }
      }
      child.kill('SIGKILL');
    });
  }

  run<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.failed]);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.kill();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    await Promise.race([this.closed, new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      timer.unref();
    })]);
  }
}

/** Independent ACP discovery only: never sends session/prompt, never enters Nanachi's sessions map. */
export class LearningAgents {
  constructor(private readonly options: LearningAgentsOptions) {}

  assertSupported(agentId: string): void {
    const agent = Object.hasOwn(this.options.agents, agentId) ? this.options.agents[agentId] : undefined;
    if (agent === undefined || adapterOf(agent) === undefined) throw new LearningError(UNSUPPORTED);
  }

  async models(signal: AbortSignal): Promise<LearningModelsResponse> {
    const result: LearningModelsResponse = { models: [], errors: [] };
    for (const [agentId, agent] of Object.entries(this.options.agents)) {
      checkSignal(signal);
      try {
        this.assertSupported(agentId);
        const accountId = this.options.accounts.choose(agentId, undefined);
        const models = await this.catalog(agentId, agent, accountId, signal);
        if (models.length === 0) throw new LearningError('This agent did not advertise a reviewer model catalog.');
        if (adapterOf(agent) === 'claude') {
          const explicit = models.filter((model) => model.id !== 'default');
          if (explicit.length !== models.length) {
            result.errors.push({
              source: agentId,
              message: 'Claude default does not identify a reviewer model. Select an explicit advertised model or family selector.',
            });
          }
          result.models.push(...explicit);
        } else result.models.push(...models);
      } catch (error) {
        checkSignal(signal);
        result.errors.push({ source: agentId, message: error instanceof LearningError ? error.message : 'Could not discover models for this configured agent and account.' });
      }
    }
    return result;
  }

  async review(input: LearningAgentReview): Promise<string> {
    checkSignal(input.signal);
    this.assertSupported(input.agentId);
    const agent = this.options.agents[input.agentId];
    if (agent === undefined) throw new LearningError(UNSUPPORTED);
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 256 || input.maxOutputTokens > 8192) {
      throw new LearningError('The reviewer output token limit must be between 256 and 8192.');
    }
    try {
      const catalog = await this.catalog(input.agentId, agent, input.accountId, input.signal);
      if (!catalog.some((model) => model.id === input.model)) throw new LearningError(MODEL_UNAVAILABLE);
      const env = await this.environment(input.agentId, agent, input.accountId, input.signal);
      return await this.temporary(input.signal, async (cwd) => {
        if (adapterOf(agent) === 'omp') return this.ompReview(agent, env, cwd, input);
        return this.claudeReview(env, cwd, input);
      });
    } catch (error) {
      checkSignal(input.signal);
      throw error instanceof LearningError ? error : new LearningError(FAILED);
    }
  }

  private async temporary<T>(signal: AbortSignal, operation: (cwd: string) => Promise<T>): Promise<T> {
    const root = join(this.options.home, 'learning-tmp');
    await mkdir(root, { recursive: true, mode: 0o700 });
    checkSignal(signal);
    const cwd = await mkdtemp(join(root, 'review-'));
    try { checkSignal(signal); return await operation(cwd); }
    finally { await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined); }
  }

  private async environment(agentId: string, agent: AgentConfig, accountId: string | null, signal: AbortSignal): Promise<NodeJS.ProcessEnv> {
    checkSignal(signal);
    if (this.options.accounts.effective(agentId, accountId) !== accountId) throw new LearningError(NO_ACCOUNT);
    await this.options.accounts.prepare(agentId, accountId);
    checkSignal(signal);
    if (this.options.accounts.effective(agentId, accountId) !== accountId) throw new LearningError(NO_ACCOUNT);
    return learningAgentEnv(agent, this.options.accounts.env(agentId, accountId));
  }

  private async catalog(agentId: string, agent: AgentConfig, accountId: string | null, signal: AbortSignal): Promise<LearningModel[]> {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const env = await this.environment(agentId, agent, accountId, boundedSignal);
    return this.temporary(boundedSignal, async (cwd) => {
      const scope = new ReviewerChild(resolveAgentCommand(agent.command, agent.args, env), cwd, env, boundedSignal);
      const app = acp.client({ name: 'nanachi-learning-catalog' })
        .onNotification(acp.methods.client.session.update, () => undefined)
        .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }));
      const connection = app.connect(acp.ndJsonStream(Writable.toWeb(scope.child.stdin), Readable.toWeb(scope.child.stdout)));
      try {
        await scope.run(connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }));
        const created = await scope.run(connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }));
        return learningCatalogModels(agentId, agent.label, created);
      } finally {
        connection.close();
        await scope.close();
      }
    });
  }

  private async ompReview(agent: AgentConfig, env: NodeJS.ProcessEnv, cwd: string, input: LearningAgentReview): Promise<string> {
    // Unlike `--no-tools`, this route never constructs an AgentSession or executes tool calls.
    // Installed omp 18.13.2: cli/auth-gateway-stdio.ts + ai/auth-gateway/server.ts.
    // Disable the gateway selector's configured model fallbacks without changing the owner's config.
    const overlay = join(cwd, 'inference.yml');
    await writeFile(overlay, 'retry:\n  modelFallback: false\n', { mode: 0o600 });
    checkSignal(input.signal);
    const configFiles = envValue(env, 'PI_CONFIG_FILES');
    const gatewayEnv = mergeEnv([env, { PI_CONFIG_FILES: configFiles ? `${configFiles}${delimiter}${overlay}` : overlay }]);
    const scope = new ReviewerChild(resolveAgentCommand(agent.command, ['auth-gateway', 'stdio'], gatewayEnv), cwd, gatewayEnv, input.signal);
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: LearningError) => void }>();
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer): void => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_WIRE_BYTES) { scope.fail(OUTPUT_LIMIT); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { scope.fail(FAILED); return; }
        if (!record(frame)) { scope.fail(FAILED); return; }
        if (frame.ready === true) continue;
        if (typeof frame.id !== 'number') { scope.fail(FAILED); return; }
        const waiter = pending.get(frame.id);
        if (waiter === undefined) continue;
        pending.delete(frame.id);
        if (frame.status !== 200) waiter.reject(new LearningError(FAILED));
        else waiter.resolve(frame);
      }
    };
    scope.child.stdout.on('data', onData);
    const request = (id: number, path: string, body?: unknown): Promise<Record<string, unknown>> => scope.run(new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      scope.child.stdin.write(`${JSON.stringify({ id, path, ...(body === undefined ? {} : { body }) })}\n`);
    }));
    try {
      const listed = await request(1, '/v1/models');
      if (!record(listed.body) || !Array.isArray(listed.body.data) || !listed.body.data.some((model) => record(model) && model.id === input.model)) {
        throw new LearningError(MODEL_UNAVAILABLE);
      }
      const response = await request(2, '/v1/chat/completions', {
        model: input.model, messages: [
          { role: 'system', content: 'You are an independent procedural memory reviewer. Return only the requested JSON.' },
          { role: 'user', content: input.prompt },
        ],
        tools: [], tool_choice: 'none', stream: false, max_tokens: input.maxOutputTokens,
      });
      if (!record(response.body) || !Array.isArray(response.body.choices)) throw new LearningError(FAILED);
      const choice: unknown = response.body.choices[0];
      if (!record(choice) || !record(choice.message) || typeof choice.message.content !== 'string' ||
          (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0)) throw new LearningError(FAILED);
      const text = choice.message.content;
      if (Buffer.byteLength(text, 'utf8') > input.maxOutputTokens * 16) throw new LearningError(OUTPUT_LIMIT);
      return text;
    } finally {
      scope.child.stdout.off('data', onData);
      pending.clear();
      await scope.close();
    }
  }

  private async claudeProfileEnv(env: NodeJS.ProcessEnv, input: LearningAgentReview): Promise<Record<string, string>> {
    const home = envValue(env, 'CLAUDE_CONFIG_DIR') ?? this.options.accounts.principalOf(input.agentId)?.home ?? join(homedir(), '.claude');
    const handle = await open(join(home, 'settings.json'), 'r').catch((error: unknown) => {
      if (record(error) && error.code === 'ENOENT') return undefined;
      throw new LearningError('Could not read the selected Claude reviewer profile settings.');
    });
    if (handle === undefined) return {};
    try {
      checkSignal(input.signal);
      const bytes = Buffer.alloc(128 * 1024 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 128 * 1024) throw new LearningError('The selected Claude reviewer profile settings exceed the safe read limit.');
      let settings: unknown;
      try { settings = JSON.parse(bytes.toString('utf8', 0, bytesRead)); }
      catch { throw new LearningError('The selected Claude reviewer profile settings are not valid JSON.'); }
      if (!record(settings)) throw new LearningError('The selected Claude reviewer profile settings must be a JSON object.');
      for (const helper of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh']) {
        if (typeof settings[helper] === 'string' && settings[helper].trim().length > 0) {
          throw new LearningError('This Claude account requires a shell credential helper, which cannot run in inference-only learning. Configure direct inference credentials or another reviewer.');
        }
      }
      if (settings.env === undefined) return {};
      if (!record(settings.env)) throw new LearningError('The selected Claude reviewer profile environment is invalid.');
      const inference: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings.env)) {
        if (!/^(?:ANTHROPIC_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_|VERTEX_|AZURE_|FOUNDRY_|CLAUDE_MODEL_CONFIG$|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)$|CLAUDE_CODE_SKIP_(?:BEDROCK_AUTH|VERTEX_AUTH)$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$|SSL_CERT_FILE$)/i.test(key)) continue;
        if (typeof value !== 'string') throw new LearningError('The selected Claude reviewer inference environment must contain string values.');
        inference[key] = value;
      }
      checkSignal(input.signal);
      return inference;
    } finally { await handle.close(); }
  }

  private async claudeReview(env: NodeJS.ProcessEnv, cwd: string, input: LearningAgentReview): Promise<string> {
    // Explicit advertised aliases are provider selectors, forwarded unchanged. Never guess what `default` means.
    if (input.model === 'default') {
      throw new LearningError('Claude learning requires an explicit advertised model selector instead of unresolved default.');
    }
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
    const sdkPath = createRequire(manifest).resolve('@anthropic-ai/claude-agent-sdk');
    // Runtime-selected SDK: resolve from the installed ACP adapter, not a separately chosen Claude installation.
    const sdk: typeof ClaudeSdk = await import(pathToFileURL(sdkPath).href);
    const profileEnv = await this.claudeProfileEnv(env, input);
    checkSignal(input.signal);
    const controller = new AbortController();
    const children = new Set<ReviewerChild>();
    const onAbort = (): void => { controller.abort(); for (const child of children) child.fail(CANCELLED); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    let query: ClaudeSdk.Query | undefined;
    try {
      query = sdk.query({ prompt: input.prompt, options: {
      cwd, env: mergeEnv([env, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxOutputTokens), CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' }]),
      model: input.model, tools: [], allowedTools: [], disallowedTools: ['mcp__*'], skills: [],
      mcpServers: {}, strictMcpConfig: true, settingSources: [], plugins: [], agents: {}, hooks: {},
      settings: { env: profileEnv, disableAllHooks: true, enabledPlugins: {}, syncClaudeAiSkills: false, syncClaudeAiPlugins: false },
      permissionMode: 'dontAsk', canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for learning review.' }),
      persistSession: false, maxTurns: 1, promptSuggestions: false, abortController: controller,
      ...(envValue(env, 'CLAUDE_CODE_EXECUTABLE') === undefined ? {} : { pathToClaudeCodeExecutable: envValue(env, 'CLAUDE_CODE_EXECUTABLE')! }),
      spawnClaudeCodeProcess: (options) => {
        const child = new ReviewerChild({ file: options.command, args: options.args, shell: false }, cwd, learningAgentEnv({ label: '', command: '', args: [], env: {}, kind: 'acp' }, options.env, {}), input.signal);
        children.add(child);
        void child.failed.catch(() => controller.abort());
        return child.child;
      },
    } });
      let result: string | undefined;
      let receivedBytes = 0;
      for await (const message of query) {
        checkSignal(input.signal);
        receivedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (receivedBytes > MAX_WIRE_BYTES) throw new LearningError(OUTPUT_LIMIT);
        if (message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use')) throw new LearningError(FAILED);
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) throw new LearningError(FAILED);
          if (Buffer.byteLength(message.result, 'utf8') > input.maxOutputTokens * 16) throw new LearningError(OUTPUT_LIMIT);
          result = message.result;
        }
      }
      if (result === undefined) throw new LearningError(FAILED);
      return result;
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      controller.abort();
      query?.close();
      await Promise.all([...children].map((child) => child.close()));
    }
  }
}
