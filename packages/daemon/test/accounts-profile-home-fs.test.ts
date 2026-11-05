import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_ADAPTERS } from '../src/accounts/adapters.js';
import { prepareProfile, removeProfileHome } from '../src/accounts/profile-home.js';
import { removeTempDir } from './temp.js';

/*
 * Failure paths of profile-home.ts that a real file system does not produce on demand: a rename that fails, a junction
 * that appears between the check and the create, and the errors Windows gives for a busy or locked file. The wrapped
 * functions call the real implementation unless a test installs a hook.
 */

type AnyFn = (...args: never[]) => Promise<unknown>;

const hooks = vi.hoisted(() => ({
  overrides: {} as Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>,
  calls: [] as Array<{ name: string; args: unknown[] }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ['rename', 'symlink', 'unlink', 'rmdir', 'chmod'] as const) {
    const real = actual[name] as unknown as AnyFn;
    wrapped[name] = (...args: unknown[]): Promise<unknown> => {
      hooks.calls.push({ name, args });
      const override = hooks.overrides[name];
      return override !== undefined ? override(...args) : (real as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  }
  return wrapped;
});

const claude = ACCOUNT_ADAPTERS.claude;
if (claude === undefined) throw new Error('claude adapter missing');

let root: string;
let nanachi: string;
let principal: string;
let profile: string;
let warnings: string[];
const warn = (message: string): void => {
  warnings.push(message);
};

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

beforeEach(async () => {
  hooks.overrides = {};
  hooks.calls = [];
  root = await mkdtemp(join(tmpdir(), 'nanachi-profile-fs-'));
  nanachi = join(root, 'nanachi');
  principal = join(root, 'principal');
  profile = join(nanachi, 'accounts', 'claude', 'a1');
  warnings = [];
  await mkdir(join(principal, 'projects'), { recursive: true });
});

afterEach(async () => {
  hooks.overrides = {};
  await removeTempDir(root);
});

describe('prepareProfile: file system races', () => {
  it('EEXIST while creating a junction: the junction the other prepare made is accepted', async () => {
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).symlink;
    hooks.overrides.symlink = async (target, path, type) => {
      // Another prepare wins the race: it creates the junction first, then ours fails.
      await real(target as string, path as string, type as 'junction');
      throw errno('EEXIST');
    };

    await expect(prepareProfile(claude, principal, profile, { warn })).resolves.toBeUndefined();

    expect(warnings).toEqual([]);
  });

  it('EEXIST with something else in the place (a real folder): a warning, no failure, nothing deleted', async () => {
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir;
    hooks.overrides.symlink = async (_target, path) => {
      await real(path as string, { recursive: true });
      await writeFile(join(path as string, 'mine.txt'), 'profile data');
      throw errno('EEXIST');
    };

    await expect(prepareProfile(claude, principal, profile, { warn })).resolves.toBeUndefined();

    expect(warnings.length).toBeGreaterThan(0);
    expect(await readFile(join(profile, 'projects', 'mine.txt'), 'utf8')).toBe('profile data');
  });

  it('removes the temporary file when the atomic rename of .claude.json fails, and reports the failure', async () => {
    const stateFile = join(principal, '.claude.json');
    await writeFile(stateFile, JSON.stringify({ theme: 'dark' }));
    hooks.overrides.rename = () => Promise.reject(errno('EPERM'));

    await expect(prepareProfile(claude, principal, profile, { warn, principalStateFile: stateFile })).rejects.toMatchObject({
      code: 'EPERM',
    });

    expect((await readdir(profile)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('removeProfileHome: busy and locked files', () => {
  const FAST = { retryDelayMs: 1 };

  async function profileWith(file: string): Promise<string> {
    await mkdir(profile, { recursive: true });
    const path = join(profile, file);
    await writeFile(path, 'x');
    return path;
  }

  it('EPERM on a file: clears the read-only attribute (chmod 0o666) and retries', async () => {
    const file = await profileWith('locked.txt');
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).unlink;
    let failures = 1;
    hooks.overrides.unlink = (path) => {
      if ((path as string) === file && failures > 0) {
        failures -= 1;
        return Promise.reject(errno('EPERM'));
      }
      return real(path as string);
    };

    await removeProfileHome(nanachi, 'claude', profile, FAST);

    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(hooks.calls.filter((call) => call.name === 'chmod').map((call) => [call.args[0], call.args[1]])).toEqual([[file, 0o666]]);
  });

  it('EBUSY on a file: retries a few times and then succeeds', async () => {
    const file = await profileWith('busy.txt');
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).unlink;
    let failures = 3;
    hooks.overrides.unlink = (path) => {
      if ((path as string) === file && failures > 0) {
        failures -= 1;
        return Promise.reject(errno('EBUSY'));
      }
      return real(path as string);
    };

    await removeProfileHome(nanachi, 'claude', profile, FAST);

    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(failures).toBe(0);
  });

  it('ENOTEMPTY on the folder (something appeared meanwhile): lists again and removes it', async () => {
    await profileWith('a.txt');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let first = true;
    hooks.overrides.rmdir = async (path) => {
      if ((path as string) === profile && first) {
        first = false;
        await writeFile(join(profile, 'late.txt'), 'created while deleting');
        throw errno('ENOTEMPTY');
      }
      return actual.rmdir(path as string);
    };

    await removeProfileHome(nanachi, 'claude', profile, FAST);

    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives up after the retries and reports the error; the other files of the profile were already removed', async () => {
    const file = await profileWith('stuck.txt');
    hooks.overrides.unlink = (path) => {
      if ((path as string) === file) return Promise.reject(errno('EBUSY'));
      return Promise.resolve();
    };

    await expect(removeProfileHome(nanachi, 'claude', profile, { retries: 2, retryDelayMs: 1 })).rejects.toMatchObject({
      code: 'EBUSY',
    });

    expect(hooks.calls.filter((call) => call.name === 'unlink' && call.args[0] === file)).toHaveLength(3);
  });

  it('a junction is only unlinked: never chmod-ed and never followed (the principal file survives)', async () => {
    await mkdir(join(principal, 'projects'), { recursive: true });
    await writeFile(join(principal, 'projects', 'keep.txt'), 'principal');
    await mkdir(profile, { recursive: true });
    await symlink(join(principal, 'projects'), join(profile, 'projects'), 'junction');

    await removeProfileHome(nanachi, 'claude', profile, FAST);

    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(principal, 'projects', 'keep.txt'), 'utf8')).toBe('principal');
    expect(hooks.calls.filter((call) => call.name === 'chmod')).toEqual([]);
  });
});
