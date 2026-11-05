/*
 * Smoke do instalador e do desinstalador do Nanachi Desktop, sobre o resultado de `npm run package -w @nanachi/desktop`.
 *
 * Segurança: nada aqui toca o PC de verdade. O instalador e o desinstalador rodam SEMPRE em modo de teste
 * (`--target <pasta temporária> --no-shortcuts --no-registry --no-launch`), então não criam atalhos, não escrevem no
 * registro nem no "iniciar com o Windows" e não usam %LOCALAPPDATA%\Programs. O script confere, só com leituras, que o
 * Menu Iniciar, a Área de Trabalho, a chave de desinstalação, o item de login e %LOCALAPPDATA%\Programs\Nanachi ficaram
 * exatamente como estavam. O app instalado usa NANACHI_DESKTOP_HOME (pasta de dados própria do Desktop) e userData
 * temporários, porta livre (nem 7777, a do supervisor, nem 7780, a padrão do Desktop) e allowlist vazia; um NANACHI_HOME
 * de isca no ambiente (o daemon avulso) tem que ser ignorado e continuar inexistente. Nunca o daemon do supervisor. NUNCA rode o instalador em modo normal neste PC.
 *
 * Roteiro:
 *   1. o instalador de verdade (Nanachi-Setup-<versão>.exe, portable) com --yes instala na pasta A e sai com código 0;
 *   2. os arquivos instalados batem com o payload; o app instalado sobe o daemon com o node.exe embutido, o painel carrega
 *      a PWA, /api/health responde; sair deixa nada para trás;
 *   3. com o app da pasta A aberto, a janela do instalador (o mesmo app do exe portable, desempacotado) pergunta se pode
 *      fechá-lo, fecha o app e o daemon dele e reinstala por cima (atualização);
 *   4. a janela do instalador, na pasta B: tela inicial (claro e escuro), Opções, pasta recusada, progresso, pronto;
 *   5. com o app da pasta B aberto, a janela de desinstalação pergunta, remove e fecha o app e o daemon dele; a pasta B some
 *      e os dados (NANACHI_HOME, userData) ficam;
 *   6. a pasta A é removida por `--uninstall --yes --delete-data` (sem janela de pergunta); desta vez os dados vão junto;
 *   7. nenhum processo sobra; o sistema de verdade está igual ao começo.
 *
 * Como rodar (da raiz, depois de `npm run package -w @nanachi/desktop`; não usa a porta 7777):
 *   node e2e/run-desktop-install.mjs
 *
 * Screenshots em e2e/screenshots/desktop/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');
const shotsDir = join(here, 'screenshots', 'desktop');
const log = (line) => console.log(`[e2einstall] ${line}`);
// A pasta temporária sai pelo mesmo removedor do app (nunca `rmSync` recursivo: ele segue junções no Node do Electron).
const { removeTree } = await import(pathToFileURL(join(desktopDir, 'dist', 'install', 'safe-remove.js')).href);

const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version;
const buildDir = process.env.NANACHI_DESKTOP_BUILD_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'nanachi-desktop-build');
const setupExe = join(buildDir, 'release', `Nanachi-Setup-${version}.exe`);
const installerAppExe = join(buildDir, 'installer-build', 'win-unpacked', 'Nanachi Setup.exe');
const payloadMeta = join(buildDir, 'installer-payload', 'payload.json');

const root = join(tmpdir(), `nanachi-e2einstall-${randomBytes(4).toString('hex')}`);
const home = join(root, 'home');
const standaloneDecoy = join(root, 'standalone-nanachi-home');
const userData = join(root, 'userdata');
let configText = '';
const targetA = join(root, 'A instalação', 'Nanachi');
const targetB = join(root, 'B instalação', 'Nanachi');
const installerLog = join(root, 'installer.log');
let port = 0;
let origin = '';

/** Cada processo que este script iniciou, para a limpeza no fim. */
const pids = new Set();
const apps = new Set();

