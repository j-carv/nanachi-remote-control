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
 *   2. os arquivos instalados batem com o payload; o app instalado sobe o daemon com o node.exe embutido; o centro de
 *      controle (a janela principal, carregado do app.asar) abre com a ponte e os botões da barra de título e as seções
 *      carregam sem erro; a seção "Sessões" (Ctrl+8) mostra a PWA numa vista sobre a área de conteúdo (o tamanho da vista é
 *      conferido pela própria página da PWA: innerWidth/innerHeight contra o retângulo do <main>; a posição exata e o
 *      esconder ao trocar de seção, view.getBounds() e view.getVisible(), são conferidos por e2e/run-desktop.mjs); o idioma (pt-BR, English, Español) troca o centro de controle e a PWA (nanachi.language); o app
 *      salva o idioma da primeira execução (`--lang`); /api/health responde; sair deixa nada para trás. O menu da bandeja
 *      NÃO é conferido aqui (o app empacotado não tem o inspetor do Node, então o processo principal fica fora de alcance):
 *      isso é feito por e2e/run-desktop.mjs, que roda o mesmo código em desenvolvimento;
 *   3. com o app da pasta A aberto, a janela do instalador (o mesmo app do exe portable, desempacotado) pergunta se pode
 *      fechá-lo, fecha o app e o daemon dele e reinstala por cima (atualização);
 *   4. a janela do instalador, na pasta B: tela inicial (claro e escuro), Opções, pasta recusada, progresso, pronto; antes
 *      disso o instalador abre em espanhol e em inglês pelo idioma do sistema (`--lang`), sem instalar nada;
 *   5. com o app da pasta B aberto (idioma salvo: español), a janela de desinstalação abre em espanhol (o idioma salvo vale mais
 *      que o do sistema), pergunta, remove e fecha o app e o daemon dele; a pasta B some e os dados (NANACHI_HOME, userData) ficam;
 *   6. a pasta A é removida por `--uninstall --yes --delete-data` (sem janela de pergunta); desta vez os dados vão junto;
 *   7. nenhum processo sobra; o sistema de verdade está igual ao começo.
 *
 * Como rodar (da raiz, depois de `npm run package -w @nanachi/desktop`; não usa a porta 7777):
 *   node e2e/run-desktop-install.mjs
 *
 * Screenshots dos instaladores em e2e/screenshots/desktop/; os da seção Sessões (centro de controle e PWA, claro e escuro) numa
 * pasta temporária fora do repositório, cujo caminho é impresso no fim.
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
// Screenshots of the Sessões section: a temp folder outside the repository that survives the run (the run prints its path).
const sessionShots = join(tmpdir(), `nanachi-install-shots-${randomBytes(4).toString('hex')}`);
// A pasta temporária sai pelo mesmo removedor do app (nunca `rmSync` recursivo: ele segue junções no Node do Electron).
const { removeTree } = await import(pathToFileURL(join(desktopDir, 'dist', 'install', 'safe-remove.js')).href);
// The texts the pages and the control center show, from the compiled dictionary (the same one the apps carry).
const { translate } = await import(pathToFileURL(join(desktopDir, 'dist', 'common', 'i18n', 'index.js')).href);

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
  for (const dir of [home, userData, shotsDir, sessionShots, dirname(targetA), dirname(targetB)]) mkdirSync(dir, { recursive: true });
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
    /** Every window of the app (the control center, the sessions window, ...). */
    pages: () => browser.contexts().flatMap((context) => context.pages()),
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

const isControlUrl = (url) => url.startsWith('file:') && url.endsWith('/control/index.html');

/** Console errors and uncaught errors of the control center page (the installed app's own renderer). */
const controlProblems = [];

/** The control center is the main window: it opens on launch, from the app.asar, with the real preload. */
async function controlPage(instance, heading = 'Visão geral') {
  let found = null;
  await until('a janela do centro de controle abrir', () => {
    found = instance.pages().find((page) => isControlUrl(page.url())) ?? null;
    return found !== null;
  }, 90_000);
  found.on('console', (message) => {
    if (message.type() === 'error') controlProblems.push(`console.error: ${message.text()}`);
  });
  found.on('pageerror', (error) => controlProblems.push(`pageerror: ${error.message}`));
  await found.waitForLoadState('domcontentloaded');
  await found.getByRole('heading', { name: heading, level: 1 }).waitFor({ state: 'visible', timeout: 30_000 });
  return found;
}

