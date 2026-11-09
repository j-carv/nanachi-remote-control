import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, ServerMessage, Session, SessionConfigOption } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createWorkspace,
  fakeAgent,
  fetchConfigOptions,
  isEvent,
  listen,
  pairToken,
  WsTestClient,
} from './agent-support.js';
import { listEvents, updateSession } from '../src/repository.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Work modes per agent (see src/agent-modes.ts). The fake agent is the same for every case; the id the daemon registers
 * it under picks the rule: `omp` offers only its default mode, any other id offers what the agent announces.
 */

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-modes-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registered before setupDaemonTests: vitest runs afterEach hooks in stack order, so this one runs last, after the
// daemons have killed their agents (the agents keep the workspace as their cwd).
const daemonEnv = setupDaemonTests();

/** Starts a daemon with these agents (id -> config). Each test starts its own, because the agent style comes from its env. */
async function start(agents: Record<string, AgentConfig>): Promise<TestDaemon> {
  return daemonEnv.start({ config: { allowedRoots: [base], agents } });
}

function fake(extraEnv: Record<string, string> = {}): AgentConfig {
  return fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, ...extraEnv });
}

function modeOf(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find((option) => option.category === 'mode');
}

/** Mode values the mode option offers (empty when there is no mode option). */
function offeredModes(options: readonly SessionConfigOption[]): string[] {
  const mode = modeOf(options);
  return mode?.type === 'select' ? mode.options.map((choice) => choice.value) : [];
}

async function subscribe(daemon: TestDaemon, sessionId: string): Promise<WsTestClient> {
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return client;
}

async function createOmp(daemon: TestDaemon, config?: Record<string, string>): Promise<Session> {
  return createSession(daemon, {
    workspaceId: await createWorkspace(daemon, workspace),
    agent: 'omp',
    ...(config === undefined ? {} : { config }),
  });
}

