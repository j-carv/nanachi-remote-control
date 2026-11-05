import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError } from '../src/api-error.js';
import { createAccountLauncher, type AccountLauncher } from '../src/accounts/launch.js';
import { createAccountsService, MAX_EXTRA_ACCOUNTS, type AccountsService } from '../src/accounts/service.js';
import type { AgentAccountsService } from '../src/agent-accounts.js';
import { openDatabase } from '../src/db.js';
import { countAgentProfiles, findAgentProfile, insertSession, listAgentProfiles } from '../src/repository.js';
import { removeTempDir } from './temp.js';

/*
 * AccountsService (accounts/service.ts) with the real launcher, database and folders (all temporary). What it checks:
 * every prepare goes through the launcher's queue, the limit of accounts holds under concurrent creates, and a removal
 * is refused while something still uses the account and keeps the folder from coming back while it runs.
 */

let dir: string;
let db: Database.Database;
let nanachiHome: string;
let userHome: string;
let principalClaude: string;
let warnings: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-accounts-service-'));
  db = openDatabase(join(dir, 'data.db'));
  nanachiHome = join(dir, 'nanachi');
  userHome = join(dir, 'user');
  principalClaude = join(dir, 'principal-claude');
  warnings = [];
  await mkdir(join(principalClaude, 'projects'), { recursive: true });
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

function agentsWith(claudeEnv: Record<string, string>): Record<string, AgentConfig> {
  return {
    claude: { label: 'Claude', command: 'claude-agent-acp', args: [], env: claudeEnv, kind: 'acp' },
    omp: { label: 'Oh My Pi', command: 'omp', args: [], env: {}, kind: 'acp' },
  };
}

const agents = agentsWith({});

const principal: AgentAccountsService = { list: () => Promise.resolve([]) };

interface Rig {
  launcher: AccountLauncher;
  prepare: MockInstance<AccountLauncher['prepare']>;
  service: AccountsService;
}

/** Real launcher (its `prepare` is only watched, never replaced) and a service wired to it. */
function rig(options: { daemonEnv?: NodeJS.ProcessEnv; inUse?: (agent: string, account: string) => boolean; release?: () => Promise<void> } = {}): Rig {
  const configured = agentsWith({ CLAUDE_CONFIG_DIR: principalClaude });
  const launcher = createAccountLauncher({
    db,
    agents: configured,
    nanachiHome,
    userHome,
    daemonEnv: options.daemonEnv ?? {},
    log: (message) => warnings.push(message),
  });
  const prepare = vi.spyOn(launcher, 'prepare');
  const service = createAccountsService({
    db,
    agents: configured,
    nanachiHome,
    principal,
    launcher,
    userHome,
    daemonEnv: options.daemonEnv ?? {},
    log: (message) => warnings.push(message),
    isAccountInUse: options.inUse,
    releaseAccount: options.release === undefined ? undefined : options.release,
    // No process in these tests: a login that gets as far as starting one fails at once.
    login: {
      spawn: () => {
        throw new Error('no process in this test');
      },
    },
  });
  return { launcher, prepare, service };
}

function profileHome(agent: string, accountId: string): string {
  return join(nanachiHome, 'accounts', agent, accountId);
}

describe('create', () => {
  it('prepares the folder through the launcher, after the row exists', async () => {
    const { prepare, service } = rig();
    let rowWasThere: boolean | undefined;
    prepare.mockImplementationOnce(async (agentId, accountId) => {
      rowWasThere = accountId !== null && findAgentProfile(db, agentId, accountId) !== undefined;
    });

    const profile = await service.create('claude', 'Trabalho');

    expect(prepare).toHaveBeenCalledWith('claude', profile.id);
    expect(rowWasThere).toBe(true);
    expect(findAgentProfile(db, 'claude', profile.id)?.label).toBe('Trabalho');
  });

  it('really prepares the profile folder (junctions to the principal)', async () => {
    const { service } = rig();

    const profile = await service.create('claude', 'Trabalho');

    expect(existsSync(join(profileHome('claude', profile.id), 'projects'))).toBe(true);
  });

  it('a failed prepare rolls the row back and leaves no folder behind, and the error is reported', async () => {
    // `accounts` is a plain file: the profile folder cannot be made inside it.
    await mkdir(nanachiHome, { recursive: true });
    await writeFile(join(nanachiHome, 'accounts'), 'file');
    const { service } = rig();

    await expect(service.create('claude', 'Trabalho')).rejects.toThrow();

    expect(listAgentProfiles(db, 'claude')).toEqual([]);
  });

  it('the limit holds under concurrent creates: exactly the maximum succeed, the rest are 409 too_many_accounts', async () => {
    const { service } = rig();

    const outcomes = await Promise.allSettled(Array.from({ length: MAX_EXTRA_ACCOUNTS + 4 }, (_, index) => service.create('claude', `Conta ${index}`)));

    const created = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));
    expect(created).toHaveLength(MAX_EXTRA_ACCOUNTS);
    expect(refused).toHaveLength(4);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(ApiError);
      expect(reason).toMatchObject({ status: 409, code: 'too_many_accounts' });
    }
    expect(countAgentProfiles(db, 'claude')).toBe(MAX_EXTRA_ACCOUNTS);
  });

  it('the limit is per agent', async () => {
    const { service } = rig();
    for (let index = 0; index < MAX_EXTRA_ACCOUNTS; index += 1) await service.create('claude', `Conta ${index}`);

    await expect(service.create('claude', 'Mais uma')).rejects.toMatchObject({ code: 'too_many_accounts' });
    expect(countAgentProfiles(db, 'claude')).toBe(MAX_EXTRA_ACCOUNTS);
  });
});