// ---------- infraestrutura ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function isAlive(pid) {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
  return out.includes(`"${pid}"`);
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: chosen } = server.address();
      server.close(() => resolvePort(chosen));
    });
  });
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function until(description, check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando: ${description}`);
    await sleep(200);
  }
}

function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result.stdout.trim();
}

/** Processos cujo executável fica dentro de `dir` (pid e nome). */
function processesUnder(dir) {
  const out = powershell(
    "$d = $env:SCAN_DIR; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.Name }",
    { SCAN_DIR: dir.endsWith('\\') ? dir : `${dir}\\` },
  );
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, name] = line.split('|');
    return { pid: Number(pid), name };
  });
}

function exePathOf(pid) {
  return powershell('(Get-CimInstance Win32_Process -Filter "ProcessId=$env:PROBE_PID").ExecutablePath', { PROBE_PID: String(pid) });
}

/** Leituras do que o instalador de verdade tocaria. Em modo de teste nada disso pode mudar. */
function realSystemState() {
  const desktop = powershell("[Environment]::GetFolderPath('Desktop')");
  const query = (args) => spawnSync('reg', ['query', ...args], { encoding: 'utf8' });
  const uninstallKey = query(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi']);
  const runValue = query(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'org.nanachi.desktop']);
  return {
    startMenuShortcut: existsSync(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Nanachi.lnk')),
    desktopShortcut: existsSync(join(desktop, 'Nanachi.lnk')),
    programsFolder: existsSync(join(process.env.LOCALAPPDATA, 'Programs', 'Nanachi')),
    appDataFolder: existsSync(join(process.env.APPDATA, 'Nanachi')),
    uninstallKey: uninstallKey.status === 0,
    loginItem: runValue.status === 0,
  };
}

function walkFiles(dir) {
  let count = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = walkFiles(full);
      count += inner.count;
      bytes += inner.bytes;
    } else {
      count += 1;
      bytes += statSync(full).size;
    }
  }
  return { count, bytes };
}

function setupFolders() {
  for (const dir of [home, userData, shotsDir, dirname(targetA), dirname(targetB)]) mkdirSync(dir, { recursive: true });
  // Desktop only creates config.json (port 7780) when it is missing. This script picks a free port and writes the file
  // first, so port 7780 (which may be taken) never comes into play.
  // Allowlist vazia: o painel local usa o daemon sem a "chave local".
  const config = {
    port,
    host: '127.0.0.1',
    machineName: 'e2e-install',
    allowedRoots: [home],
    allowedTailscaleLogins: [],
    tailscaleAutoPair: false,
    corsOrigins: [],
    agents: {},
  };
  configText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(join(home, 'config.json'), configText);
}

/** The installed app ran: Desktop's folder still holds the config with the port this script chose, and the decoy never appeared. */
function assertDesktopHome() {
  const text = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal(JSON.parse(text).port, port, "Desktop's config.json holds the port this script chose");
  assert.equal(text, configText, 'Desktop does not rewrite an existing config.json');
  assert.ok(existsSync(join(home, 'data.db')), "the daemon keeps its data in Desktop's folder (NANACHI_DESKTOP_HOME)");
  assert.equal(existsSync(standaloneDecoy), false, "Desktop never uses the environment's NANACHI_HOME (the standalone daemon's folder)");
  log("   Desktop's folder holds config.json (the chosen port) and data.db; the NANACHI_HOME decoy was never touched");
}

const testFlags = (target) => ['--target', target, '--no-shortcuts', '--no-registry', '--no-launch'];

/**
 * Inicia um exe empacotado e se liga a ele por CDP. Os apps empacotados têm os fuses do Electron virados (RunAsNode,
 * NODE_OPTIONS e --inspect desligados) e o `electron.launch` do Playwright precisa do inspetor do Node (--inspect), então não
 * consegue abri-los. A porta de depuração do Chromium (--remote-debugging-port) não é um fuse: as janelas são dirigidas
 * como antes, só o processo principal fica fora do alcance. `close()` pede ao app que saia (Browser.close), como o
 * app.close() do Playwright, e derruba a árvore de processos se ele não sair.
 */
async function launch(executablePath, args, env = {}) {
  const child = spawn(executablePath, ['--remote-debugging-port=0', ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (child.pid !== undefined) pids.add(child.pid);
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  let stderrText = '';
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error('o app não abriu a porta de depuração em 30 s\n' + stderrText)), 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('o app saiu com código ' + code + ' antes de abrir a porta de depuração\n' + stderrText));
    });
    // O fluxo continua sendo lido depois da linha: um stderr cheio travaria o app.
    child.stderr.on('data', (chunk) => {
      stderrText = (stderrText + chunk.toString()).slice(-8_000);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderrText);
      if (match) {
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const instance = {
    process: () => child,
    async firstWindow() {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const [page] = browser.contexts().flatMap((context) => context.pages());
        if (page !== undefined) return page;
        if (Date.now() > deadline) throw new Error('o app não abriu nenhuma janela em 60 s');
        await sleep(200);
      }
    },
    async close() {
      if (child.exitCode !== null) return;
      // Sem `await`: quando o app sai, a conexão cai e esta chamada pode nunca resolver. O que vale é o processo sair.
      void browser
        .newBrowserCDPSession()
        .then((session) => session.send('Browser.close'))
        .catch(() => undefined);
      await Promise.race([exited, sleep(15_000)]);
      if (child.exitCode === null && child.pid !== undefined) killTree(child.pid);
    },
  };
  apps.add(instance);
  return instance;
}

// NANACHI_DESKTOP_HOME is Desktop's data folder. NANACHI_HOME stands in for the standalone daemon's folder: Desktop must
// ignore it, and the uninstaller must refuse it (it never exists here, and the run checks it still does not).
const desktopEnv = () => ({
  NANACHI_DESKTOP_HOME: home,
  NANACHI_HOME: standaloneDecoy,
  NANACHI_DESKTOP_USER_DATA: userData,
  NANACHI_INSTALLER_LOG: installerLog,
});

async function shot(page, name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`), omitBackground: true });
  log(`screenshot ${name}`);
}

