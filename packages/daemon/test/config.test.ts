import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '@nanachi/shared';
import {
  loadConfig,
  resolveNanachiHome,
  startupWarnings,
  type LoadedConfig,
} from '../src/config.js';
import { removeTempDir } from './temp.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nanachi-cfg-'));
});

afterEach(async () => {
  await removeTempDir(home);
});

describe('resolveNanachiHome', () => {
  it('usa NANACHI_HOME quando definido', () => {
    expect(resolveNanachiHome({ NANACHI_HOME: '/tmp/nanachi' })).toBe('/tmp/nanachi');
  });

  it('usa ~/.nanachi-remote por padrão', () => {
    expect(resolveNanachiHome({})).toBe(join(homedir(), '.nanachi-remote'));
  });
});

describe('loadConfig', () => {
  it('cria config.json com os defaults e machineName = hostname quando não existe', async () => {
    const target = join(home, 'novo');
    const config = loadConfig(target);

    expect(config).toEqual({
      port: 7777,
      host: '127.0.0.1',
      machineName: hostname(),
      allowedRoots: [],
      allowedTailscaleLogins: [],
      corsOrigins: [],
      tailscaleAutoPair: false,
      shellSessions: true,
      phoneSendHint: true,
      reloadQuietMs: 60000,
      agents: {
        omp: { label: 'Oh My Pi', command: 'omp', args: ['acp'], env: {}, kind: 'acp' },
        claude: { label: 'Claude Code', command: 'claude-agent-acp', args: [], env: {}, kind: 'acp' },
        codex: { label: 'Codex', command: 'codex-acp', args: [], env: {}, kind: 'acp' },
        agy: { label: 'Antigravity', command: 'agy', args: [], env: {}, kind: 'pty' },
      },
    });
    const written: unknown = JSON.parse(await readFile(join(target, 'config.json'), 'utf8'));
    expect(written).toEqual(config);
  });

  it('soma os agentes default ausentes no arquivo, sem reescrever o arquivo', async () => {
    const original = JSON.stringify({ agents: { x: { label: 'Outro', command: 'outro' } } });
    await writeFile(join(home, 'config.json'), original);

    const config = loadConfig(home);

    expect(config.agents).toEqual({
      omp: { label: 'Oh My Pi', command: 'omp', args: ['acp'], env: {}, kind: 'acp' },
      claude: { label: 'Claude Code', command: 'claude-agent-acp', args: [], env: {}, kind: 'acp' },
      codex: { label: 'Codex', command: 'codex-acp', args: [], env: {}, kind: 'acp' },
      agy: { label: 'Antigravity', command: 'agy', args: [], env: {}, kind: 'pty' },
      x: { label: 'Outro', command: 'outro', args: [], env: {}, kind: 'acp' },
    });
    expect(await readFile(join(home, 'config.json'), 'utf8')).toBe(original);
  });

  it('o arquivo do usuário vence no mesmo id de agente default', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ agents: { omp: { label: 'Meu OMP', command: 'meu-omp' } } }));

    const config = loadConfig(home);

    expect(config.agents.omp).toEqual({ label: 'Meu OMP', command: 'meu-omp', args: [], env: {}, kind: 'acp' });
    expect(config.agents.claude).toEqual({
      label: 'Claude Code',
      command: 'claude-agent-acp',
      args: [],
      env: {},
      kind: 'acp',
    });
  });

  it('preenche machineName com o hostname quando o arquivo não tem', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ port: 8080 }));
    const config = loadConfig(home);
    expect(config.port).toBe(8080);
    expect(config.machineName).toBe(hostname());
  });

  it('mantém machineName explícito', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ machineName: 'PC-SALA' }));
    expect(loadConfig(home).machineName).toBe('PC-SALA');
  });

  it('aceita config.json com BOM UTF-8 (PowerShell 5.1 grava BOM)', async () => {
    await writeFile(join(home, 'config.json'), `﻿${JSON.stringify({ port: 8081, machineName: 'PC-BOM' })}`);

    const config = loadConfig(home);

    expect(config.port).toBe(8081);
    expect(config.machineName).toBe('PC-BOM');
  });

  it('rejeita config inválida com erro que cita config.json', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ port: 0 }));
    expect(() => loadConfig(home)).toThrow(/config\.json/);
  });

  it('rejeita JSON malformado com erro que cita config.json', async () => {
    await writeFile(join(home, 'config.json'), '{ nope');
    expect(() => loadConfig(home)).toThrow(/config\.json/);
  });
});

describe('startupWarnings', () => {
  const base: LoadedConfig = { ...ConfigSchema.parse({}), machineName: 'PC-TESTE' };

  it('avisa quando allowedTailscaleLogins está vazio, dizendo o que definir', () => {
    const warnings = startupWarnings({ ...base, allowedTailscaleLogins: [] });
    expect(warnings).toEqual([
      expect.stringContaining('defina allowedTailscaleLogins no config.json com seu login do Tailscale'),
    ]);
  });

  it('sem avisos quando há login do Tailscale configurado', () => {
    expect(startupWarnings({ ...base, allowedTailscaleLogins: ['jose@exemplo.com'] })).toEqual([]);
  });
});
