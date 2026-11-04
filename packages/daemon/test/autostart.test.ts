import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autostartStatus,
  buildStartScript,
  defaultAutostartEnv,
  encodeScript,
  installAutostart,
  LAUNCHER_FILE_NAME,
  launchHidden,
  launcherPath,
  startAutostart,
  startupDir,
  startupLauncherSource,
  stopSupervisor,
  uninstallAutostart,
  vbsString,
  type AutostartEnv,
} from '../src/autostart.js';
import type { KillResult } from '../src/process-tree.js';
import { bootTimeMs, type LockDeps } from '../src/supervisor-lock.js';
import { removeTempDir } from './temp.js';

const execFileAsync = promisify(execFile);

let base: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-autostart-')));
});

afterEach(async () => {
  await removeTempDir(base);
});

/** killTree falso: anota o pid e diz que matou. */
function recordKill(killed: number[], pid: number): KillResult {
  killed.push(pid);
  return { ok: true, message: '' };
}

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
/** Relógio do teste: boot há 10 min. `nodePids` são os pids que contam como node.exe. */
function lockDeps(nodePids: number[]): LockDeps {
  return { now: () => NOW, uptimeSeconds: () => 600, isNodeProcess: (pid) => nodePids.includes(pid) };
}

/** Ambiente de teste: raiz, pasta do daemon (com dist/supervisor.js), NANACHI_HOME e pasta Inicializar temporários. */
async function environment(overrides: Partial<AutostartEnv> = {}): Promise<AutostartEnv> {
  const rootDir = join(base, 'Área de Trabalho', 'Nanachi-Remote');
  const daemonDir = join(rootDir, 'packages', 'daemon');
  await mkdir(join(daemonDir, 'dist'), { recursive: true });
  await writeFile(join(daemonDir, 'dist', 'supervisor.js'), 'console.log(1);');
  return {
    home: join(base, 'Nanachi Home ção'),
    rootDir,
    daemonDir,
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    startupDir: join(base, 'AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    lock: lockDeps([]),
    killTree: (): KillResult => ({ ok: true, message: '' }),
    launch: async () => undefined,
    ...overrides,
  };
}

/** Lançamento falso: anota o script que seria aberto, sem abrir nada. */
function recordLaunch(): { calls: string[]; launch: AutostartEnv['launch'] } {
  const calls: string[] = [];
  return {
    calls,
    launch: async (scriptPath) => {
      calls.push(scriptPath);
    },
  };
}

/** Script de teste que grava cwd e NANACHI_HOME no log do início, como o supervisor faria. */
const PROBE_SOURCE = "console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.NANACHI_HOME }));\n";

async function waitForProbe(home: string): Promise<{ cwd: string; home: string }> {
  const log = join(home, 'supervisor-start.log');
  const deadline = Date.now() + 20_000;
  while (!existsSync(log) || !(await readFile(log, 'utf8')).includes('"home"')) {
    if (Date.now() > deadline) throw new Error('o processo não escreveu no supervisor-start.log');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return JSON.parse((await readFile(log, 'utf8')).trim().split('\n').at(-1) ?? '{}') as { cwd: string; home: string };
}

async function writeLock(home: string, record: { pid: number; bootedAt: number }): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'supervisor.lock'), JSON.stringify(record));
}