// ---------- o roteiro ----------

/**
 * Os fuses do exe instalado, lidos do próprio binário (o fio de fuses do @electron/fuses: um marcador, a versão, o
 * tamanho e um byte por fuse, '0' desligado, '1' ligado): o que foi empacotado tem que ser o que vale na instalação.
 */
function assertFuses(exe) {
  const bytes = readFileSync(exe);
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = bytes.indexOf(sentinel);
  assert.notEqual(at, -1, 'o exe instalado não tem o fio de fuses do Electron');
  const wire = at + sentinel.length;
  assert.equal(bytes[wire], 1, 'versão do fio de fuses');
  const order = ['runAsNode', 'enableCookieEncryption', 'enableNodeOptionsEnvironmentVariable', 'enableNodeCliInspectArguments', 'enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar'];
  const expected = {
    runAsNode: '0',
    enableNodeOptionsEnvironmentVariable: '0',
    enableNodeCliInspectArguments: '0',
    enableEmbeddedAsarIntegrityValidation: '1',
    onlyLoadAppFromAsar: '1',
  };
  for (const [name, want] of Object.entries(expected)) {
    assert.equal(String.fromCharCode(bytes[wire + 2 + order.indexOf(name)]), want, `fuse ${name} no exe instalado`);
  }
  assert.equal(existsSync(join(dirname(exe), 'resources', 'default_app.asar')), false, 'default_app.asar não vai na instalação');
}