/**
 * The "Sessões" section of the control center (Ctrl+8): the PWA is drawn in a view over the content area, so it is one more
 * page of the same window. Returns both pages.
 */
async function sessionsPage(instance, control) {
  await control.keyboard.press('Control+8');
  let page = null;
  await until('a PWA carregar na vista das sessões', () => {
    page = instance.pages().find((candidate) => candidate.url().startsWith(`${origin}/`)) ?? null;
    return page !== null;
  }, 90_000);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function health() {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
  return { status: response.status, body: await response.json() };
}

/** `locale` is what the system would say (`--lang`): only the first run of an installation reads it; a saved language wins. */
async function runInstalledApp(target, locale = 'pt-BR') {
  const exe = join(target, 'Nanachi.exe');
  const instance = await launch(exe, [`--lang=${locale}`], desktopEnv());
  const electronPid = instance.process().pid;
  const control = await controlPage(instance);
  const page = await sessionsPage(instance, control);
  log(`   PWA carregada na vista das sessões: ${page.url()}`);
  const status = await page.evaluate(async () => await window.nanachiDesktop.status());
  assert.equal(status.mode, 'spawned', 'o app instalado deveria ter subido o próprio daemon');
  assert.ok(Number.isInteger(status.pid));
  pids.add(status.pid);
  return { instance, page, control, electronPid, daemonPid: status.pid };
}

/**
 * The installed app's control center: the real renderer from app.asar talking to the real main process and the embedded
 * daemon. Sections load with no error state and no console error (the accounts section is skipped: it would read this
 * PC's real agent logins).
 */
async function verifyControlCenter(control) {
  assert.equal(await control.evaluate(() => typeof window.nanachiControl), 'object', 'a ponte window.nanachiControl tem que existir no app instalado');
  assert.equal(await control.evaluate(() => typeof window.nanachiDesktop), 'undefined', 'o centro de controle não recebe a ponte do painel de sessões');
  assert.equal(await control.evaluate(() => window.nanachiControl.version), version);
  const bar = control.locator('header').first();
  for (const name of ['Minimizar', 'Maximizar', 'Fechar']) await bar.getByRole('button', { name, exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  const tour = [
    ['Visão geral', 'Serviços'],
    ['Pastas e discos', 'Pastas permitidas'],
    ['Aparelhos', 'Este app'],
    ['Tailscale', 'Tailscale embutido'],
    ['Logs', 'Abrir pasta dos logs'],
    ['Ajustes', 'Iniciar com o Windows'],
  ];
  const sidebar = control.locator('nav#sidebar');
  for (const [label, marker] of tour) {
    await sidebar.locator('ul').getByRole('button', { name: label, exact: true }).click();
    await control.getByRole('heading', { name: label, level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
    await until(`${label} terminar de carregar`, async () => (await control.locator('[aria-busy="true"]').count()) === 0, 30_000);
    await control.locator('main').getByText(marker).first().waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await control.locator('main [role="alert"]').count(), 0, `${label}: estado de erro na tela`);
  }
  assert.deepEqual(controlProblems, [], 'o centro de controle do app instalado logou erros');
  const overview = await control.evaluate(() => window.nanachiControl.overview());
  assert.equal(overview.ok, true, JSON.stringify(overview));
  assert.equal(overview.value.daemon.mode, 'spawned');
  assert.notEqual(overview.value.activity, null, 'o daemon embutido respondeu às chamadas autenticadas do Desktop');
  await sidebar.locator('ul').getByRole('button', { name: 'Visão geral', exact: true }).click();
  await shot(control, 'app-instalado-centro-de-controle');
  log('   centro de controle do app instalado: seis seções abrem sem erro, a ponte e os botões da barra de título existem');
}

const storedLanguage = () => JSON.parse(readFileSync(join(userData, 'desktop-settings.json'), 'utf8')).language;

/** The view as the PWA's own page sees it, and the content area as the control center's page sees it (both in DIP). */
async function viewAndContent(control, pwa) {
  const content = await control.evaluate(() => {
    const rect = document.querySelector('main#main').getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, screenX: window.screenX, screenY: window.screenY };
  });
  const view = await pwa.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, screenX: window.screenX, screenY: window.screenY, visibility: document.visibilityState }));
  return { content, view };
}