/** ACP methods the fake agent received in this session (the fixture logs each one; see fixtures/fake-agent.ts). */
async function agentMethods(sessionId: string): Promise<string[]> {
  const text = await readFile(join(pidDir, `${sessionId}.methods.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string);
}

const isErrorFor = (sessionId: string) => (message: ServerMessage) =>
  message.type === 'error' && message.sessionId === sessionId;

/** A config message for the session whose mode is already at the given value. */
const modeChangedTo = (sessionId: string, currentValue: string) => (message: ServerMessage) => {
  if (message.type !== 'config_options' || message.sessionId !== sessionId) return false;
  const mode = modeOf(message.configOptions);
  return mode?.type === 'select' && mode.currentValue === currentValue;
};

describe('omp: the work modes Nanachi offers', () => {
  it('offers only its default mode, and the other options are kept', async () => {
    const daemon = await start({ omp: fake() });
    const session = await createOmp(daemon);

    const options = await fetchConfigOptions(daemon, session.id);
    expect(options.map((option) => option.id)).toEqual(['mode', 'model', 'thought', 'ultra']);
    expect(offeredModes(options)).toEqual(['default']);
  });

  it('refuses set_config to plan, and the agent is never asked for it', async () => {
    const daemon = await start({ omp: fake() });
    const session = await createOmp(daemon);
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'set_config', sessionId: session.id, configId: 'mode', value: 'plan' });
    const refused = await client.waitFor(isErrorFor(session.id));
    expect(refused).toMatchObject({ type: 'error', sessionId: session.id });
    await client.sync();

    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default']);
    expect(await agentMethods(session.id)).not.toContain('session/set_config_option');
    await client.close();
  });

  it('starting in plan, keeps plan as the current mode, and switching back to default works', async () => {
    const daemon = await start({ omp: fake({ FAKE_AGENT_MODE: 'plan' }) });
    const session = await createOmp(daemon);
    expect(modeOf(await fetchConfigOptions(daemon, session.id))).toMatchObject({ currentValue: 'plan' });
    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default', 'plan']);

    const client = await subscribe(daemon, session.id);
    client.send({ type: 'set_config', sessionId: session.id, configId: 'mode', value: 'default' });
    await client.waitFor(modeChangedTo(session.id, 'default'));

    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default']);
    await client.close();
  });

  it('announcing only modes (no config options), the mode it synthesises offers only its default', async () => {
    const daemon = await start({ omp: fake({ FAKE_AGENT_STYLE: 'modes' }) });
    const session = await createOmp(daemon);
    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default']);

    const client = await subscribe(daemon, session.id);
    client.send({ type: 'set_config', sessionId: session.id, configId: 'mode', value: 'plan' });
    await client.waitFor(isErrorFor(session.id));
    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default']);
    await client.close();
  });

  it('a config_option_update from the agent reaches the chat with only the offered modes', async () => {
    const daemon = await start({ omp: fake() });
    const session = await createOmp(daemon);
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'prompt', sessionId: session.id, text: 'config' });
    await client.waitFor((message) => {
      if (message.type !== 'config_options' || message.sessionId !== session.id) return false;
      return message.configOptions.some((option) => option.id === 'thought' && option.type === 'select' && option.currentValue === 'high');
    });

    const sent = client.messages.flatMap((message) =>
      message.type === 'config_options' && message.sessionId === session.id ? [message.configOptions] : [],
    );
    expect(offeredModes(sent[sent.length - 1] ?? [])).toEqual(['default']);
    await client.close();
  });

  it('when the agent itself switches to plan (current_mode_update), plan shows as the current mode', async () => {
    const daemon = await start({ omp: fake() });
    const session = await createOmp(daemon);
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'prompt', sessionId: session.id, text: 'modo-plano' });
    await client.waitFor(isEvent('turn_end'));

    const options = await fetchConfigOptions(daemon, session.id);
    expect(modeOf(options)).toMatchObject({ currentValue: 'plan' });
    expect(offeredModes(options)).toEqual(['default', 'plan']);
    await client.close();
  });

  it('a mode list stored before this rule reads back with only the offered modes', async () => {
    const daemon = await start({ omp: fake() });
    const session = await createOmp(daemon);
    // The row an older daemon wrote for omp: both modes, current default.
    const legacy: SessionConfigOption[] = [
      {
        id: 'mode',
        name: 'Acesso',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Padrão' },
          { value: 'plan', name: 'Plano' },
        ],
      },
    ];
    updateSession(daemon.db, session.id, { configOptions: legacy }, Date.now());

    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default']);
  });

  it('a plan sent when the session is created is refused with an error event, and the session starts in default', async () => {
    const daemon = await start({ omp: fake() });
    const session = await createOmp(daemon, { mode: 'plan' });

    const options = await fetchConfigOptions(daemon, session.id);
    expect(modeOf(options)).toMatchObject({ currentValue: 'default' });
    expect(offeredModes(options)).toEqual(['default']);
    const events = listEvents(daemon.db, session.id, 0, 100);
    expect(events.some((event) => event.kind === 'error' && event.message.includes('plan'))).toBe(true);
  });
});

describe('the other agents keep every mode they announce', () => {
  it('a session created in plan under another id keeps plan, with no error, and the agent gets the change', async () => {
    const daemon = await start({ claude: fake() });
    const session = await createSession(daemon, {
      workspaceId: await createWorkspace(daemon, workspace),
      agent: 'claude',
      config: { mode: 'plan' },
    });

    const options = await fetchConfigOptions(daemon, session.id);
    expect(modeOf(options)).toMatchObject({ currentValue: 'plan' });
    expect(offeredModes(options)).toEqual(['default', 'plan']);
    const events = listEvents(daemon.db, session.id, 0, 100);
    expect(events.some((event) => event.kind === 'error')).toBe(false);
    expect(await agentMethods(session.id)).toContain('session/set_config_option');
  });

  it('set_config to plan under another id is applied', async () => {
    const daemon = await start({ claude: fake() });
    const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon, workspace), agent: 'claude' });
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'set_config', sessionId: session.id, configId: 'mode', value: 'plan' });
    await client.waitFor(modeChangedTo(session.id, 'plan'));

    expect(offeredModes(await fetchConfigOptions(daemon, session.id))).toEqual(['default', 'plan']);
    await client.close();
  });
});
