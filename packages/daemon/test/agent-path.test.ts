import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { agentBinDirs, phoneSendBinDir, withPathPrepended } from '../src/agent-path.js';
import { removeTempDir } from './temp.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nanachi-path-'));
});

afterEach(async () => {
  await removeTempDir(base);
});

/** Monta um monorepo em `base/<name>` (raiz/packages/daemon/src) e devolve a URL de um módulo dentro dele. */
async function monorepo(name: string, options: { root: boolean; daemon: boolean }): Promise<{ src: string; dist: string }> {
  const root = join(base, name);
  const daemonRoot = join(root, 'packages', 'daemon');
  if (options.root) await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  if (options.daemon) await mkdir(join(daemonRoot, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(daemonRoot, 'src'), { recursive: true });
  await mkdir(join(daemonRoot, 'dist'), { recursive: true });
  return {
    src: pathToFileURL(join(daemonRoot, 'src', 'agent-path.ts')).href,
    dist: pathToFileURL(join(daemonRoot, 'dist', 'agent-path.js')).href,
  };
}

describe('agentBinDirs', () => {
  it('devolve o .bin do pacote do daemon e o da raiz, nessa ordem, em src e em dist', async () => {
    const urls = await monorepo('completo', { root: true, daemon: true });
    const daemonBin = join(base, 'completo', 'packages', 'daemon', 'node_modules', '.bin');
    const rootBin = join(base, 'completo', 'node_modules', '.bin');

    expect(agentBinDirs(urls.src)).toEqual([daemonBin, rootBin]);
    expect(agentBinDirs(urls.dist)).toEqual([daemonBin, rootBin]);
  });

  it('ignora as pastas que não existem', async () => {
    const onlyRoot = await monorepo('so-raiz', { root: true, daemon: false });
    expect(agentBinDirs(onlyRoot.src)).toEqual([join(base, 'so-raiz', 'node_modules', '.bin')]);

    const none = await monorepo('nenhuma', { root: false, daemon: false });
    expect(agentBinDirs(none.src)).toEqual([]);
  });
});

describe('phoneSendBinDir', () => {
  it('aponta para packages/daemon/bin (mesma pasta em src/ e em dist/) e lá existem os dois launchers', async () => {
    const urls = await monorepo('bin', { root: false, daemon: false });
    const expected = join(base, 'bin', 'packages', 'daemon', 'bin');

    expect(phoneSendBinDir(urls.src)).toBe(expected);
    expect(phoneSendBinDir(urls.dist)).toBe(expected);

    const real = phoneSendBinDir();
    expect(existsSync(join(real, 'phone-send.cmd'))).toBe(true);
    expect(existsSync(join(real, 'phone-send'))).toBe(true);
  });
});

describe('withPathPrepended (win32)', () => {
  it('prepende as pastas ao PATH com ";" e mantém a chave que já existe (Path)', () => {
    const env = withPathPrepended({ Path: 'C:\\Windows;C:\\Node', Other: '1' }, ['D:\\a', 'D:\\b'], 'win32');

    expect(env).toEqual({ Path: 'D:\\a;D:\\b;C:\\Windows;C:\\Node', Other: '1' });
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
  });

  it('cria PATH quando a variável não existe', () => {
    expect(withPathPrepended({}, ['D:\\a'], 'win32')).toEqual({ PATH: 'D:\\a' });
  });

  it('com PATH e Path no mesmo objeto, fica só uma chave: a última (a que veio do config do agente)', () => {
    const env = withPathPrepended({ Path: 'C:\\sistema', PATH: 'C:\\do-agente' }, ['D:\\a'], 'win32');

    expect(env).toEqual({ PATH: 'D:\\a;C:\\do-agente' });
  });
});

describe('withPathPrepended (posix)', () => {
  it('prepende com ":" e não mexe na chave Path (diferente de PATH)', () => {
    const env = withPathPrepended({ PATH: '/usr/bin', Path: 'x' }, ['/a', '/b'], 'linux');

    expect(env).toEqual({ PATH: '/a:/b:/usr/bin', Path: 'x' });
  });

  it('sem pastas, devolve o mesmo env', () => {
    const env = { PATH: '/usr/bin' };
    expect(withPathPrepended(env, [], 'linux')).toBe(env);
  });
});