describe('pasta Inicializar', () => {
  it('monta a pasta a partir de APPDATA, com espaço e acento', () => {
    expect(startupDir('C:\\Users\\João Pedro\\AppData\\Roaming')).toBe(
      'C:\\Users\\João Pedro\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    );
  });

  it('o atalho se chama "Nanachi Remote.vbs" dentro da pasta', () => {
    expect(LAUNCHER_FILE_NAME).toBe('Nanachi Remote.vbs');
    expect(launcherPath('C:\\Startup')).toBe('C:\\Startup\\Nanachi Remote.vbs');
  });

  it('defaultAutostartEnv usa o APPDATA recebido e recusa APPDATA ausente', () => {
    const env = defaultAutostartEnv('C:\\home', 'C:\\Users\\João\\AppData\\Roaming');
    expect(env.startupDir).toBe(startupDir('C:\\Users\\João\\AppData\\Roaming'));
    expect(() => defaultAutostartEnv('C:\\home', undefined)).toThrow(/APPDATA/);
    expect(() => defaultAutostartEnv('C:\\home', '')).toThrow(/APPDATA/);
  });
});

describe('script do atalho (startupLauncherSource)', () => {
  it('uma linha que chama wscript.exe com o start-hidden.vbs, sem janela e sem esperar', () => {
    const source = startupLauncherSource('C:\\Users\\João Pedro\\Nanachi Home\\start-hidden.vbs');

    expect(source).toBe(
      'CreateObject("WScript.Shell").Run "wscript.exe ""C:\\Users\\João Pedro\\Nanachi Home\\start-hidden.vbs""", 0, False\r\n',
    );
  });

  it('codificação: UTF-16 LE com BOM, e o texto volta igual com acentos', () => {
    const source = startupLauncherSource('C:\\Users\\João\\Nanachi Home ção\\start-hidden.vbs');
    const bytes = encodeScript(source);

    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(bytes.subarray(2).toString('utf16le')).toBe(source);
  });
});

describe('script start-hidden.vbs', () => {
  const rootDir = 'C:\\Users\\João Pedro\\Área de Trabalho\\Nanachi-Remote';
  const supervisorMain = `${rootDir}\\packages\\daemon\\dist\\supervisor.js`;
  const home = 'C:\\Users\\João Pedro\\.nanachi-remote';

  it('roda o supervisor sem janela, com cwd na raiz do projeto, NANACHI_HOME e log de início anexado', () => {
    const script = buildStartScript({
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      supervisorMain,
      rootDir,
      home,
    });

    expect(script.split('\r\n')).toEqual([
      'Dim shell, env',
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = "${rootDir}"`,
      'Set env = shell.Environment("PROCESS")',
      `env("NANACHI_HOME") = "${home}"`,
      'shell.Run "cmd /c """"C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\João Pedro\\Área de Trabalho\\Nanachi-Remote\\packages\\daemon\\dist\\supervisor.js"" >> ""C:\\Users\\João Pedro\\.nanachi-remote\\supervisor-start.log"" 2>&1""", 0, False',
      '',
    ]);
  });

  it('vbsString dobra as aspas e envolve em aspas', () => {
    expect(vbsString('a "b" c')).toBe('"a ""b"" c"');
  });

  it('codificação: UTF-16 LE com BOM, e o texto volta igual com acentos', () => {
    const script = buildStartScript({ nodeExe: 'n.exe', supervisorMain: 'm.js', rootDir, home });
    const bytes = encodeScript(script);

    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(bytes.subarray(2).toString('utf16le')).toBe(script);
    expect(bytes.subarray(2).toString('utf16le')).toContain('João Pedro');
  });
});

describe('scripts executados de verdade pelo wscript', () => {
  it('start-hidden.vbs roda o processo com caminho com espaço e acento, cwd e NANACHI_HOME corretos', async () => {
    const rootDir = join(base, 'Área de Trabalho', 'Nanachi-Remote');
    const home = join(base, 'Nanachi Home ção');
    await mkdir(rootDir, { recursive: true });
    await mkdir(home, { recursive: true });
    const probe = join(rootDir, 'probe ção.mjs');
    await writeFile(probe, PROBE_SOURCE);
    const script = join(home, 'start-hidden.vbs');
    await writeFile(
      script,
      encodeScript(buildStartScript({ nodeExe: process.execPath, supervisorMain: probe, rootDir, home })),
    );

    await execFileAsync('wscript.exe', ['//B', '//nologo', script], { windowsHide: true });

    const output = await waitForProbe(home);
    expect(realpathSync.native(output.cwd)).toBe(realpathSync.native(rootDir));
    expect(output.home).toBe(home);
  }, 30_000);

  it('o atalho da pasta Inicializar, executado de verdade, dispara o start-hidden.vbs', async () => {
    const rootDir = join(base, 'Área de Trabalho', 'Nanachi-Remote');
    const home = join(base, 'Nanachi Home ção');
    const startup = join(base, 'Início ção');
    await mkdir(rootDir, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(startup, { recursive: true });
    const probe = join(rootDir, 'probe ção.mjs');
    await writeFile(probe, PROBE_SOURCE);
    const script = join(home, 'start-hidden.vbs');
    await writeFile(
      script,
      encodeScript(buildStartScript({ nodeExe: process.execPath, supervisorMain: probe, rootDir, home })),
    );
    const launcher = join(startup, LAUNCHER_FILE_NAME);
    await writeFile(launcher, encodeScript(startupLauncherSource(script)));

    await execFileAsync('wscript.exe', ['//B', '//nologo', launcher], { windowsHide: true });

    const output = await waitForProbe(home);
    expect(realpathSync.native(output.cwd)).toBe(realpathSync.native(rootDir));
    expect(output.home).toBe(home);
  }, 30_000);
});

describe('autostart install (pasta Inicializar, sem admin)', () => {
  it('grava start-hidden.vbs e o atalho em UTF-16 com BOM; o atalho só chama o start-hidden.vbs', async () => {
    const env = await environment();

    const result = await installAutostart(env);

    expect(result.ok).toBe(true);
    const script = join(env.home, 'start-hidden.vbs');
    const scriptBytes = await readFile(script);
    expect(scriptBytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(scriptBytes.subarray(2).toString('utf16le')).toContain(`env("NANACHI_HOME") = "${env.home}"`);
    expect(scriptBytes.subarray(2).toString('utf16le')).toContain('supervisor.js');

    const launcher = join(env.startupDir, LAUNCHER_FILE_NAME);
    const launcherBytes = await readFile(launcher);
    expect(launcherBytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(launcherBytes.subarray(2).toString('utf16le')).toBe(startupLauncherSource(script));
  });

  it('é idempotente: rodar de novo atualiza o atalho e não duplica arquivos', async () => {
    const env = await environment();
    await mkdir(env.startupDir, { recursive: true });
    await writeFile(join(env.startupDir, LAUNCHER_FILE_NAME), encodeScript('lixo antigo'));

    expect((await installAutostart(env)).ok).toBe(true);
    const first = await readFile(join(env.startupDir, LAUNCHER_FILE_NAME));
    expect((await installAutostart(env)).ok).toBe(true);
    const second = await readFile(join(env.startupDir, LAUNCHER_FILE_NAME));

    expect(second.equals(first)).toBe(true);
    expect(second.subarray(2).toString('utf16le')).toBe(startupLauncherSource(join(env.home, 'start-hidden.vbs')));
    expect(await readdir(env.startupDir)).toEqual([LAUNCHER_FILE_NAME]);
  });

  it('não lança o supervisor e avisa que a tarefa antiga do Agendador pode ser removida', async () => {
    const launched = recordLaunch();
    const env = await environment({ launch: launched.launch });

    const result = await installAutostart(env);

    expect(launched.calls).toEqual([]);
    expect(result.message).toMatch(/Agendador/);
    expect(result.message).toMatch(/Nanachi Remote/);
    expect(result.message).toMatch(/pode ser removida/);
  });

  it('sem dist/supervisor.js não cria nada', async () => {
    const env = await environment();
    await rm(join(env.daemonDir, 'dist'), { recursive: true, force: true });

    const result = await installAutostart(env);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/npm run build/);
    expect(existsSync(join(env.home, 'start-hidden.vbs'))).toBe(false);
    expect(existsSync(env.startupDir)).toBe(false);
  });
});

describe('autostart uninstall (remove só o atalho da pasta Inicializar)', () => {
  it('remove o atalho e mantém o start-hidden.vbs', async () => {
    const env = await environment();
    await installAutostart(env);

    const result = uninstallAutostart(env);

    expect(result.ok).toBe(true);
    expect(existsSync(join(env.startupDir, LAUNCHER_FILE_NAME))).toBe(false);
    expect(existsSync(join(env.home, 'start-hidden.vbs'))).toBe(true);
  });

  it('sem atalho não é erro', async () => {
    const env = await environment();

    const result = uninstallAutostart(env);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/não estava instalado/);
  });
});

describe('autostart start (sobe o supervisor agora, sem janela)', () => {
  it('sem supervisor: grava o start-hidden.vbs e manda o wscript abri-lo', async () => {
    const launched = recordLaunch();
    const env = await environment({ launch: launched.launch });

    const result = await startAutostart(env);

    expect(result.ok).toBe(true);
    expect(launched.calls).toEqual([join(env.home, 'start-hidden.vbs')]);
    expect(existsSync(join(env.home, 'start-hidden.vbs'))).toBe(true);
  });

  it('não instala o atalho da pasta Inicializar', async () => {
    const env = await environment({ launch: recordLaunch().launch });

    await startAutostart(env);

    expect(existsSync(join(env.startupDir, LAUNCHER_FILE_NAME))).toBe(false);
  });

  it('com supervisor vivo não abre outro', async () => {
    const launched = recordLaunch();
    const env = await environment({ lock: lockDeps([7001]), launch: launched.launch });
    await writeLock(env.home, { pid: 7001, bootedAt: bootTimeMs(lockDeps([7001])) });

    const result = await startAutostart(env);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/já está rodando \(pid 7001\)/);
    expect(launched.calls).toEqual([]);
  });

  it('sem dist/supervisor.js não abre nada', async () => {
    const launched = recordLaunch();
    const env = await environment({ launch: launched.launch });
    await rm(join(env.daemonDir, 'dist'), { recursive: true, force: true });

    const result = await startAutostart(env);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/npm run build/);
    expect(launched.calls).toEqual([]);
  });

  it('falha ao abrir o wscript vira erro com a causa', async () => {
    const env = await environment({
      launch: async () => {
        throw new Error('ENOENT wscript.exe');
      },
    });

    const result = await startAutostart(env);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ENOENT wscript.exe');
  });

  it('de verdade: o supervisor (aqui, um probe) sobe pelo wscript sem janela, com cwd e NANACHI_HOME corretos', async () => {
    const env = await environment({ nodeExe: process.execPath, launch: launchHidden });
    await writeFile(join(env.daemonDir, 'dist', 'supervisor.js'), PROBE_SOURCE);

    const result = await startAutostart(env);

    expect(result.ok).toBe(true);
    const output = await waitForProbe(env.home);
    expect(realpathSync.native(output.cwd)).toBe(realpathSync.native(env.rootDir));
    expect(output.home).toBe(env.home);
  }, 30_000);
});

describe('autostart stop (encerra o supervisor pelo lock)', () => {
  it('sem supervisor.lock: diz que não está rodando e não mata nada', async () => {
    const killed: number[] = [];
    const env = await environment({ killTree: (pid) => recordKill(killed, pid) });

    const result = stopSupervisor(env);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/não está rodando/);
    expect(killed).toEqual([]);
  });

  it('lock de supervisor vivo: mata a árvore pelo pid e remove o lock', async () => {
    const killed: number[] = [];
    const env = await environment({
      lock: lockDeps([7001]),
      killTree: (pid) => recordKill(killed, pid),
    });
    await writeLock(env.home, { pid: 7001, bootedAt: bootTimeMs(lockDeps([7001])) });

    const result = stopSupervisor(env);

    expect(result.ok).toBe(true);
    expect(killed).toEqual([7001]);
    expect(existsSync(join(env.home, 'supervisor.lock'))).toBe(false);
  });

  it('lock de pid que não é mais node (reaproveitado): não mata, só limpa o lock', async () => {
    const killed: number[] = [];
    const env = await environment({
      lock: lockDeps([]),
      killTree: (pid) => recordKill(killed, pid),
    });
    await writeLock(env.home, { pid: 7001, bootedAt: bootTimeMs(lockDeps([])) });

    const result = stopSupervisor(env);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/lock antigo/);
    expect(killed).toEqual([]);
    expect(existsSync(join(env.home, 'supervisor.lock'))).toBe(false);
  });

  it('falha ao matar vira erro e mantém o lock', async () => {
    const env = await environment({
      lock: lockDeps([7001]),
      killTree: () => ({ ok: false, message: 'acesso negado' }),
    });
    await writeLock(env.home, { pid: 7001, bootedAt: bootTimeMs(lockDeps([7001])) });

    const result = stopSupervisor(env);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('acesso negado');
    expect(existsSync(join(env.home, 'supervisor.lock'))).toBe(true);
  });
});

describe('autostart status (só leitura)', () => {
  it('sem atalho e sem supervisor: diz não instalado e parado, e não cria nada', async () => {
    const env = await environment();

    const result = autostartStatus(env);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Início automático.*não instalado/);
    expect(result.message).toMatch(/Supervisor: parado/);
    expect(existsSync(env.startupDir)).toBe(false);
  });

  it('com atalho e supervisor vivo: diz instalado e mostra o pid', async () => {
    const env = await environment({ lock: lockDeps([7001]) });
    await installAutostart(env);
    await writeLock(env.home, { pid: 7001, bootedAt: bootTimeMs(lockDeps([7001])) });

    const result = autostartStatus(env);

    expect(result.message).toMatch(/Início automático.*instalado/);
    expect(result.message).not.toMatch(/não instalado/);
    expect(result.message).toMatch(/Supervisor: rodando \(pid 7001\)/);
  });

  it('lock antigo (pid que não é node) conta como parado', async () => {
    const env = await environment({ lock: lockDeps([]) });
    await writeLock(env.home, { pid: 7001, bootedAt: bootTimeMs(lockDeps([])) });

    expect(autostartStatus(env).message).toMatch(/Supervisor: parado/);
  });
});