async function installWithSetupExe() {
  log(`1. ${setupExe} --yes em ${targetA}`);
  const started = Date.now();
  const child = spawn(setupExe, [...testFlags(targetA), '--yes'], { env: { ...process.env, ...desktopEnv() }, stdio: 'ignore', windowsHide: true });
  pids.add(child.pid);
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const installerLogText = existsSync(installerLog) ? readFileSync(installerLog, 'utf8') : '(sem log)';
  assert.equal(code, 0, `o instalador saiu com código ${code}\n${installerLogText}`);
  log(`   instalado em ${seconds}s (código de saída 0)`);

  const meta = JSON.parse(readFileSync(payloadMeta, 'utf8'));
  for (const file of [
    'Nanachi.exe',
    join('resources', 'app.asar'),
    join('resources', 'runtime', 'node.exe'),
    join('resources', 'runtime', 'packages', 'daemon', 'dist', 'main.js'),
    join('resources', 'runtime', 'packages', 'daemon', 'dist', 'cli.js'),
    join('resources', 'runtime', 'node_modules', 'better-sqlite3', 'package.json'),
    join('resources', 'runtime', 'packages', 'pwa', 'dist', 'index.html'),
    join('resources', 'bin', 'nanachi-tsnet.exe'),
  ]) {
    assert.ok(existsSync(join(targetA, file)), `faltou ${file} na instalação`);
  }
  const marker = JSON.parse(readFileSync(join(targetA, '.nanachi-install.json'), 'utf8'));
  assert.equal(marker.complete, true);
  assert.equal(marker.version, meta.version);
  assertFuses(join(targetA, 'Nanachi.exe'));
  log('   fuses do exe instalado: RunAsNode, NODE_OPTIONS e --inspect desligados; só carrega app.asar');
  const { count, bytes } = walkFiles(targetA);
  assert.equal(count - 1, meta.files, 'a contagem de arquivos instalados (sem o marcador) tem que bater com o payload');
  assert.equal(bytes - statSync(join(targetA, '.nanachi-install.json')).size, meta.uncompressedBytes, 'os bytes instalados têm que bater com o payload');
  log(`   ${count - 1} arquivos, ${(bytes / 1048576).toFixed(0)} MiB: iguais ao payload`);
}

async function panelPage(instance) {
  const page = await instance.firstWindow();
  await until('a PWA carregar no painel', () => page.url().startsWith(`${origin}/`), 90_000);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function health() {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
  return { status: response.status, body: await response.json() };
}

async function runInstalledApp(target) {
  const exe = join(target, 'Nanachi.exe');
  const instance = await launch(exe, [], desktopEnv());
  const electronPid = instance.process().pid;
  const page = await panelPage(instance);
  log(`   painel carregado: ${page.url()}`);
  const status = await page.evaluate(async () => await window.nanachiDesktop.status());
  assert.equal(status.mode, 'spawned', 'o app instalado deveria ter subido o próprio daemon');
  assert.ok(Number.isInteger(status.pid));
  pids.add(status.pid);
  return { instance, page, electronPid, daemonPid: status.pid };
}

async function verifyInstalledApp() {
  log(`2. app instalado em ${targetA} (porta ${port})`);
  const { instance, page, electronPid, daemonPid } = await runInstalledApp(targetA);

  const { status, body } = await health();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.machineName, 'e2e-install');
  log(`   /api/health: ${JSON.stringify(body)}`);

  const daemonExe = exePathOf(daemonPid);
  assert.equal(daemonExe.toLowerCase(), join(targetA, 'resources', 'runtime', 'node.exe').toLowerCase(), 'o daemon tem que rodar no node.exe embutido da instalação');
  log(`   daemon (pid ${daemonPid}) roda em ${daemonExe}`);

  assert.equal(await page.evaluate(() => typeof window.nanachiDesktop?.status), 'function', 'a ponte window.nanachiDesktop tem que existir');
  const title = await page.title();
  log(`   título do painel: ${JSON.stringify(title)}`);
  await shot(page, 'app-instalado-painel');

  assertDesktopHome();
  const logText = readFileSync(join(home, 'desktop-daemon.log'), 'utf8');
  assert.match(logText, /bandeja criada/);
  assert.ok(!/EBUSY|ENOENT: no such file/.test(logText), `erro no log do Desktop:\n${logText}`);

  await instance.close();
  apps.delete(instance);
  await until('o app e o daemon terminarem ao sair', () => !isAlive(electronPid) && !isAlive(daemonPid), 20_000);
  assert.deepEqual(processesUnder(targetA), [], 'não deve sobrar processo da instalação');
  log('   sair fechou o app e o daemon dele; nada sobrou');
}