const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

/**
 * The PWA's view is as big as the content area and shown. Its place (x 232, y 40) is not visible to a page (`screenX` is the
 * window's): `e2e/run-desktop.mjs` reads it from `view.getBounds()` in the main process, which a packaged app does not allow.
 */
async function expectViewOverContent(control, pwa, why) {
  let last = null;
  await until(
    `${why}: the view covers the content area`,
    async () => {
      last = await viewAndContent(control, pwa);
      const { content, view } = last;
      return (
        view.visibility === 'visible' &&
        near(view.width, content.width) &&
        near(view.height, content.height) &&
        // `screenX/screenY` of a view's page are those of its window, so the view starts where the window does.
        view.screenX === content.screenX &&
        view.screenY === content.screenY
      );
    },
    15_000,
  ).catch((error) => {
    throw new Error(`${error.message}; last seen ${JSON.stringify(last)}`);
  });
}

/** Screenshots of the Sessões section: the control center page and the PWA page, light and dark, in the temp folder. */
async function shotSessions(control, pwa, name) {
  for (const [scheme, label] of [['light', 'claro'], ['dark', 'escuro']]) {
    await control.emulateMedia({ colorScheme: scheme });
    await pwa.emulateMedia({ colorScheme: scheme });
    await sleep(600);
    await control.screenshot({ path: join(sessionShots, `${name}-centro-de-controle-${label}.png`) });
    await pwa.screenshot({ path: join(sessionShots, `${name}-pwa-${label}.png`) });
  }
  await control.emulateMedia({ colorScheme: 'light' });
  await pwa.emulateMedia({ colorScheme: 'light' });
  log(`   screenshots de ${name} (claro e escuro) em ${sessionShots}`);
}

const LANGUAGE_RADIO = { 'pt-BR': 'Português (Brasil)', en: 'English', es: 'Español' };

