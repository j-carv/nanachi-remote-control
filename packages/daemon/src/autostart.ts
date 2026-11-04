import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, type KillResult } from './process-tree.js';
import { defaultLockDeps, isLockLive, readLock, type LockDeps, type LockRecord } from './supervisor-lock.js';

/*
 * Início automático no Windows, sem admin. `install` grava um .vbs mínimo na pasta Inicializar do usuário
 * (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`): ao fazer logon ele roda
 * `wscript.exe "<NANACHI_HOME>\start-hidden.vbs"`. Esse .vbs sobe `node dist/supervisor.js` sem janela, com cwd na raiz
 * do projeto e NANACHI_HOME. Pasta Inicializar roda na sessão interativa do usuário (o `phone-send --screenshot` precisa
 * dela), e não exige admin, ao contrário de tarefa do Agendador com gatilho de logon. O supervisor grava o log em
 * `<home>\supervisor.log`; `supervisor-start.log` guarda só a saída bruta do início. Caminhos com `path.win32`.
 */

export const START_SCRIPT_NAME = 'start-hidden.vbs';
export const LAUNCHER_FILE_NAME = 'Nanachi Remote.vbs';
export const START_LOG_FILE_NAME = 'supervisor-start.log';
export const SUPERVISOR_LOG_FILE_NAME = 'supervisor.log';
export const SUPERVISOR_LOCK_FILE_NAME = 'supervisor.lock';
/** Nome da tarefa do Agendador usada por versões anteriores (só citado na mensagem de instalação). */
const OLD_TASK_NAME = 'Nanachi Remote';
/** Arquivo do build que o supervisor executa (gerado por `npm run build -w @nanachi/daemon`). */
export const SUPERVISOR_SCRIPT = win32.join('dist', 'supervisor.js');

export interface AutostartEnv {
  /** `<NANACHI_HOME>`: onde ficam o start-hidden.vbs, os logs e o lock do supervisor. */
  home: string;
  /** Raiz do projeto: cwd do supervisor. */
  rootDir: string;
  /** Pasta do pacote do daemon (contém `dist/supervisor.js`). */
  daemonDir: string;
  /** Executável do node que roda o supervisor. */
  nodeExe: string;
  /** Pasta Inicializar do usuário: onde fica o atalho de logon. */
  startupDir: string;
  /** Relógio e teste de processo para ler o lock do supervisor. */
  lock: LockDeps;
  /** Mata a árvore de um pid (usado por `stopSupervisor`). */
  killTree(pid: number): KillResult;
  /** Abre o script com `wscript.exe`, sem janela e sem herdar stdio. Resolve quando o processo nasce. */
  launch(scriptPath: string): Promise<void>;
}

export interface AutostartResult {
  ok: boolean;
  message: string;
}

