/*
 * Smoke do Nanachi Desktop (Electron em desenvolvimento, `electron packages/desktop`): o centro de controle abre ao iniciar e
 * funciona com o processo principal de verdade; o painel de sessões carrega a PWA do daemon que o Desktop sobe, a seção
 * "Desktop" aparece em Ajustes e o cartão "Tailscale embutido" mostra os eventos de um sidecar FALSO (needs_login e depois running).
 *
 * Segurança: o sidecar real (nanachi-tsnet.exe) registraria um dispositivo na tailnet de quem fizer login, então este
 * script nunca o inicia. Ele compila `packages/desktop/test/fixtures/fake-tsnet` (só biblioteca padrão do Go, sem rede)
 * e aponta o Desktop para o executável falso com NANACHI_DESKTOP_TSNET_PATH. A pasta de build também é redirecionada
 * para uma pasta vazia, então mesmo sem o override o sidecar real não seria achado.
 *
 * Privacy: Desktop (and the daemon it starts) run with USERPROFILE/HOME pointing at an empty temporary folder, so the
 * agents' login checks (Contas dos agentes) never see the real accounts of whoever runs this script.
 *
 * O que confere:
 *   0. (config seeding) a fresh Desktop data folder gets config.json with { "port": 7780 } (the compiled function, no
 *      process started), and an existing config.json is never rewritten;
 *   1. control center (the main window, the real renderer with the real preload and main process, not the "missing bridge"
 *      page): it opens on launch; the title bar has the three buttons, maximize toggles the window state, minimize and
 *      close (hide to the tray) work and a second launch brings it back; each of the seven sections renders (Ctrl+1..7
 *      and the sidebar) with no console error, no error state and no unexpected line in Desktop's log; the Folders
 *      editor adds a folder (the native picker is replaced by a stub in the main process), saving writes `allowedRoots` in
 *      the temp Desktop config.json (every other key and the key order preserved), restarts the temp daemon (new pid,
 *      old one gone) and /api/roots reflects it; Aparelhos lists "Este app" (and its pairing code and revoke work);
 *   2. screenshots of every section, light and dark, go to a temp folder OUTSIDE the repository, whose path is printed
 *      (nothing from the control center is written under e2e/screenshots);
 *   3. "Abrir sessões" opens the PWA window: the daemon's origin (free port, not 7777 or 7780, NANACHI_DESKTOP_HOME and
 *      userData temporary, empty allowlist); config.json keeps the port this script chose, and a NANACHI_HOME decoy in
 *      the environment (the standalone daemon's folder) is never read or created;
 *   4. Ajustes (in the PWA) has the "Desktop" group with the daemon running, "Iniciar com o Windows", the pairing code and the version;
 *   5. turning "Tailscale embutido" on starts only the fake sidecar, with the contract flags and TS_NO_LOGS_NO_SUPPORT=true,
 *      and the card shows needs_login (link) and then running (https address); the control center follows the same events;
 *   6. the pairing code shows up in a sheet;
 *   7. turning it off closes the sidecar's stdin (polite stop) and the process goes away;
 *   8. quitting Desktop with Tailscale on takes down the sidecar and the daemon it started;
 *   9. opening again restores "Tailscale embutido" by itself (tailscaleEnabled).
 *
 * Como rodar (da raiz, com o supervisor já tendo publicado o daemon e a PWA; compile o Desktop antes):
 *   npm run build:desktop -w @nanachi/desktop
 *   node e2e/run-desktop.mjs
 *
 * Pré-requisitos: Node 22+, Go no PATH (para o sidecar falso), Electron instalado (workspace desktop). Não usa a
 * porta 7777 nem mexe no daemon do supervisor. Screenshots da PWA em e2e/screenshots/desktop/ (ignorada pelo git); as do
 * centro de controle numa pasta temporária fora do repositório (o caminho é impresso).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const electronBinary = require('electron');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');
const shotsDir = join(here, 'screenshots', 'desktop');
const log = (line) => console.log(`[e2edesktop] ${line}`);
// A pasta temporária sai pelo mesmo removedor do app (nunca `rmSync` recursivo: ele segue junções no Node do Electron).
const { removeTree } = await import(pathToFileURL(join(desktopDir, 'dist', 'install', 'safe-remove.js')).href);

const id = randomBytes(4).toString('hex');
const root = join(tmpdir(), `nanachi-e2edesktop-${id}`);
const home = join(root, 'home');
// Stands in for the standalone daemon's NANACHI_HOME, which Desktop must ignore: it never exists, and the run checks it stays that way.
const standaloneDecoy = join(root, 'standalone-nanachi-home');
const userData = join(root, 'userdata');
const buildDir = join(root, 'empty-build-dir');
const fakeExe = join(root, 'fake-tsnet.exe');
const record = join(root, 'fake-tsnet-record.json');
const recordLog = `${record}.log`;
// Desktop and the daemon see this as the user's profile (agent login checks look in `~`).
const fakeUser = join(root, 'fake-user');
// A folder to add in the control center's folder editor.
const allowedFolder = join(root, 'allowed-projects');
// Control center screenshots: a temp folder outside the repository that survives the run (the run prints its path).
const controlShots = join(tmpdir(), `nanachi-control-shots-${id}`);

let port = 0;
let origin = '';
let configText = '';
/** Token of the device the script paired (the phone stand-in); used to ask the daemon for /api/roots. */
let phoneToken = '';
/** Cada processo que este script iniciou, para a limpeza no fim. */
const pids = new Set();
let app = null;

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

