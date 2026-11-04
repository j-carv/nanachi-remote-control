import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSupervisorPlan } from '../src/supervisor-plan.js';

const ROOT = join('C:', 'Nanachi-Remote');
const HOME = join('C:', 'Users', 'joao', '.nanachi-remote');

const plan = buildSupervisorPlan({
  root: ROOT,
  home: HOME,
  nodeExe: 'node.exe',
  tscJs: join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  viteJs: join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  baseEnv: { PATH: 'p', NANACHI_HOME: 'lixo' },
});

describe('buildSupervisorPlan', () => {
  it('builds em watch: shared e daemon com noEmitOnError, pwa com vite build --watch', () => {
    const [shared, daemonBuild, pwa] = plan.watchers;

    expect(shared?.name).toBe('shared-tsc');
    expect(shared?.command).toBe('node.exe');
    expect(shared?.args).toEqual([
      join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(ROOT, 'packages', 'shared', 'tsconfig.build.json'),
      '--watch',
      '--preserveWatchOutput',
      '--noEmitOnError',
    ]);
    expect(shared?.cwd).toBe(ROOT);

    expect(daemonBuild?.name).toBe('daemon-tsc');
    expect(daemonBuild?.args).toContain('--noEmitOnError');
    expect(daemonBuild?.args).toContain(join(ROOT, 'packages', 'daemon', 'tsconfig.build.json'));

    expect(pwa?.name).toBe('pwa-vite');
    expect(pwa?.args).toEqual([join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--watch']);
    expect(pwa?.cwd).toBe(join(ROOT, 'packages', 'pwa'));
  });

  it('o daemon roda dist/main.js com --reload-on-build, cwd no pacote, e NANACHI_HOME do home (sobrescreve o do ambiente)', () => {
    expect(plan.daemon.name).toBe('daemon');
    expect(plan.daemon.command).toBe('node.exe');
    expect(plan.daemon.args).toEqual(['dist/main.js', '--reload-on-build']);
    expect(plan.daemon.cwd).toBe(join(ROOT, 'packages', 'daemon'));
    expect(plan.daemon.env).toEqual({ PATH: 'p', NANACHI_HOME: HOME });
  });

  it('os watchers herdam o ambiente sem mudar NANACHI_HOME', () => {
    expect(plan.watchers[0]?.env).toEqual({ PATH: 'p', NANACHI_HOME: 'lixo' });
  });
});