describe('login', () => {
  it('prepares the folder of an extra account through the launcher queue, not directly', async () => {
    const { prepare, service } = rig();
    const profile = await service.create('claude', 'Trabalho');
    prepare.mockClear();

    await service.startLogin('claude', profile.id);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith('claude', profile.id);
  });

  it('the principal login prepares nothing', async () => {
    const { prepare, service } = rig();

    await service.startLogin('claude', 'default');

    expect(prepare).not.toHaveBeenCalled();
  });

  it('login and a session prepare on the same account at once do not step on each other', async () => {
    const { launcher, service } = rig();
    const profile = await service.create('claude', 'Trabalho');

    const results = await Promise.all([
      service.startLogin('claude', profile.id),
      launcher.prepare('claude', profile.id),
      launcher.prepare('claude', profile.id),
    ]);

    // The login ends in `failed` only because there is no process in this test; it must not be the folder that failed.
    expect(results[0]).toMatchObject({ state: 'failed' });
    expect(results[0].error).not.toContain('pasta');
  });
});

describe('remove', () => {
  it('refuses with 409 account_in_use while something in memory uses the account, and touches nothing', async () => {
    const { launcher, service } = rig({ inUse: (agent, account) => agent === 'claude' && account !== '' });
    const profile = await service.create('claude', 'Trabalho');

    await expect(service.remove('claude', profile.id)).rejects.toMatchObject({ status: 409, code: 'account_in_use' });

    expect(findAgentProfile(db, 'claude', profile.id)).toBeDefined();
    expect(existsSync(profileHome('claude', profile.id))).toBe(true);
    expect(launcher.isRemoving('claude', profile.id)).toBe(false);
  });

  it('refuses while a session row on the account is starting, running, awaiting permission or idle', async () => {
    const { service } = rig();
    const profile = await service.create('claude', 'Trabalho');
    insertSession(db, {
      id: 's1',
      workspaceId: 'w1',
      agent: 'claude',
      title: 't',
      status: 'idle',
      createdAt: 1,
      accountId: profile.id,
    });

    await expect(service.remove('claude', profile.id)).rejects.toMatchObject({ status: 409, code: 'account_in_use' });
  });

  it('while it runs, new prepares of the account are refused and the folder does not come back', async () => {
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      letGo = resolveGate;
    });
    const { launcher, service } = rig({ release: () => gate });
    const profile = await service.create('claude', 'Trabalho');
    const home = profileHome('claude', profile.id);

    const removal = service.remove('claude', profile.id);
    await new Promise((resolveTick) => setImmediate(resolveTick));

    expect(launcher.isRemoving('claude', profile.id)).toBe(true);
    await expect(launcher.prepare('claude', profile.id)).rejects.toMatchObject({ name: 'AccountRemovingError' });
    const login = await service.startLogin('claude', profile.id);
    expect(login.state).toBe('failed');
    // A second removal of the same account does not run on top of the first.
    await expect(service.remove('claude', profile.id)).rejects.toMatchObject({ status: 409, code: 'account_in_use' });

    letGo();
    await removal;

    expect(existsSync(home)).toBe(false);
    expect(findAgentProfile(db, 'claude', profile.id)).toBeUndefined();
    expect(launcher.isRemoving('claude', profile.id)).toBe(false);
  });

  it('the mark is lifted when the removal fails, and the account is usable again', async () => {
    let fail = true;
    const { launcher, service } = rig({
      release: () => (fail ? Promise.reject(new Error('could not release')) : Promise.resolve()),
    });
    const profile = await service.create('claude', 'Trabalho');

    await expect(service.remove('claude', profile.id)).rejects.toThrow('could not release');

    expect(launcher.isRemoving('claude', profile.id)).toBe(false);
    expect(findAgentProfile(db, 'claude', profile.id)).toBeDefined();
    await launcher.prepare('claude', profile.id);
    fail = false;
    await service.remove('claude', profile.id);
    expect(findAgentProfile(db, 'claude', profile.id)).toBeUndefined();
  });

});

describe('principal login in a polluted daemon environment', () => {
  it('the login of the principal does not inherit a home variable that points into accounts', async () => {
    const polluted = profileHome('claude', 'outra-conta');
    const seen: Array<NodeJS.ProcessEnv> = [];
    const launcher = createAccountLauncher({
      db,
      agents,
      nanachiHome,
      userHome,
      daemonEnv: { CLAUDE_CONFIG_DIR: polluted },
      log: (message) => warnings.push(message),
    });
    const service = createAccountsService({
      db,
      agents,
      nanachiHome,
      principal,
      launcher,
      userHome,
      daemonEnv: { CLAUDE_CONFIG_DIR: polluted },
      login: {
        spawn: (_command, options) => {
          seen.push(options.env);
          throw new Error('no process in this test');
        },
        resolveLogin: () => ({ file: 'fake', args: [], shell: false }),
      },
    });

    await service.startLogin('claude', 'default');

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] ?? {}).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual([]);
  });
});