function setupFolders() {
  for (const dir of [home, userData, buildDir, shotsDir, fakeUser, controlShots, allowedFolder]) mkdirSync(dir, { recursive: true });
  // Desktop only creates config.json (port 7780) when it is missing. This script picks a free port and writes the file
  // first, so port 7780 (which may be taken) never comes into play.
  // Allowlist vazia: o painel local usa o daemon sem a "chave local" (que não faz parte desta entrega).
  const config = {
    port,
    host: '127.0.0.1',
    machineName: 'e2e-desktop',
    allowedRoots: [home],
    allowedTailscaleLogins: [],
    tailscaleAutoPair: false,
    corsOrigins: [],
    agents: {},
  };
  configText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(join(home, 'config.json'), configText);
}

/** What Desktop does by itself in a fresh folder (the compiled function; no process, no port). */
async function checkConfigSeeding() {
  const { DEFAULT_PORT, ensureDesktopConfig, resolveHome } = await import(pathToFileURL(join(desktopDir, 'dist', 'main', 'daemon-runtime.js')).href);
  assert.equal(DEFAULT_PORT, 7780);
  const fresh = join(root, 'fresh-desktop-home');
  assert.equal(ensureDesktopConfig(fresh), 'created');
  const bytes = readFileSync(join(fresh, 'config.json'));
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { port: 7780 });
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'config.json has no BOM');
  assert.equal(ensureDesktopConfig(fresh), 'kept');
  assert.equal(ensureDesktopConfig(home), 'kept', 'an existing config.json is never rewritten');
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configText);
  // NANACHI_HOME (the standalone daemon) does not count; only NANACHI_DESKTOP_HOME does.
  assert.equal(resolveHome({ NANACHI_HOME: standaloneDecoy, NANACHI_DESKTOP_HOME: home }), home);
  assert.notEqual(resolveHome({ NANACHI_HOME: standaloneDecoy }), standaloneDecoy);
  log('fresh Desktop home gets config.json with port 7780; an existing config.json is not rewritten');
}

/** After Desktop started and before anything edits it: config.json in Desktop's folder is what this script wrote (its chosen port), and the decoy never appeared. */
function checkHomeAfterStart() {
  const text = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal(JSON.parse(text).port, port, "Desktop's config.json holds the port this script chose");
  assert.equal(text, configText, 'Desktop does not rewrite an existing config.json');
  assert.ok(existsSync(join(home, 'data.db')), "the daemon Desktop started keeps its data in Desktop's folder (NANACHI_DESKTOP_HOME)");
  assert.equal(existsSync(standaloneDecoy), false, "Desktop never uses the environment's NANACHI_HOME (the standalone daemon's folder)");
  log("Desktop's own folder holds config.json (the chosen port) and data.db; the NANACHI_HOME decoy was never touched");
}