/** App da pasta A aberto: a janela do instalador pergunta, fecha o app e o daemon e reinstala por cima. */
async function installOverRunningApp() {
  log(`3. instalar por cima de ${targetA} com o app aberto`);
  const running = await runInstalledApp(targetA);
  const oldMarker = JSON.parse(readFileSync(join(targetA, '.nanachi-install.json'), 'utf8'));
  writeFileSync(join(targetA, 'resources', 'sobra-de-versao-antiga.txt'), 'deve sumir na atualização');

  const instance = await launch(installerAppExe, testFlags(targetA), { NANACHI_INSTALLER_LOG: installerLog });
  const page = await instance.firstWindow();
  await page.waitForSelector('[data-slot=install]', { state: 'visible', timeout: 30_000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('[data-slot=install]').click();
  await page.locator('[data-view=close]').waitFor({ state: 'visible', timeout: 60_000 });
  assert.ok(isAlive(running.electronPid), 'o app só pode ser fechado depois de o usuário concordar');
  log(`   pergunta: ${await page.locator('[data-slot=close-detail]').textContent()}`);
  await sleep(500);
  await shot(page, 'instalador-fechar-app');
  await page.locator('[data-slot=close-confirm]').click();
  await page.locator('[data-view=done]').waitFor({ state: 'visible', timeout: 300_000 });
  assert.equal(isAlive(running.electronPid), false, 'o instalador tem que fechar o app aberto');
  assert.equal(isAlive(running.daemonPid), false, 'o instalador tem que fechar o daemon do app');
  apps.delete(running.instance);
  assert.equal(existsSync(join(targetA, 'resources', 'sobra-de-versao-antiga.txt')), false, 'a atualização limpa o que a versão nova não traz');
  const marker = JSON.parse(readFileSync(join(targetA, '.nanachi-install.json'), 'utf8'));
  assert.equal(marker.complete, true);
  assert.notEqual(marker.installedAt, oldMarker.installedAt);
  assert.ok(existsSync(join(targetA, 'resources', 'runtime', 'node.exe')));
  const installerPid = instance.process().pid;
  await page.locator('[data-slot=done-close]').click();
  await until('o instalador fechar', () => !isAlive(installerPid), 20_000);
  apps.delete(instance);
  log('   o instalador fechou o app e o daemon e atualizou a instalação');
}

/** Dirige a janela do instalador (o mesmo app do exe portable, desempacotado) e instala na pasta B. */
async function installWithWindow() {
  log(`4. janela do instalador, pasta ${targetB}`);
  assert.ok(existsSync(installerAppExe), `faltou ${installerAppExe}; rode npm run package -w @nanachi/desktop`);
  const instance = await launch(installerAppExe, testFlags(targetB), { NANACHI_INSTALLER_LOG: installerLog });
  const page = await instance.firstWindow();
  await page.waitForSelector('[data-slot=install]', { state: 'visible', timeout: 30_000 });
  assert.equal(await page.locator('[data-slot=target]').inputValue(), targetB);
  assert.match((await page.locator('[data-slot=scope]').textContent()) ?? '', /modo de teste/);
  assert.equal(await page.locator('[data-slot=version]').textContent(), `Versão ${version}`);

  for (const [scheme, label] of [['light', 'claro'], ['dark', 'escuro']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(500);
    await shot(page, `instalador-inicio-${label}`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.locator('[data-slot=options-open]').click();
  await page.locator('[data-slot=target]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-slot=desktop-shortcut]').isChecked(), true, 'atalho da área de trabalho começa ligado');
  assert.equal(await page.locator('[data-slot=start-with-windows]').isChecked(), true, 'iniciar com o Windows começa ligado');
  await shot(page, 'instalador-opcoes');

  // Uma pasta que o guarda recusa: a janela avisa sem instalar nada.
  await page.locator('[data-slot=target]').fill(homedir());
  await page.locator('[data-slot=install-from-options]').click();
  await page.locator('[data-slot=target-error]').waitFor({ state: 'visible', timeout: 10_000 });
  log(`   pasta recusada: ${await page.locator('[data-slot=target-error]').textContent()}`);
  await shot(page, 'instalador-pasta-recusada');
  assert.equal(existsSync(join(homedir(), '.nanachi-install.json')), false);
  await page.locator('[data-slot=target]').fill(targetB);

  await page.locator('[data-slot=install-from-options]').click();
  await page.locator('[data-view=progress]').waitFor({ state: 'visible', timeout: 10_000 });
  let shotProgress = false;
  await until('o instalador terminar', async () => {
    const done = await page.locator('[data-view=done]').isVisible().catch(() => false);
    if (!done && !shotProgress) {
      const percent = Number(((await page.locator('[data-slot=percent]').textContent().catch(() => '0%')) ?? '0%').replace('%', ''));
      if (percent >= 20 && percent <= 90) {
        await shot(page, 'instalador-progresso');
        log(`   progresso: ${await page.locator('[data-slot=step]').textContent()} ${percent}%`);
        shotProgress = true;
      }
    }
    if (await page.locator('[data-view=error]').isVisible().catch(() => false)) {
      throw new Error(`o instalador mostrou erro: ${await page.locator('[data-slot=error-message]').textContent()}`);
    }
    return done;
  }, 300_000);
  assert.ok(shotProgress, 'deveria ter dado para fotografar o progresso no meio');
  await sleep(600);
  await shot(page, 'instalador-pronto');
  assert.equal(await page.locator('[data-slot=launch]').isVisible(), true, '"Abrir o Nanachi" aparece no fim');
  assert.ok(existsSync(join(targetB, 'Nanachi.exe')));
  assert.equal(JSON.parse(readFileSync(join(targetB, '.nanachi-install.json'), 'utf8')).complete, true);

  const installerPid = instance.process().pid;
  await page.locator('[data-slot=done-close]').click();
  await until('o instalador fechar', () => !isAlive(installerPid), 20_000);
  apps.delete(instance);
  log('   instalado pela janela; Fechar encerrou o instalador');
}

/** App da pasta B aberto + janela de desinstalação: ela fecha o app e o daemon, remove a pasta e mantém os dados. */
async function uninstallWithWindow() {
  log(`5. desinstalar ${targetB} pela janela, com o app aberto`);
  const running = await runInstalledApp(targetB);
  assert.ok(isAlive(running.electronPid) && isAlive(running.daemonPid));

  const uninstaller = await launch(join(targetB, 'Nanachi.exe'), ['--uninstall', '--target', targetB, '--no-shortcuts', '--no-registry'], desktopEnv());
  const uninstallerPid = uninstaller.process().pid;
  const page = await uninstaller.firstWindow();
  await page.waitForSelector('[data-slot=remove]', { state: 'visible', timeout: 30_000 });
  assert.equal(await page.locator('[data-slot=delete-data]').isChecked(), false, '"Apagar também os dados" começa desmarcado');
  assert.equal(await page.locator('[data-slot=data-dir]').textContent(), home);
  for (const [scheme, label] of [['light', 'claro'], ['dark', 'escuro']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(500);
    await shot(page, `desinstalar-confirmar-${label}`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.locator('[data-slot=remove]').click();
  await page.locator('[data-view=done]').waitFor({ state: 'visible', timeout: 180_000 });
  await sleep(400);
  await shot(page, 'desinstalar-pronto');
  log(`   resultado: ${await page.locator('[data-slot=done-detail]').textContent()}`);

  assert.equal(isAlive(running.electronPid), false, 'o app aberto tem que ser fechado pelo desinstalador');
  assert.equal(isAlive(running.daemonPid), false, 'o daemon do app tem que ser fechado pelo desinstalador');
  apps.delete(running.instance);

  await page.locator('[data-slot=done-close]').click();
  await until('o desinstalador sair', () => !isAlive(uninstallerPid), 20_000);
  apps.delete(uninstaller);
  await until('a pasta da instalação sumir (limpeza agendada)', () => !existsSync(targetB), 90_000);
  log('   a pasta B sumiu');
  assertDataKept();
}

function assertDataKept() {
  assert.ok(existsSync(join(home, 'config.json')), 'a pasta de dados do Desktop (NANACHI_DESKTOP_HOME) tem que continuar');
  assert.ok(existsSync(join(home, 'data.db')), 'o banco do daemon tem que continuar');
  assert.ok(existsSync(userData), 'o userData do Desktop tem que continuar');
  log('   NANACHI_DESKTOP_HOME e userData continuam');
}

async function uninstallYesDeletingData() {
  log(`6. desinstalar ${targetA} com --yes --delete-data (sem janela de pergunta)`);
  const child = spawn(join(targetA, 'Nanachi.exe'), ['--uninstall', '--target', targetA, '--no-shortcuts', '--no-registry', '--yes', '--delete-data'], {
    env: { ...process.env, ...desktopEnv() },
    stdio: 'ignore',
    windowsHide: true,
  });
  pids.add(child.pid);
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  assert.equal(code, 0, 'o desinstalador com --yes sai com código 0');
  await until('a pasta da instalação sumir (limpeza agendada)', () => !existsSync(targetA), 90_000);
  log('   a pasta A sumiu');
  assert.equal(existsSync(home), false, '--delete-data apaga a pasta de dados do Desktop (NANACHI_DESKTOP_HOME, temporária)');
  assert.equal(existsSync(userData), false, '--delete-data apaga o userData do Desktop (também temporário)');
  assert.equal(existsSync(standaloneDecoy), false, 'o NANACHI_HOME do ambiente (daemon avulso) nunca é tocado');
  log('   NANACHI_DESKTOP_HOME e userData temporários foram apagados, só porque --delete-data foi pedido');
}

async function run() {
  assert.ok(existsSync(setupExe), `faltou ${setupExe}; rode npm run package -w @nanachi/desktop`);
  assert.ok(existsSync(payloadMeta), `faltou ${payloadMeta}`);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  assert.notEqual(port, 7777, 'a porta 7777 é do supervisor');
  assert.notEqual(port, 7780, "7780 is Desktop's default port; this script uses any other free port");
  setupFolders();
  const before = realSystemState();
  log(`pasta temporária ${root}; porta ${port}`);
  log(`estado real antes: ${JSON.stringify(before)}`);

  await installWithSetupExe();
  await verifyInstalledApp();
  await installOverRunningApp();
  await installWithWindow();
  await uninstallWithWindow();
  await uninstallYesDeletingData();

  const after = realSystemState();
  assert.deepEqual(after, before, 'o modo de teste não pode mudar atalhos, registro, item de login nem %LOCALAPPDATA%\\Programs');
  log('estado real depois: igual ao de antes');
  const listing = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.split(String.fromCharCode(10));
  const tasks = listing.filter((line) => /^"Nanachi/i.test(line.trim()));
  log(`tasklist: ${tasks.length === 0 ? 'nenhum processo Nanachi*.exe' : tasks.join(' | ')}`);
  log('OK');
}

let failed = false;
try {
  await run();
} catch (error) {
  failed = true;
  console.error(`[e2einstall] FALHOU: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (existsSync(installerLog)) console.error(`[e2einstall] log do instalador:\n${readFileSync(installerLog, 'utf8')}`);
} finally {
  for (const instance of apps) await instance.close().catch(() => undefined);
  for (const pid of pids) if (isAlive(pid)) killTree(pid);
  // Qualquer processo que ainda rode de dentro da pasta temporária também cai.
  for (const leftover of processesUnder(root)) killTree(leftover.pid);
  await sleep(1_000);
  const survivors = processesUnder(root);
  if (survivors.length > 0) console.error(`[e2einstall] processos que sobraram: ${JSON.stringify(survivors)}`);
  removeTree(root, undefined, { retries: 5, retryDelayMs: 500 });
}
process.exit(failed ? 1 : 0);