/** Pasta Inicializar do usuário a partir de `%APPDATA%`. */
export function startupDir(appData: string): string {
  return win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** Caminho do atalho dentro da pasta Inicializar. */
export function launcherPath(startupFolder: string): string {
  return win32.join(startupFolder, LAUNCHER_FILE_NAME);
}

/** Monta o ambiente real: caminhos a partir deste arquivo (mesma profundidade em src/ e dist/). */
export function defaultAutostartEnv(home: string, appData: string | undefined): AutostartEnv {
  if (appData === undefined || appData === '') {
    throw new Error('APPDATA não definido: não dá para achar a pasta Inicializar');
  }
  return {
    home,
    rootDir: fileURLToPath(new URL('../../../', import.meta.url)),
    daemonDir: fileURLToPath(new URL('../', import.meta.url)),
    nodeExe: process.execPath,
    startupDir: startupDir(appData),
    lock: defaultLockDeps(),
    killTree: killProcessTree,
    launch: launchHidden,
  };
}

/** `wscript.exe` de verdade, sem janela (`//B` sem popups, `//nologo`), destacado e sem stdio. Não espera o fim. */
export function launchHidden(scriptPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wscript.exe', ['//B', '//nologo', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Literal de string do VBScript: aspas dobradas e tudo entre aspas. */
export function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Código do start-hidden.vbs. A linha do `Run` é `cmd /c "<node>" "<supervisor>" >> "<log>" 2>&1` (o cmd precisa do `>>`),
 * e o `Run` fica com janela 0 e sem esperar. CRLF, sem nada que o wscript não entenda.
 */
export function buildStartScript(paths: { nodeExe: string; supervisorMain: string; rootDir: string; home: string }): string {
  const logFile = win32.join(paths.home, START_LOG_FILE_NAME);
  const commandLine = `"${paths.nodeExe}" "${paths.supervisorMain}" >> "${logFile}" 2>&1`;
  return [
    'Dim shell, env',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(paths.rootDir)}`,
    'Set env = shell.Environment("PROCESS")',
    `env("NANACHI_HOME") = ${vbsString(paths.home)}`,
    `shell.Run ${vbsString(`cmd /c "${commandLine}"`)}, 0, False`,
    '',
  ].join('\r\n');
}

/**
 * Código do atalho da pasta Inicializar: uma linha que roda `wscript.exe "<script>"` sem janela e sem esperar.
 * O caminho com espaço e acento fica entre aspas (VBScript dobra as aspas internas).
 */
export function startupLauncherSource(scriptPath: string): string {
  return `CreateObject("WScript.Shell").Run ${vbsString(`wscript.exe "${scriptPath}"`)}, 0, False\r\n`;
}

/** UTF-16 LE com BOM (FF FE): é o que o wscript lê sem estragar acento no caminho. */
export function encodeScript(source: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]);
}

function ok(message: string): AutostartResult {
  return { ok: true, message };
}

function fail(message: string): AutostartResult {
  return { ok: false, message };
}

type StartScriptResult = { ok: true; path: string } | { ok: false; message: string };

/** Grava o start-hidden.vbs. Sem `dist/supervisor.js` não grava nada (o build é pré-requisito). */
async function writeStartScript(env: AutostartEnv): Promise<StartScriptResult> {
  const supervisorMain = win32.join(env.daemonDir, SUPERVISOR_SCRIPT);
  if (!existsSync(supervisorMain)) {
    return { ok: false, message: `${supervisorMain} não existe: rode npm run build -w @nanachi/daemon primeiro` };
  }

  const path = win32.join(env.home, START_SCRIPT_NAME);
  await mkdir(env.home, { recursive: true });
  await writeFile(path, encodeScript(buildStartScript({ nodeExe: env.nodeExe, supervisorMain, rootDir: env.rootDir, home: env.home })));
  return { ok: true, path };
}

/** Lock do supervisor, se o pid ainda é um node vivo. */
function liveSupervisor(env: AutostartEnv): LockRecord | undefined {
  const record = readLock(win32.join(env.home, SUPERVISOR_LOCK_FILE_NAME));
  return record !== undefined && isLockLive(record, env.lock) ? record : undefined;
}

/** Grava o start-hidden.vbs e o atalho na pasta Inicializar. Idempotente: sobrescreve os dois. Não sobe o supervisor. */
export async function installAutostart(env: AutostartEnv): Promise<AutostartResult> {
  const script = await writeStartScript(env);
  if (!script.ok) return fail(script.message);

  const launcher = launcherPath(env.startupDir);
  await mkdir(env.startupDir, { recursive: true });
  await writeFile(launcher, encodeScript(startupLauncherSource(script.path)));

  return ok(
    [
      `Início automático instalado na pasta Inicializar: ${launcher}`,
      `Sobe o supervisor ao fazer logon, sem janela e sem admin. Script: ${script.path}. Log: ${win32.join(env.home, SUPERVISOR_LOG_FILE_NAME)}`,
      `Se a tarefa "${OLD_TASK_NAME}" do Agendador (versão anterior) ainda existir, ela pode ser removida no Agendador de Tarefas. Não é mais usada; enquanto existir, também tenta subir o supervisor, mas o lock evita duplicata.`,
    ].join('\n'),
  );
}

/** Remove o atalho da pasta Inicializar. Se ele já não existia, não é erro. Não mexe no start-hidden.vbs nem no supervisor. */
export function uninstallAutostart(env: AutostartEnv): AutostartResult {
  const launcher = launcherPath(env.startupDir);
  if (!existsSync(launcher)) return ok(`Início automático não estava instalado (${launcher} não existe).`);

  rmSync(launcher, { force: true });
  return ok(`Início automático removido: ${launcher}`);
}

/** Sobe o supervisor agora, sem janela. Se ele já está vivo pelo lock, não abre outro. */
export async function startAutostart(env: AutostartEnv): Promise<AutostartResult> {
  const live = liveSupervisor(env);
  if (live !== undefined) return ok(`supervisor já está rodando (pid ${live.pid})`);

  const script = await writeStartScript(env);
  if (!script.ok) return fail(script.message);

  try {
    await env.launch(script.path);
  } catch (error) {
    return fail(`não foi possível abrir o wscript: ${(error as Error).message}`);
  }
  return ok(`supervisor disparado sem janela. Confira o log em ${win32.join(env.home, SUPERVISOR_LOG_FILE_NAME)}`);
}

/**
 * Encerra o supervisor pelo pid do lock, matando a árvore (os filhos morrem junto). Lock de pid que não é mais um
 * node.exe (ou de outro boot) só é limpo: não mata nada que não é nosso.
 */
export function stopSupervisor(env: AutostartEnv): AutostartResult {
  const lockFile = win32.join(env.home, SUPERVISOR_LOCK_FILE_NAME);
  const record = readLock(lockFile);
  if (record === undefined) return ok('supervisor não está rodando (sem supervisor.lock).');

  if (!isLockLive(record, env.lock)) {
    rmSync(lockFile, { force: true });
    return ok(`supervisor não estava rodando (lock antigo, pid ${record.pid}, removido).`);
  }

  const killed = env.killTree(record.pid);
  if (!killed.ok) return fail(`não foi possível encerrar o supervisor (pid ${record.pid}): ${killed.message}`);
  rmSync(lockFile, { force: true });
  return ok(`supervisor (pid ${record.pid}) encerrado, junto com os processos filhos.`);
}

/** Só leitura: se o atalho existe na pasta Inicializar e se o supervisor está vivo. */
export function autostartStatus(env: AutostartEnv): AutostartResult {
  const launcher = launcherPath(env.startupDir);
  const installed = existsSync(launcher) ? 'instalado' : 'não instalado';
  const live = liveSupervisor(env);
  const supervisor = live === undefined ? 'parado' : `rodando (pid ${live.pid})`;
  return ok([`Início automático (pasta Inicializar): ${installed} (${launcher})`, `Supervisor: ${supervisor}`].join('\n'));
}