function buildFakeSidecar() {
  const result = spawnSync('go', ['build', '-o', fakeExe, '.'], {
    cwd: join(desktopDir, 'test', 'fixtures', 'fake-tsnet'),
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  if (result.status !== 0) throw new Error(`go build do sidecar falso falhou:\n${result.stderr}${result.stdout}`);
  log(`sidecar falso compilado: ${fakeExe}`);
}

function readRecord() {
  return existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
}

function recordEvents() {
  return existsSync(recordLog) ? readFileSync(recordLog, 'utf8').split('\n').filter(Boolean) : [];
}

async function until(description, check, timeout = 30_000, page = null) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      if (page !== null) {
        const name = `falha-${description.replace(/\W+/g, '-')}.png`;
        await page.screenshot({ path: join(shotsDir, name) }).catch(() => undefined);
      }
      throw new Error(`tempo esgotado esperando: ${description}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

/** The environment of every Desktop process of this run (the launched app and the second launch). */
function desktopEnv() {
  return {
    ...process.env,
    // The user's profile is an empty temp folder (see the header): no real agent login is ever read.
    USERPROFILE: fakeUser,
    HOME: fakeUser,
    // A pasta de dados do Desktop. O NANACHI_HOME de isca (o do daemon avulso) tem que ser ignorado.
    NANACHI_DESKTOP_HOME: home,
    NANACHI_HOME: standaloneDecoy,
    NANACHI_DESKTOP_USER_DATA: userData,
    // Nunca o sidecar real: o falso, e uma pasta de build vazia como segunda barreira.
    NANACHI_DESKTOP_TSNET_PATH: fakeExe,
    NANACHI_DESKTOP_BUILD_DIR: buildDir,
    FAKE_TSNET_RECORD: record,
    FAKE_TSNET_RUNNING_AFTER_MS: '5000',
  };
}

async function launch() {
  const instance = await electron.launch({
    executablePath: electronBinary,
    args: [desktopDir],
    cwd: repoRoot,
    env: desktopEnv(),
  });
  const pid = instance.process().pid;
  if (pid !== undefined) pids.add(pid);
  watchControlProblems(instance);
  return instance;
}

// ---------- the control center window ----------

/** The sections in sidebar order (Ctrl+1..7), with the title the page shows. */
const SECTIONS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'folders', label: 'Pastas e discos' },
  { id: 'devices', label: 'Aparelhos' },
  { id: 'accounts', label: 'Contas dos agentes' },
  { id: 'tailscale', label: 'Tailscale' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Ajustes' },
];

const isControlUrl = (url) => url.startsWith('file:') && url.endsWith('/control/index.html');

/** Console errors and uncaught errors of the control center page, for the whole run (the panel's PWA is not watched). */
const controlProblems = [];

function watchControlProblems(instance) {
  const attach = (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error' && isControlUrl(page.url())) controlProblems.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      if (isControlUrl(page.url())) controlProblems.push(`pageerror: ${error.message}`);
    });
  };
  for (const page of instance.windows()) attach(page);
  instance.on('window', attach);
}

function assertNoControlProblems(where) {
  assert.deepEqual(controlProblems, [], `the control center page logged errors (${where})`);
}

/** The control center window, with the real renderer loaded (title "Visão geral" on screen). */
async function controlPage(instance) {
  let found = null;
  await until(
    'the control center window opens',
    () => {
      found = instance.windows().find((window) => isControlUrl(window.url())) ?? null;
      return found !== null;
    },
    60_000,
  );
  await found.waitForLoadState('domcontentloaded');
  // Deterministic screenshots: no page transitions (the app turns them off under prefers-reduced-motion).
  await found.emulateMedia({ reducedMotion: 'reduce' });
  await found.getByRole('heading', { name: 'Visão geral', level: 1 }).waitFor({ state: 'visible', timeout: 30_000 });
  return found;
}

/** `window.nanachiControl.overview()`, unwrapped. */
async function overviewOf(page) {
  const result = await page.evaluate(() => window.nanachiControl.overview());
  assert.equal(result.ok, true, `overview() failed: ${JSON.stringify(result)}`);
  return result.value;
}

async function setTheme(instance, page, scheme) {
  // The window background follows nativeTheme; the page's media query is pinned by Playwright's emulation, so both are set.
  await instance.evaluate(({ nativeTheme }, source) => {
    nativeTheme.themeSource = source;
  }, scheme);
  await page.emulateMedia({ colorScheme: scheme });
  await until(`prefers-color-scheme ${scheme}`, () => page.evaluate((wanted) => matchMedia(`(prefers-color-scheme: ${wanted})`).matches, scheme), 5_000);
}

/** What the control center's `openLogin(url)` did: main either opens the address or refuses it (the call rejects). */
async function openLoginResult(page, url) {
  return page.evaluate(async (address) => {
    try {
      await window.nanachiControl.tailscale.openLogin(address);
      return 'opened';
    } catch {
      return 'refused';
    }
  }, url);
}

/** Toasts sit over the bottom-right corner (and over the buttons of the row under them); one under a resting pointer stays. */
async function dismissToasts(page) {
  const close = page.getByRole('button', { name: 'Dispensar aviso' });
  for (let tries = 0; tries < 10 && (await close.count()) > 0; tries += 1) await close.first().click();
}

/** Screenshots of the control center in the current state, light and dark, in the temp folder outside the repository. */
async function shotControl(instance, page, name, { toasts = false } = {}) {
  // A toast from the previous step would sit on top of the next section: dismissed, unless the shot is about it.
  if (!toasts) await dismissToasts(page);
  for (const scheme of ['light', 'dark']) {
    await setTheme(instance, page, scheme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(controlShots, `${name}-${scheme}.png`) });
  }
  await setTheme(instance, page, 'light');
  log(`screenshot ${name} (light, dark)`);
}

const sidebar = (page) => page.locator('nav#sidebar');

async function sectionIsCurrent(page, section) {
  const title = (await page.locator('#page-title').textContent().catch(() => null)) ?? '';
  const current = await sidebar(page).getByRole('button', { name: section.label }).getAttribute('aria-current');
  return title === section.label && current === 'page';
}

/** Opens one section with Ctrl+N or by clicking the sidebar, and waits until it finished loading with no error state. */
async function openSection(page, section, how = 'keyboard') {
  if (how === 'keyboard') await page.keyboard.press(`Control+${SECTIONS.indexOf(section) + 1}`);
  else await sidebar(page).getByRole('button', { name: section.label }).click();
  await until(`${section.label} is the current section`, () => sectionIsCurrent(page, section), 10_000, page);
  await until(
    `${section.label} finished loading`,
    async () => (await page.locator('[aria-busy="true"]').count()) === 0 && (await page.locator('main [role="alert"]').count()) === 0,
    30_000,
    page,
  );
  assertNoControlProblems(section.label);
}

const keyOf = (path) => win32.resolve(path).toLowerCase();

/** `allowedRoots` the running daemon answers with (asked with the phone stand-in's token). */
async function liveRoots() {
  const response = await fetch(`${origin}/api/roots`, { headers: { authorization: `Bearer ${phoneToken}` } });
  assert.equal(response.status, 200, '/api/roots');
  return (await response.json()).roots.map((entry) => entry.path);
}

/** What the stubbed `shell` of the main process was asked to do, in order. */
async function shellCalls(instance) {
  return instance.evaluate(() => globalThis.__e2eShellCalls ?? []);
}

/** The window controls: three buttons, maximize toggles, minimize works, close hides, a second launch shows it again. */
async function checkTitleBar(instance, page) {
  const bar = page.locator('header').first();
  for (const name of ['Minimizar', 'Maximizar', 'Fechar']) await bar.getByRole('button', { name, exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  const window = await instance.browserWindow(page);
  assert.equal(await window.evaluate((w) => w.isMaximized()), false, 'the window starts normal');

  await bar.getByRole('button', { name: 'Maximizar', exact: true }).click();
  await until('the window is maximized', () => window.evaluate((w) => w.isMaximized()), 10_000, page);
  await bar.getByRole('button', { name: 'Restaurar', exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  await bar.getByRole('button', { name: 'Restaurar', exact: true }).click();
  await until('the window is back to normal', async () => !(await window.evaluate((w) => w.isMaximized())), 10_000, page);
  await bar.getByRole('button', { name: 'Maximizar', exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  log('title bar: Minimizar, Maximizar/Restaurar and Fechar are there; maximize toggles the window state');

  await bar.getByRole('button', { name: 'Minimizar', exact: true }).click();
  await until('the window is minimized', () => window.evaluate((w) => w.isMinimized()), 10_000, page);
  await window.evaluate((w) => w.restore());
  await until('the window is restored', async () => !(await window.evaluate((w) => w.isMinimized())) && (await window.evaluate((w) => w.isVisible())), 10_000, page);
  log('title bar: Minimizar minimizes the window');

  // Fechar hides the window: Desktop keeps running (tray). A second launch brings it back (single-instance lock).
  await bar.getByRole('button', { name: 'Fechar', exact: true }).click();
  await until('Fechar hides the window', async () => !(await window.evaluate((w) => w.isVisible())), 10_000, page);
  assert.ok(isAlive(instance.process().pid), 'Fechar must not quit Desktop');
  const second = spawn(electronBinary, [desktopDir], { cwd: repoRoot, env: desktopEnv(), stdio: 'ignore', windowsHide: true });
  if (second.pid !== undefined) pids.add(second.pid);
  await until('a second launch shows the control center again', () => window.evaluate((w) => w.isVisible() && !w.isMinimized()), 20_000, page);
  await until('the second launch exits', () => second.exitCode !== null, 20_000);
  log('Fechar hid the window and a second launch brought it back');
}

/** The folder editor: add a folder through the (stubbed) native picker, save, and check what reached the disk and the daemon. */
async function checkFolderSave(instance, page) {
  const before = await overviewOf(page);
  assert.equal(before.daemon.state, 'running');
  const oldPid = before.daemon.pid;
  assert.ok(Number.isInteger(oldPid));
  assert.deepEqual((await liveRoots()).map(keyOf), [keyOf(home)], 'the daemon starts with the roots of the seeded config.json');

  // The native folder dialog cannot be driven: the main process answers it with the temp folder.
  await instance.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
  }, allowedFolder);

  const rows = page.locator('[data-slot=folder-row]');
  assert.equal(await rows.count(), 1, 'the seeded folder is listed');
  assert.ok(await page.locator('section[aria-label^="Disco "]').count() >= 1, 'at least one drive is listed');
  await page.getByRole('button', { name: 'Adicionar pastas', exact: true }).first().click();
  await until('the picked folder joins the list', async () => (await rows.count()) === 2, 10_000, page);
  const added = rows.filter({ hasText: 'allowed-projects' });
  assert.equal(await added.count(), 1);
  await added.getByText('Nova', { exact: true }).waitFor({ state: 'visible' });
  const bar = page.getByRole('region', { name: 'Alterações não salvas' });
  await bar.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await page.locator('nav#sidebar button[aria-current=page]').getByText('alterações não salvas').count(), 1, 'the sidebar flags the unsaved edit');
  await shotControl(instance, page, '02-folders-unsaved');
  assert.equal((await liveRoots()).length, 1, 'nothing reaches the daemon before "Salvar"');
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configText, 'nothing reaches the disk before "Salvar"');

  await bar.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.getByText('Pastas salvas. O Nanachi reiniciou', { exact: false }).waitFor({ state: 'visible', timeout: 90_000 });
  await bar.waitFor({ state: 'detached', timeout: 10_000 });

  // The config file: only allowedRoots changed, in place, and the format is the daemon's own (2 spaces, final newline, no BOM).
  const savedText = readFileSync(join(home, 'config.json'), 'utf8');
  const saved = JSON.parse(savedText);
  const seeded = JSON.parse(configText);
  assert.deepEqual(Object.keys(saved), Object.keys(seeded), 'the keys of config.json and their order are kept');
  const { allowedRoots: savedRoots, ...otherSaved } = saved;
  const { allowedRoots: seededRoots, ...otherSeeded } = seeded;
  assert.deepEqual(otherSaved, otherSeeded, 'every key but allowedRoots is untouched');
  assert.deepEqual(savedRoots.map(keyOf), [...seededRoots, allowedFolder].map(keyOf));
  assert.equal(savedText, `${JSON.stringify(saved, null, 2)}\n`);
  assert.notDeepEqual([...Buffer.from(savedText).subarray(0, 3)], [0xef, 0xbb, 0xbf], 'config.json has no BOM');
  assert.equal(existsSync(`${join(home, 'config.json')}.${instance.process().pid}.tmp`), false, 'the temp file of the atomic write is gone');
  log(`config.json: allowedRoots = ${JSON.stringify(savedRoots)}; every other key and the key order are as before`);

  // The daemon: restarted (new pid, the old process is gone), running again, and serving the new list.
  const after = await overviewOf(page);
  assert.equal(after.daemon.state, 'running');
  assert.ok(Number.isInteger(after.daemon.pid));
  assert.notEqual(after.daemon.pid, oldPid, 'the daemon was restarted');
  pids.add(after.daemon.pid);
  await until('the old daemon process is gone', () => !isAlive(oldPid), 15_000);
  assert.equal(after.daemon.port, port, 'the restarted daemon keeps the configured port');
  assert.deepEqual((await liveRoots()).map(keyOf), [home, allowedFolder].map(keyOf), '/api/roots reflects the saved list');
  assert.equal(await page.getByText('Salvo, mas ainda não aplicado').count(), 0, 'the restart applied the list: no pending notice');
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.filter({ hasText: 'Nova' }).count(), 0, 'saved folders are no longer "Nova"');
  log(`the daemon restarted (pid ${oldPid} -> ${after.daemon.pid}); /api/roots now lists both folders`);
  return after.daemon.pid;
}

async function checkDevices(instance, page) {
  const rows = page.locator('[data-slot=device-row]');
  assert.ok((await rows.count()) >= 2, 'the list has this app and the phone stand-in');
  const thisApp = rows.filter({ has: page.getByText('Este app', { exact: true }) });
  assert.equal(await thisApp.count(), 1, 'exactly one device is "Este app"');
  assert.match((await thisApp.textContent()) ?? '', /^Nanachi Desktop \(/);
  assert.equal(await thisApp.getByRole('button', { name: /Revogar/ }).count(), 0, 'Este app cannot be revoked from here');
  const phone = rows.filter({ hasText: 'e2e-phone' });
  assert.equal(await phone.count(), 1);
  await phone.getByRole('button', { name: 'Revogar e2e-phone' }).waitFor({ state: 'visible' });
  await page.getByText('Ativo', { exact: true }).first().waitFor({ state: 'visible' });
  await shotControl(instance, page, '03-devices');

  // A new pairing code, through the real `device`/`pair` CLI of the daemon.
  await page.getByRole('button', { name: 'Parear novo aparelho', exact: true }).first().click();
  const pairing = page.locator('section[aria-label="Parear novo aparelho"]');
  await pairing.getByText(/^\d{3} \d{3}$/).waitFor({ state: 'visible', timeout: 30_000 });
  assert.match((await pairing.getByRole('timer').textContent()) ?? '', /^Expira em \d:\d{2}$/);
  await shotControl(instance, page, '03-devices-pairing');
  await pairing.getByRole('button', { name: 'Fechar', exact: true }).click();
  await pairing.waitFor({ state: 'detached', timeout: 5_000 });

  // Revoke the phone stand-in (its token stops working) and keep this app's row.
  await phone.getByRole('button', { name: 'Revogar e2e-phone' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Revogar e2e-phone?' }).waitFor({ state: 'visible', timeout: 5_000 });
  await dialog.getByRole('button', { name: 'Revogar', exact: true }).click();
  await page.getByText('e2e-phone não tem mais acesso.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await rows.filter({ hasText: 'e2e-phone' }).count(), 0, 'the revoked device leaves the list');
  assert.equal(await thisApp.count(), 1);
  const revoked = await fetch(`${origin}/api/roots`, { headers: { authorization: `Bearer ${phoneToken}` } });
  assert.equal(revoked.status, 401, 'the revoked device token no longer works');
  log('devices: "Este app" is listed without a revoke button, a pairing code was issued, e2e-phone was revoked');
}

/** Every section opens (keyboard and sidebar), loads without errors, and says the right things. Folders and devices get their own flows. */
async function checkControlCenter(instance, page) {
  await openSection(page, SECTIONS[0]);
  const overview = await overviewOf(page);
  assert.equal(overview.daemon.mode, 'spawned');
  assert.equal(overview.dataFolder, home);
  assert.notEqual(overview.activity, null, "the daemon answered the activity calls with Desktop's own device token");
  assert.equal(overview.activity.sessions, 0);
  assert.ok(overview.activity.devices >= 2, 'the phone stand-in and Desktop are paired');
  assert.equal(overview.tailscale.state, 'off');
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const wanted of ['Serviços', 'Atividade', home]) assert.ok(text.includes(wanted), `Visão geral shows "${wanted}"`);
  assert.equal(await page.getByRole('button', { name: /^Daemon: Rodando/ }).count(), 1, 'the title bar shows the daemon as running');
  // The activity numbers show up without waiting for a poll (the first load may have happened while the daemon started).
  await page.getByText('Aparelhos pareados', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await page.getByText('Os números de atividade não estão disponíveis agora').count(), 0);
  // Folders, files and addresses are opened by main through `shell`: stubbed here so no Explorer or browser window opens.
  await instance.evaluate(({ shell }) => {
    globalThis.__e2eShellCalls = [];
    shell.openPath = async (target) => {
      globalThis.__e2eShellCalls.push(['openPath', target]);
      return '';
    };
    shell.showItemInFolder = (target) => {
      globalThis.__e2eShellCalls.push(['showItemInFolder', target]);
    };
    shell.openExternal = async (url) => {
      globalThis.__e2eShellCalls.push(['openExternal', url]);
    };
  });
  await page.getByRole('button', { name: 'Abrir pasta', exact: true }).click();
  await until('"Abrir pasta" asks main to open the data folder', async () => (await shellCalls(instance)).some(([kind, target]) => kind === 'openPath' && target === home), 5_000, page);
  await shotControl(instance, page, '01-overview');

  // Folders: Ctrl+2, the editor flow, and the daemon restart.
  await openSection(page, SECTIONS[1]);
  const newDaemonPid = await checkFolderSave(instance, page);
  await shotControl(instance, page, '02-folders', { toasts: true });
  const calls = (await shellCalls(instance)).length;
  // The "saved" toast covers this row's buttons, and the pointer that pressed "Salvar" is resting on it: dismissed first.
  await dismissToasts(page);
  await page.getByRole('button', { name: /^Mostrar .*allowed-projects no Explorer$/ }).click();
  await until('"Mostrar no Explorer" opens the folder', async () => (await shellCalls(instance)).slice(calls).some(([kind, target]) => kind === 'openPath' && keyOf(target) === keyOf(allowedFolder)), 5_000, page);

  // Devices: by clicking the sidebar this time.
  await openSection(page, SECTIONS[2], 'click');
  await checkDevices(instance, page);

  await openSection(page, SECTIONS[3]);
  const accounts = page.locator('[data-slot=account-row]');
  assert.ok((await accounts.count()) >= 1, 'the daemon lists the agents and their principal accounts');
  await shotControl(instance, page, '04-accounts');

  await openSection(page, SECTIONS[4]);
  await page.getByText('Tailscale embutido').first().waitFor({ state: 'visible' });
  await page.getByText('Desligado', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(readRecord(), null, 'opening the Tailscale section does not start a sidecar');
  // "Entrar" opens only the login page Tailscale itself is waiting on, and with the node off none is: main opens nothing,
  // whatever address the page sends.
  assert.equal(await openLoginResult(page, 'https://login.tailscale.com/a/fake-e2e-login'), 'refused', 'no login is pending: nothing to open');
  assert.equal(await openLoginResult(page, 'https://evil.example/a/login'), 'refused', 'an address outside login.tailscale.com is refused');
  assert.deepEqual((await shellCalls(instance)).filter(([kind]) => kind === 'openExternal'), [], 'nothing reached the browser');
  await shotControl(instance, page, '05-tailscale');

  await openSection(page, SECTIONS[5], 'click');
  const logViewer = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  assert.ok(logViewer.includes('[desktop] bandeja criada'), "the daemon tab shows Desktop's own log lines");
  const beforeLogs = (await shellCalls(instance)).length;
  await page.getByRole('button', { name: 'Abrir pasta dos logs', exact: true }).click();
  await until('"Abrir pasta dos logs" opens the data folder', async () => (await shellCalls(instance)).slice(beforeLogs).some(([kind, target]) => kind === 'openPath' && target === home), 5_000, page);
  await shotControl(instance, page, '06-logs');

  await openSection(page, SECTIONS[6]);
  const settings = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const wanted of ['Iniciar com o Windows', 'Versão 0.0.0', 'Verificar atualizações', home, 'Desinstalar']) assert.ok(settings.includes(wanted), `Ajustes shows "${wanted}"`);
  assert.equal(await page.getByRole('switch', { name: 'Iniciar com o Windows' }).isDisabled(), true, 'autostart is only available in an installed app');
  // The anonymous update check (the same GitHub call the PWA's Desktop section makes): any answer will do.
  await page.getByRole('button', { name: 'Verificar atualizações', exact: true }).click();
  await until(
    'the update check answers',
    async () => !(await page.getByText('Procura no GitHub se há uma versão nova do Nanachi.').count()),
    30_000,
    page,
  );
  await shotControl(instance, page, '07-settings');

  // Back to the start; nothing the sections did may have logged an error.
  await openSection(page, SECTIONS[0], 'click');
  assertNoControlProblems('the whole tour');
  log('the seven sections rendered (Ctrl+1..7 and the sidebar) with no console error');
  return newDaemonPid;
}

/** Desktop's own log has nothing from the control center that went wrong. */
function checkDesktopLog() {
  const logText = readFileSync(join(home, 'desktop-daemon.log'), 'utf8');
  const bad = logText.split('\n').filter((line) => /\[desktop\] (centro de controle:|permissão |a janela do Nanachi parou|não foi possível)/.test(line));
  assert.deepEqual(bad, [], 'unexpected control center lines in desktop-daemon.log');
}

/** "Abrir sessões" in the control center: the PWA window loads from the daemon's origin. */
async function openSessionsWindow(instance, control) {
  await sidebar(control).getByRole('button', { name: 'Abrir sessões', exact: true }).click();
  let panel = null;
  await until(
    'the sessions window loads the PWA',
    () => {
      panel = instance.windows().find((window) => window.url().startsWith(`${origin}/`)) ?? null;
      return panel !== null;
    },
    90_000,
    control,
  );
  await panel.waitForLoadState('domcontentloaded');
  return panel;
}

async function daemonPid(page) {
  return page.evaluate(async () => (await window.nanachiDesktop.status()).pid);
}

async function openSettings(page) {
  const settings = page.getByRole('button', { name: 'Ajustes', exact: true });
  await settings.waitFor({ state: 'visible', timeout: 30_000 });
  await settings.click();
  await page.getByRole('heading', { name: 'Desktop', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
}

async function shotBothThemes(page, locator, name) {
  for (const [scheme, label] of [['dark', 'escuro'], ['light', 'claro']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await locator.screenshot({ path: join(shotsDir, `${name}-${label}.png`) });
    log(`screenshot ${name} (${scheme})`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const tailscaleSwitch = (page) => page.locator('[data-slot=desktop-tailscale] [role=switch]');

// ---------- o roteiro ----------

async function run() {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  assert.notEqual(port, 7777, 'a porta 7777 é do supervisor');
  assert.notEqual(port, 7780, "7780 is Desktop's default port; this script uses any other free port");
  setupFolders();
  buildFakeSidecar();
  assert.ok(existsSync(join(desktopDir, 'dist', 'main', 'index.js')), 'compile o Desktop antes: npm run build:desktop -w @nanachi/desktop');
  assert.ok(existsSync(join(desktopDir, 'dist', 'control', 'index.html')), 'compile o Desktop antes: npm run build:desktop -w @nanachi/desktop');
  log(`home ${home}, porta ${port}`);
  log(`control center screenshots go to ${controlShots}`);
  await checkConfigSeeding();

  // O código que uma pessoa estaria digitando no celular enquanto o Desktop se pareia pela primeira vez.
  // `pair --json` derrubaria um código que ainda vale; o Desktop usa `device add`, então ele tem que continuar valendo.
  const typing = spawnSync(process.execPath, [join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js'), 'pair', '--json'], {
    env: { ...process.env, NANACHI_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(typing.status, 0, `pair --json falhou: ${typing.stderr}`);
  const typingCode = JSON.parse(typing.stdout.trim().split('\n').at(-1)).code;

  // ----- 1. first launch: the control center is the main window -----
  app = await launch();
  const control = await controlPage(app);
  log(`control center loaded: ${decodeURI(control.url())}`);
  assert.equal(await control.evaluate(() => typeof window.nanachiControl), 'object', 'the preload exposes window.nanachiControl');
  assert.equal(await control.evaluate(() => typeof window.nanachiDesktop), 'undefined', "the control center never gets the panel's bridge");
  assert.equal(await control.getByText('Abra pelo Nanachi Desktop').count(), 0, 'not the missing-bridge page');
  assert.equal(await control.evaluate(() => window.nanachiControl.version), JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version);
  await until(
    'the daemon shows as running in the title bar',
    async () => (await control.getByRole('button', { name: /^Daemon: Rodando/ }).count()) === 1,
    60_000,
    control,
  );

  const phonePair = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: typingCode, deviceName: 'e2e-phone' }),
  });
  assert.equal(phonePair.status, 200, 'o pareamento do Desktop não pode derrubar um código que ainda vale');
  phoneToken = (await phonePair.json()).token;
  assert.ok(phoneToken.length > 0);
  log('o código que estava valendo antes de o Desktop se parear continua valendo (device add, não pair)');
  checkHomeAfterStart();

  await checkTitleBar(app, control);
  let daemon = await checkControlCenter(app, control);
  pids.add(daemon);
  checkDesktopLog();
  await setTheme(app, control, 'light');
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'system';
  });

  // ----- 2. "Abrir sessões": the PWA window -----
  let page = await openSessionsWindow(app, control);
  log(`painel carregado: ${page.url()}`);
  assert.equal(await daemonPid(page), daemon, 'the sessions window reports the daemon the control center restarted');

  await openSettings(page);
  const section = page.locator('[data-slot=desktop-section]');
  await section.scrollIntoViewIfNeeded();
  await until('o daemon aparecer como rodando', async () => (await page.locator('[data-slot=desktop-daemon]').getAttribute('data-state')) === 'running', 30_000, page);
  for (const text of ['Iniciar com o Windows', 'Gerar código de pareamento', 'Procurar atualização', 'Tailscale embutido']) {
    await section.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 });
  }
  assert.equal(await page.locator('[data-slot=desktop-daemon-title]').textContent(), 'Rodando');
  assert.match((await page.locator('[data-slot=desktop-daemon]').textContent()) ?? '', new RegExp(`Porta ${port}`));
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'false', 'o Tailscale começa desligado');
  assert.equal(readRecord(), null, 'nenhum sidecar deveria ter sido iniciado antes de o usuário ligar');
  await shotBothThemes(page, section, 'desktop-ajustes');

  // ----- 3. versão e atualização (consulta anônima ao GitHub; qualquer resposta serve) -----
  await page.locator('[data-slot=desktop-update]').click();
  await until('o resultado da busca de atualização', async () => {
    const text = (await page.locator('[data-slot=desktop-update-summary]').textContent()) ?? '';
    return text !== 'Procurando…' && /Versão /.test(text);
  }, 20_000, page);
  log(`atualização: ${await page.locator('[data-slot=desktop-update-summary]').textContent()}`);

  // ----- 4. código de pareamento -----
  await page.locator('[data-slot=desktop-pairing]').click();
  const codeValue = page.locator('[data-slot=pairing-code-value]');
  await codeValue.waitFor({ state: 'visible', timeout: 20_000 });
  assert.match((await codeValue.textContent()) ?? '', /^\d{3} \d{3}$/);
  assert.match((await page.locator('[data-slot=pairing-code-countdown]').textContent()) ?? '', /^Expira em \d:\d{2}$/);
  await shotBothThemes(page, page.locator('[data-slot=drawer-content]'), 'desktop-codigo-pareamento');
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await codeValue.waitFor({ state: 'detached', timeout: 5_000 });

  // ----- 5. Tailscale embutido: só o sidecar FALSO -----
  await tailscaleSwitch(page).scrollIntoViewIfNeeded();
  await tailscaleSwitch(page).click();
  const login = page.locator('[data-slot=desktop-tailscale-login]');
  await login.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await login.getAttribute('href'), 'https://login.tailscale.com/a/fake-smoke-login');
  assert.equal(await login.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('[data-slot=desktop-tailscale-status]').getAttribute('data-state'), 'needs_login');
  await shotBothThemes(page, page.locator('[data-slot=desktop-tailscale]').locator('xpath=ancestor::ul[1]'), 'tailscale-needs-login');

  // The control center's "Entrar no Tailscale": the node is waiting for exactly this login page, and only it is opened.
  const waitingLogin = 'https://login.tailscale.com/a/fake-smoke-login';
  const openedBefore = (await shellCalls(app)).filter(([kind]) => kind === 'openExternal').length;
  assert.equal(await openLoginResult(control, 'https://login.tailscale.com/a/another-page'), 'refused', 'another page of the login host is refused');
  assert.equal(await openLoginResult(control, 'https://evil.example/a/login'), 'refused', 'an address outside login.tailscale.com is refused');
  assert.equal(await openLoginResult(control, waitingLogin), 'opened', 'the login the node is waiting for is opened');
  assert.deepEqual(
    (await shellCalls(app)).filter(([kind]) => kind === 'openExternal').slice(openedBefore),
    [['openExternal', waitingLogin]],
    'only the Tailscale login address reached the browser',
  );

  const launched = readRecord();
  assert.ok(launched !== null, 'o sidecar falso deveria ter registrado a chamada');
  pids.add(launched.pid);
  assert.deepEqual(launched.args.filter((_, index) => index % 2 === 0), ['--state-dir', '--hostname', '--target']);
  assert.equal(launched.args[1], join(home, 'tsnet'));
  assert.match(launched.args[3], /^nanachi-[a-z0-9-]+$/);
  assert.equal(launched.args[5], origin);
  assert.equal(launched.env.TS_NO_LOGS_NO_SUPPORT, 'true');
  log(`sidecar falso iniciado com as flags do contrato (--state-dir <home>/tsnet --hostname nanachi-<pc> --target ${origin})`);

  const address = page.locator('[data-slot=desktop-tailscale-address]');
  await address.waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await address.textContent(), 'https://nanachi-smoke.tail-fake.ts.net');
  assert.equal(await page.locator('[data-slot=desktop-tailscale-status]').getAttribute('data-state'), 'running');
  assert.equal(await login.count(), 0, 'o link de login some quando o nó está rodando');
  await page.locator('[data-slot=desktop-tailscale-steps]').getByText('Adicionar à Tela de Início').waitFor({ state: 'visible' });
  await shotBothThemes(page, page.locator('[data-slot=desktop-tailscale]').locator('xpath=ancestor::ul[1]'), 'tailscale-running');
  assert.ok(isAlive(launched.pid), 'o sidecar falso deveria estar vivo com o stdin aberto');
  assert.equal(recordEvents().includes('stdin-eof'), false, 'o stdin do sidecar tem que ficar aberto');

  // The control center follows the same events (main sends them to both windows).
  await openSection(control, SECTIONS[4]);
  await control.getByText('Ligado', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
  await control.getByText('https://nanachi-smoke.tail-fake.ts.net', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  await shotControl(app, control, '05-tailscale-running');
  assertNoControlProblems('Tailscale running');

  // ----- 6. desligar: parada educada (stdin fechado) -----
  await tailscaleSwitch(page).click();
  await until('o sidecar falso terminar após fechar o stdin', () => recordEvents().includes('stdin-eof') && !isAlive(launched.pid), 15_000, page);
  await page.locator('[data-slot=desktop-tailscale-status]').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'false');
  await control.getByText('Desligado', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 });
  log('desligar fechou o stdin e o sidecar falso saiu');

  // ----- 7. sair com o Tailscale ligado: nada fica para trás -----
  await tailscaleSwitch(page).click();
  await page.locator('[data-slot=desktop-tailscale-login]').waitFor({ state: 'visible', timeout: 15_000 });
  const second = readRecord();
  pids.add(second.pid);
  assert.notEqual(second.pid, launched.pid);
  const electronPid = app.process().pid;
  await app.close();
  app = null;
  await until('Electron, daemon e sidecar falso terminarem ao sair', () => !isAlive(electronPid) && !isAlive(daemon) && !isAlive(second.pid), 20_000);
  log('sair derrubou o Electron, o daemon que ele subiu e o sidecar falso');

  // ----- 8. abrir de novo: o Tailscale embutido volta sozinho, e o centro de controle lembra a janela -----
  const startsBefore = recordEvents().filter((event) => event === 'start').length;
  // The first run saved where the control center was (its normal bounds, not maximized); the window comes back there.
  const savedWindow = JSON.parse(readFileSync(join(userData, 'desktop-settings.json'), 'utf8')).controlWindow;
  assert.ok(savedWindow !== undefined && Number.isInteger(savedWindow.width) && Number.isInteger(savedWindow.height), 'desktop-settings.json keeps the control center bounds');
  assert.equal(savedWindow.maximized, false);
  app = await launch();
  const controlAgain = await controlPage(app);
  const reopened = await (await app.browserWindow(controlAgain)).evaluate((w) => w.getBounds());
  assert.deepEqual({ width: reopened.width, height: reopened.height }, { width: savedWindow.width, height: savedWindow.height }, 'the control center reopens at the saved size');
  page = await openSessionsWindow(app, controlAgain);
  await until('o Desktop reiniciar o sidecar falso sozinho', () => recordEvents().filter((event) => event === 'start').length === startsBefore + 1, 30_000, page);
  const third = readRecord();
  pids.add(third.pid);
  daemon = await daemonPid(page);
  pids.add(daemon);
  await openSettings(page);
  await page.locator('[data-slot=desktop-tailscale-status]').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'true', 'tailscaleEnabled foi restaurado');
  log('tailscaleEnabled restaurado: o sidecar falso subiu sozinho');
  // The daemon of the second run still serves the folder list the control center saved in the first one.
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(config.allowedRoots.map(keyOf), [home, allowedFolder].map(keyOf), 'the saved folder list survives a Desktop restart');

  // Deixa o ajuste desligado e fecha.
  await tailscaleSwitch(page).click();
  await until('o sidecar falso terminar', () => !isAlive(third.pid), 15_000, page);
  const finalElectron = app.process().pid;
  const finalDaemon = await daemonPid(page);
  checkDesktopLog();
  await app.close();
  app = null;
  await until('tudo terminar no fim', () => !isAlive(finalElectron) && !isAlive(finalDaemon), 20_000);

  log('OK');
}

let failed = false;
try {
  await run();
} catch (error) {
  failed = true;
  console.error(`[e2edesktop] FALHOU: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (controlProblems.length > 0) console.error(`[e2edesktop] control center problems:\n${controlProblems.join('\n')}`);
  if (existsSync(join(home, 'desktop-daemon.log'))) {
    // Only Desktop's own lines: the daemon's JSON lines carry the machine's real host name.
    const lines = readFileSync(join(home, 'desktop-daemon.log'), 'utf8').split('\n').filter((line) => line.startsWith('[desktop]'));
    console.error(`[e2edesktop] desktop-daemon.log ([desktop] lines, tail):\n${lines.slice(-25).join('\n')}`);
  }
} finally {
  if (app !== null) await app.close().catch(() => undefined);
  for (const pid of pids) if (isAlive(pid)) killTree(pid);
  // A pasta temporária (home, userData, sidecar falso) sai junto. Os screenshots da PWA ficam em e2e/screenshots/desktop
  // e os do centro de controle na pasta temporária impressa abaixo.
  removeTree(root);
  const leftovers = [...pids].filter((pid) => isAlive(pid));
  if (leftovers.length > 0) console.error(`[e2edesktop] processos que sobraram: ${leftovers.join(', ')}`);
  console.log(`[e2edesktop] control center screenshots: ${controlShots}`);
}
process.exit(failed ? 1 : 0);