/** The "Idioma" row of Ajustes: the control center changes at once and the PWA in the view gets `nanachi.language`. */
async function switchLanguage(control, pwa, code) {
  const label = (key) => translate(code, key);
  await control.keyboard.press('Control+7');
  const radio = control.getByRole('radio', { name: LANGUAGE_RADIO[code], exact: true });
  await radio.waitFor({ state: 'visible', timeout: 10_000 });
  await radio.click();
  await until(`o centro de controle fala ${code}`, async () => (await control.evaluate(() => document.documentElement.lang)) === code && (await control.locator('#page-title').textContent()) === label('control.sections.settings.label'), 10_000);
  const sections = ['overview', 'folders', 'devices', 'accounts', 'tailscale', 'logs', 'settings', 'sessions'];
  assert.deepEqual(
    await control.locator('nav#sidebar ul li button span.truncate').allTextContents(),
    sections.map((id) => label(`control.sections.${id}.label`)),
    `a barra lateral em ${code}`,
  );
  await control.locator('header').first().getByRole('button', { name: label('control.shell.titleBar.minimize'), exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  await until(`${code} fica salvo`, async () => storedLanguage() === code, 5_000);
  await until(
    `a PWA recebe nanachi.language = ${code} do Desktop`,
    async () => (await pwa.evaluate(() => ({ stored: localStorage.getItem('nanachi.language'), lang: document.documentElement.lang })).catch(() => null))?.stored === code,
    30_000,
  );
  log(`   idioma ${code}: barra lateral, barra de título e títulos mudaram; salvo em desktop-settings.json; a PWA recebeu nanachi.language`);
}

/** Sessões: the view's size, Ctrl+8, the sidebar item, the "Abrir sessões" button, then the three languages. */
async function verifySessionsAndLanguages(control, pwa) {
  const sidebar = control.locator('nav#sidebar');
  assert.equal(storedLanguage(), 'pt-BR', 'a primeira execução salvou o idioma que o sistema sugeriu (--lang=pt-BR)');
  assert.equal(await pwa.evaluate(() => typeof window.nanachiControl), 'undefined', 'a PWA na vista nunca recebe a API do centro de controle');
  assert.equal(await pwa.evaluate(() => typeof window.nanachiDesktop?.status), 'function', 'a PWA na vista recebe a ponte pequena do painel');
  assert.equal(control.context().pages().filter((candidate) => isControlUrl(candidate.url())).length, 1, 'o centro de controle é a única janela do app (a janela separada da PWA acabou)');

  // Sessões is the current section (Ctrl+8) and the view sits exactly over the content area.
  assert.equal(await control.locator('#page-title').textContent(), 'Sessões');
  assert.equal(await sidebar.locator('ul').getByRole('button', { name: 'Sessões', exact: true }).getAttribute('aria-current'), 'page');
  await expectViewOverContent(control, pwa, 'Sessões aberta');
  await pwa.getByRole('button', { name: 'Ajustes', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  log('   Sessões: a PWA renderizou na vista, que cobre a área de conteúdo (abaixo da barra de título, à direita da barra lateral)');
  await shotSessions(control, pwa, 'sessoes');

  // On Sessões the sidebar is always the 64 px rail (nothing to collapse, no "Abrir sessões" button of its own), so the PWA in
  // the view keeps its wide layout. Another section hides the view.
  assert.equal(await control.getByRole('button', { name: 'Recolher a barra lateral' }).count(), 0, 'Sessões não tem botão de recolher a barra lateral');
  assert.equal(await sidebar.getByRole('button', { name: 'Abrir sessões', exact: true }).count(), 0, 'a barra lateral não tem mais o botão "Abrir sessões"');
  assert.equal(await sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)), 64, 'a barra lateral é o trilho de 64 px em Sessões');
  // Whether the view is hidden is `view.getVisible()` in the main process (e2e/run-desktop.mjs); a CDP-attached page keeps
  // reporting `visible`, so here only the page's own section is checked.
  await control.keyboard.press('Control+1');
  await until('Ctrl+1 leaves Sessões', async () => (await control.locator('#page-title').textContent()) === 'Visão geral', 10_000);
  await control.keyboard.press('Control+8');
  await expectViewOverContent(control, pwa, 'Ctrl+8');
  await sidebar.locator('ul').getByRole('button', { name: 'Visão geral', exact: true }).click();
  await until('o item Visão geral sai de Sessões', async () => (await control.locator('#page-title').textContent()) === 'Visão geral', 10_000);
  await sidebar.locator('ul').getByRole('button', { name: 'Sessões', exact: true }).click();
  await expectViewOverContent(control, pwa, 'item da barra lateral');
  await control.locator('nav#sidebar').getByRole('button', { name: 'Visão geral', exact: true }).click();
  await control.locator('main').getByRole('button', { name: 'Abrir sessões', exact: true }).click();
  await expectViewOverContent(control, pwa, 'botão "Abrir sessões" da Visão geral');
  log('   a vista volta com Ctrl+8, com o item da barra lateral e com "Abrir sessões" da Visão geral');

  // Languages: pt-BR -> English -> Spanish -> pt-BR. A language chosen inside the PWA stays there.
  await switchLanguage(control, pwa, 'en');
  await pwa.evaluate(() => localStorage.setItem('nanachi.language', 'pt-BR'));
  await pwa.reload();
  await until('a escolha feita dentro da PWA sobrevive ao recarregamento', async () => (await pwa.evaluate(() => localStorage.getItem('nanachi.language')).catch(() => null)) === 'pt-BR', 30_000);
  assert.equal(storedLanguage(), 'en', 'a escolha dentro da PWA não muda o idioma do Desktop');
  await switchLanguage(control, pwa, 'es');
  await control.keyboard.press('Control+8');
  await expectViewOverContent(control, pwa, 'Sessões em espanhol');
  await shotSessions(control, pwa, 'sessoes-espanhol');
  await switchLanguage(control, pwa, 'pt-BR');
  await control.keyboard.press('Control+1');
  assert.deepEqual(controlProblems, [], 'o centro de controle logou erros');
}

async function verifyInstalledApp() {
  log(`2. app instalado em ${targetA} (porta ${port})`);
  const { instance, page, control, electronPid, daemonPid } = await runInstalledApp(targetA, 'pt-BR');

  const { status, body } = await health();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.machineName, 'e2e-install');
  log(`   /api/health: ${JSON.stringify(body)}`);

  const daemonExe = exePathOf(daemonPid);
  assert.equal(daemonExe.toLowerCase(), join(targetA, 'resources', 'runtime', 'node.exe').toLowerCase(), 'o daemon tem que rodar no node.exe embutido da instalação');
  log(`   daemon (pid ${daemonPid}) roda em ${daemonExe}`);

  assert.equal(await page.evaluate(() => typeof window.nanachiDesktop?.status), 'function', 'a ponte window.nanachiDesktop tem que existir');
  await verifyControlCenter(control);
  await control.keyboard.press('Control+8');
  await expectViewOverContent(control, page, 'Sessões do app instalado');
  const title = await page.title();
  log(`   título da PWA: ${JSON.stringify(title)}`);
  await shot(page, 'app-instalado-painel');
  await verifySessionsAndLanguages(control, page);

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

  const instance = await launch(installerAppExe, [...testFlags(targetA), '--lang=pt-BR'], { NANACHI_INSTALLER_LOG: installerLog });
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

/**
 * The installer runs before any setting exists: it speaks the language of the system locale (`--lang` here). Spanish and
 * English windows are opened and closed without installing anything.
 */
async function installerInOtherLanguages() {
  for (const [locale, code] of [['es-419', 'es'], ['en-US', 'en'], ['de-DE', 'en']]) {
    const instance = await launch(installerAppExe, [...testFlags(targetB), `--lang=${locale}`], { NANACHI_INSTALLER_LOG: installerLog });
    const page = await instance.firstWindow();
    await page.waitForSelector('[data-slot=install]', { state: 'visible', timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), code, `${locale}: o instalador fala ${code}`);
    assert.equal(await page.locator('[data-slot=options-open]').textContent(), translate(code, 'installer.setup.options'));
    assert.equal(await page.locator('[data-view=idle] p.muted').textContent(), translate(code, 'installer.setup.tagline'));
    assert.equal(await page.locator('[data-slot=version]').textContent(), translate(code, 'installer.common.version', { version }));
    const pid = instance.process().pid;
    await page.locator('[data-slot=close]').click();
    await until('o instalador fechar', () => !isAlive(pid), 20_000);
    apps.delete(instance);
    log(`   o instalador em ${locale} fala ${code} (nada foi instalado)`);
  }
  assert.equal(existsSync(targetB), false, 'abrir e fechar o instalador não instala nada');
}

/** Dirige a janela do instalador (o mesmo app do exe portable, desempacotado) e instala na pasta B. */
async function installWithWindow() {
  log(`4. janela do instalador, pasta ${targetB}`);
  assert.ok(existsSync(installerAppExe), `faltou ${installerAppExe}; rode npm run package -w @nanachi/desktop`);
  await installerInOtherLanguages();
  const instance = await launch(installerAppExe, [...testFlags(targetB), '--lang=pt-BR'], { NANACHI_INSTALLER_LOG: installerLog });
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
  const running = await runInstalledApp(targetB, 'pt-BR');
  assert.ok(isAlive(running.electronPid) && isAlive(running.daemonPid));
  // The language Desktop saved is what the uninstall window speaks, whatever the system locale says (`--lang=pt-BR` below).
  assert.equal(await running.control.evaluate(() => window.nanachiControl.settings.setLanguage('es')), 'es');
  await until('el español queda guardado', async () => storedLanguage() === 'es', 5_000);

  const uninstaller = await launch(join(targetB, 'Nanachi.exe'), ['--uninstall', '--target', targetB, '--no-shortcuts', '--no-registry', '--lang=pt-BR'], desktopEnv());
  const uninstallerPid = uninstaller.process().pid;
  const page = await uninstaller.firstWindow();
  await page.waitForSelector('[data-slot=remove]', { state: 'visible', timeout: 30_000 });
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'es', 'a janela de desinstalação usa o idioma salvo');
  assert.equal(await page.locator('[data-slot=remove]').textContent(), translate('es', 'installer.uninstall.remove'));
  assert.equal(await page.locator('h2').first().textContent(), translate('es', 'installer.uninstall.confirmTitle'));
  log('   a janela de desinstalação abriu em espanhol (idioma salvo), com o sistema em pt-BR');
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

  // O clique fecha a janela e o processo sai junto: o Playwright pode ver a página sumir antes de o clique "terminar".
  await page.locator('[data-slot=done-close]').click().catch(() => undefined);
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
  log(`screenshots da seção Sessões: ${sessionShots}`);
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
  console.log(`[e2einstall] screenshots da seção Sessões: ${sessionShots}`);
}
process.exit(failed ? 1 : 0);
