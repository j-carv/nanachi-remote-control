/*
 * Smoke do Nanachi Desktop (Electron em desenvolvimento, `electron packages/desktop`): o centro de controle abre ao iniciar e
 * funciona com o processo principal de verdade; a seção "Sessões" do próprio centro de controle (uma vista do Electron sobre a
 * área de conteúdo) carrega a PWA do daemon que o Desktop sobe, a seção "Desktop" aparece em Ajustes da PWA e o cartão
 * "Tailscale embutido" mostra os eventos de um sidecar FALSO (needs_login e depois running); o idioma (pt-BR, English, Español)
 * muda o centro de controle, o menu da bandeja e o idioma da PWA.
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
 *   3. the "Sessões" section (Ctrl+8, the sidebar, the overview's "Abrir sessões" and the tray item) shows the PWA in a view over
 *      the content area: the daemon's origin (free port, not 7777 or 7780, NANACHI_DESKTOP_HOME and userData temporary, empty
 *      allowlist), `view.getBounds()` equal to the content rectangle the page reports (below the 40 px title bar, right of the
 *      64 px icon rail that the sidebar always is on this section, whatever was saved: no toggle, Ctrl+B does nothing, native
 *      titles instead of portal tooltips, the saved choice back when leaving; following the window size, and at the smallest the
 *      window can be the PWA is still in its wide layout), hidden whenever another section is on screen, Ctrl+1..8 also work
 *      from inside the PWA, the PWA never gets `window.nanachiControl`, and the old separate PWA window is gone; config.json
 *      keeps the port this script chose, and a NANACHI_HOME decoy in the environment (the standalone daemon's folder) is never
 *      read or created; a daemon restart reloads the view; a PWA page whose renderer dies is replaced once, a second death
 *      within 30 s is not (the section says so) and opening the section again tries once more; screenshots of the whole window
 *      (light and dark) go to the temp folder;
 *   4. Ajustes (in the PWA) has the "Desktop" group with the daemon running, "Iniciar com o Windows", the pairing code and the version;
 *   5. turning "Tailscale embutido" on starts only the fake sidecar, with the contract flags and TS_NO_LOGS_NO_SUPPORT=true,
 *      and the card shows needs_login (link) and then running (https address); the control center follows the same events;
 *   6. the pairing code shows up in a sheet;
 *   7. turning it off closes the sidecar's stdin (polite stop) and the process goes away;
 *   8. quitting Desktop with Tailscale on takes down the sidecar and the daemon it started;
 *   9. opening again restores "Tailscale embutido" by itself (tailscaleEnabled);
 *  10. languages: the first run takes Desktop's language from the system locale (`--lang`), a stored language wins over it, the
 *      "Idioma" row of Ajustes switches the control center (sidebar, title bar, headings) and the tray menu labels at once,
 *      the PWA in the view gets `nanachi.language` from Desktop on a change, live and without reloading the page (and a later
 *      change made inside the PWA stays), for English and Spanish and back.
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

/** `locale` is what the operating system would say (`--lang`): only the very first run of Desktop reads it. */
async function launch(locale) {
  const instance = await electron.launch({
    executablePath: electronBinary,
    args: [desktopDir, `--lang=${locale}`],
    cwd: repoRoot,
    env: desktopEnv(),
  });
  const pid = instance.process().pid;
  if (pid !== undefined) pids.add(pid);
  watchControlProblems(instance);
  return instance;
}

// ---------- the control center window ----------

/** The sections in sidebar order (Ctrl+1..8), with the title the page shows. */
const SECTIONS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'folders', label: 'Pastas e discos' },
  { id: 'devices', label: 'Aparelhos' },
  { id: 'accounts', label: 'Contas dos agentes' },
  { id: 'tailscale', label: 'Tailscale' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Ajustes' },
  { id: 'sessions', label: 'Sessões' },
];
const SESSIONS = SECTIONS[7];
/** The sidebar on Sessões: always the 64 px icon rail. The expanded sidebar (232 px) is back on every other section. */
const RAIL = 64;
const EXPANDED = 232;

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
/** The sidebar's item of a section. */
const navItem = (page, section) => sidebar(page).locator('ul').getByRole('button', { name: section.label });

async function sectionIsCurrent(page, section) {
  const title = (await page.locator('#page-title').textContent().catch(() => null)) ?? '';
  const current = await navItem(page, section).getAttribute('aria-current');
  return title === section.label && current === 'page';
}

/** Opens one section with Ctrl+N or by clicking the sidebar, and waits until it finished loading with no error state. */
async function openSection(page, section, how = 'keyboard') {
  if (how === 'keyboard') await page.keyboard.press(`Control+${SECTIONS.findIndex((candidate) => candidate.id === section.id) + 1}`);
  else await navItem(page, section).click();
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

/**
 * The control window and its sessions view as the main process sees them: `view.getBounds()` and `view.getVisible()` are what
 * is really on screen (the page only reports where it wants the view).
 */
async function sessionsViewState(instance) {
  return instance.evaluate(({ BrowserWindow }, base) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/control/index.html'));
    if (win === undefined) return null;
    const children = win.contentView.children;
    const view = children.find((child) => child.webContents.getURL().startsWith(base)) ?? null;
    return {
      windows: BrowserWindow.getAllWindows().length,
      children: children.length,
      content: win.getContentBounds(),
      visible: view === null ? null : view.getVisible(),
      bounds: view === null ? null : view.getBounds(),
      url: view === null ? null : view.webContents.getURL(),
    };
  }, origin);
}

/** The content area of the page (`<main>`), in whole pixels, in the order of `view.getBounds()`. */
const contentRect = (page) =>
  page.evaluate(() => {
    const rect = document.querySelector('main#main').getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.right) - Math.round(rect.left), height: Math.round(rect.bottom) - Math.round(rect.top) };
  });

/**
 * The view covers exactly the content area: below the 40 px title bar, right of the sidebar (`sidebarWidth`), down to the
 * window's edges; and the page's own idea of that rectangle is the same one.
 */
async function expectViewGeometry(instance, control, sidebarWidth, why) {
  let last = null;
  await until(
    `${why}: the view covers the content area (x ${sidebarWidth}, y 40, to the window edges)`,
    async () => {
      const state = await sessionsViewState(instance);
      if (state === null || state.bounds === null || state.visible !== true) return false;
      const wanted = { x: sidebarWidth, y: 40, width: state.content.width - sidebarWidth, height: state.content.height - 40 };
      const reported = await contentRect(control);
      last = JSON.stringify({ view: state.bounds, page: reported, wanted });
      return JSON.stringify(state.bounds) === JSON.stringify(wanted) && JSON.stringify(reported) === JSON.stringify(wanted);
    },
    10_000,
    control,
  ).catch((error) => {
    throw new Error(`${error.message}; last seen ${last}`);
  });
}

/** The sessions section (Ctrl+8, or the sidebar): returns the PWA page the view shows, loaded from the daemon's origin. */
async function showSessions(instance, control, how = 'keyboard', section = SESSIONS) {
  await openSection(control, section, how);
  let pwa = null;
  await until(
    'the sessions view loads the PWA',
    () => {
      pwa = instance.windows().find((window) => window.url().startsWith(`${origin}/`)) ?? null;
      return pwa !== null;
    },
    90_000,
    control,
  );
  await pwa.waitForLoadState('domcontentloaded');
  await until('the sessions view is shown', async () => (await sessionsViewState(instance))?.visible === true, 20_000, control);
  return pwa;
}

/**
 * A screenshot of the WHOLE window (the page and the view over it, as the user sees it), light and dark. The PWA page gets the
 * same colour scheme by emulation, like the control center page (the media query does not follow `nativeTheme` here).
 */
async function shotWindow(instance, control, name, pwa) {
  const win = await instance.browserWindow(control);
  const sourceId = await win.evaluate((w) => w.getMediaSourceId());
  for (const scheme of ['light', 'dark']) {
    await setTheme(instance, control, scheme);
    await pwa.emulateMedia({ colorScheme: scheme });
    await control.waitForTimeout(700);
    const png = await instance.evaluate(
      async ({ desktopCapturer }, wanted) => {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: wanted.width, height: wanted.height } });
        const found = sources.find((source) => source.id === wanted.id);
        return found === undefined ? null : found.thumbnail.toPNG().toString('base64');
      },
      { id: sourceId, width: 2000, height: 1300 },
    );
    assert.ok(png !== null, 'the window could be captured');
    writeFileSync(join(controlShots, `${name}-${scheme}.png`), Buffer.from(png, 'base64'));
    log(`screenshot ${name} (${scheme}, whole window)`);
  }
  await setTheme(instance, control, 'light');
  await pwa.emulateMedia({ colorScheme: 'light' });
  await instance.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'system';
  });
}

/** Every `Menu.buildFromTemplate` of the main process is recorded from here on: the tray rebuilds its menu on every change. */
async function installMenuHook(instance) {
  await instance.evaluate(({ Menu }) => {
    globalThis.__e2eMenus = [];
    const original = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      globalThis.__e2eMenus.push(template);
      return original(template);
    };
  });
}

/** The tray menu as it was last built: the label of each item (`separator` for a separator). */
const trayLabels = (instance) => instance.evaluate(() => globalThis.__e2eMenus?.at(-1)?.map((item) => item.label ?? item.type) ?? null);

/** Makes the tray rebuild its menu (the "start with Windows" setter refreshes it even where it is not supported). */
const rebuildTray = (control) => control.evaluate(() => window.nanachiControl.settings.setAutostart(false));

/** The same click the tray would receive: main runs the item's handler. */
const clickTrayItem = (instance, label) =>
  instance.evaluate((_electron, wanted) => {
    const item = globalThis.__e2eMenus.at(-1).find((candidate) => candidate.label === wanted);
    if (item === undefined) throw new Error(`no tray item "${wanted}"`);
    item.click(item, undefined, {});
  }, label);

/**
 * The "Sessões" section: the PWA in a view over the content area of the control center, with the old separate window gone.
 * Returns the PWA page.
 */
async function checkSessionsSection(instance, control) {
  const pwa = await showSessions(instance, control);
  const state = await sessionsViewState(instance);
  assert.equal(state.windows, 1, 'the PWA has no window of its own any more: the app has exactly one BrowserWindow');
  assert.equal(state.children, 1, 'the control window carries exactly one view');
  assert.ok(state.url.startsWith(`${origin}/`), "the view loads the daemon's origin");
  assert.equal(await pwa.evaluate(() => typeof window.nanachiControl), 'undefined', 'the PWA view never gets the control API');
  assert.equal(await pwa.evaluate(() => typeof window.nanachiDesktop), 'object', "the PWA view has the panel's own small bridge");
  await pwa.getByRole('button', { name: 'Ajustes', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  log('Sessões: the PWA rendered inside the control center (one window, one view, no control API in the view)');

  await expectViewGeometry(instance, control, RAIL, 'Sessões open (the sidebar is the rail)');
  log(`view.getBounds() = ${JSON.stringify(state.bounds)}: below the title bar, right of the 64 px rail`);

  // On Sessões the sidebar is the 64 px rail whatever was saved: nothing to toggle, Ctrl+B does nothing, no second "Abrir sessões"
  // button, and the tooltips are native titles (a portal of the page would be painted under the view).
  assert.equal(await control.getByRole('button', { name: 'Recolher a barra lateral' }).count(), 0, 'no collapse button on Sessões');
  assert.equal(await control.getByRole('button', { name: 'Expandir a barra lateral' }).count(), 0, 'no expand button on Sessões');
  assert.equal(await sidebar(control).getByRole('button', { name: 'Abrir sessões', exact: true }).count(), 0, 'the sidebar has no "Abrir sessões" button any more');
  assert.equal(await sidebar(control).locator('ul button[title]').count(), SECTIONS.length, 'every rail item has a native title');
  assert.equal(await sidebar(control).locator('ul button[title]').first().getAttribute('title'), 'Visão geral (Ctrl+1)');
  assert.equal(await control.locator('header button[title]').count(), 3, 'the three window buttons have native titles on Sessões');
  await control.keyboard.press('Control+b');
  await expectViewGeometry(instance, control, RAIL, 'Ctrl+B on Sessões');
  await openSection(control, SECTIONS[0]);
  await until('the saved (expanded) sidebar is back on the Visão geral', async () => (await sidebarWidth(control)) === EXPANDED, 10_000, control);
  assert.equal(await sidebar(control).locator('button[title]').count(), 0, 'no native titles outside Sessões (the portal tooltips are used)');
  await control.getByRole('button', { name: 'Recolher a barra lateral' }).click();
  await until('the sidebar collapsed to the rail on the Visão geral', async () => (await sidebarWidth(control)) === RAIL, 10_000, control);
  await openSection(control, SESSIONS);
  await expectViewGeometry(instance, control, RAIL, 'Sessões with a collapsed choice saved');
  await openSection(control, SECTIONS[0]);
  assert.equal(await sidebarWidth(control), RAIL, 'the collapsed choice is still what is saved');
  await control.getByRole('button', { name: 'Expandir a barra lateral' }).click();
  await until('the sidebar expanded again', async () => (await sidebarWidth(control)) === EXPANDED, 10_000, control);
  await openSection(control, SESSIONS);
  await expectViewGeometry(instance, control, RAIL, 'Sessões again');
  log('on Sessões the sidebar is the rail (no toggle, Ctrl+B ignored, native titles); the saved choice comes back on the other sections');

  // The window is resized: the view follows.
  const original = state.content;
  const resize = (width, height) =>
    instance.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/control/index.html'));
      win.setContentSize(size.width, size.height);
    }, { width, height });
  await resize(1000, 700);
  await expectViewGeometry(instance, control, RAIL, 'window resized to 1000x700');
  // At the smallest size the window can be, the PWA is still in its wide layout (two panes), never the phone's: the view is
  // at least 900 px wide and 500 px tall, so the screen that is open is not remounted by crossing the breakpoint.
  await resize(300, 300);
  await expectViewGeometry(instance, control, RAIL, 'window at its minimum size');
  const smallest = (await sessionsViewState(instance)).bounds;
  assert.ok(smallest.width >= 900 && smallest.height >= 500, `the view at the smallest window is ${smallest.width}x${smallest.height}, under the 900x500 of the wide layout`);
  assert.deepEqual(
    await pwa.evaluate(() => ({ wide: matchMedia('(min-width: 900px) and (min-height: 500px)').matches, shell: document.querySelectorAll('[data-slot="wide-shell"]').length })),
    { wide: true, shell: 1 },
    'the PWA in the smallest window is in its wide layout',
  );
  log(`the smallest window gives the view ${smallest.width}x${smallest.height}: the PWA stays in its wide layout`);
  await resize(original.width, original.height);
  await expectViewGeometry(instance, control, RAIL, 'window back to its size');
  log('the view follows the window size');

  // Another section hides it; coming back shows the same page again.
  await openSection(control, SECTIONS[0]);
  await until('the view is hidden while another section is on screen', async () => (await sessionsViewState(instance)).visible === false, 10_000, control);
  await openSection(control, SESSIONS);
  await expectViewGeometry(instance, control, RAIL, 'back on Sessões');
  assert.equal((await sessionsViewState(instance)).children, 1, 'coming back reuses the same view');
  log('switching away hides the view and Ctrl+8 shows it again');

  // The PWA holds the keyboard while it is on screen: Ctrl+1..8 still work from inside it. The key goes through the view's
  // own input pipeline (`sendInputEvent`, what a real key press does); a synthetic CDP key event skips `before-input-event`.
  await instance.evaluate(({ BrowserWindow }, base) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/control/index.html'));
    const view = win.contentView.children.find((child) => child.webContents.getURL().startsWith(base));
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers: ['control'] });
  }, origin);
  await until('Ctrl+2 pressed inside the PWA selects Pastas e discos', () => sectionIsCurrent(control, SECTIONS[1]), 10_000, control);
  await until('the view is hidden again', async () => (await sessionsViewState(instance)).visible === false, 10_000, control);
  await openSection(control, SESSIONS);
  await expectViewGeometry(instance, control, RAIL, 'after the shortcut round trip');
  log('Ctrl+2 pressed inside the PWA went to the control center');

  // The overview's "Abrir sessões" button goes to the section (Sessões is an item of the list: the sidebar has no second way in).
  await openSection(control, SECTIONS[0]);
  await control.locator('main').getByRole('button', { name: 'Abrir sessões', exact: true }).click();
  await until('the overview "Abrir sessões" goes to Sessões', () => sectionIsCurrent(control, SESSIONS), 10_000, control);
  await expectViewGeometry(instance, control, RAIL, 'overview button');
  log('the overview "Abrir sessões" button navigates to Sessões');

  // The tray item brings the control center (even a hidden one) to Sessões.
  await installMenuHook(instance);
  await rebuildTray(control);
  await until('the tray menu was rebuilt', async () => (await trayLabels(instance)) !== null, 10_000);
  assert.deepEqual(await trayLabels(instance), LANGUAGE_EXPECTATIONS['pt-BR'].tray, 'the tray menu of the first run (pt-BR)');
  await openSection(control, SECTIONS[0]);
  const window = await instance.browserWindow(control);
  await control.getByRole('button', { name: 'Fechar', exact: true }).click();
  await until('Fechar hides the window', async () => !(await window.evaluate((w) => w.isVisible())), 10_000, control);
  await clickTrayItem(instance, 'Abrir sessões');
  await until('the tray item shows the window again', () => window.evaluate((w) => w.isVisible() && !w.isMinimized()), 10_000, control);
  await until('the tray item opens the Sessões section', () => sectionIsCurrent(control, SESSIONS), 10_000, control);
  await expectViewGeometry(instance, control, RAIL, 'tray item');
  log('the tray item "Abrir sessões" opened the hidden control center on Sessões');

  await pwa.getByRole('button', { name: 'Ajustes', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  await control.waitForTimeout(500);
  await shotWindow(instance, control, '08-sessions', pwa);
  assertNoControlProblems('Sessões');
  return pwa;
}

/**
 * A daemon restart while Sessões is open: the page shows its own "starting" state instead of the PWA (the view is hidden),
 * and the view loads the PWA again when the daemon is back. Returns the new daemon pid.
 */
async function checkRestartReloadsView(instance, control, pwa) {
  const before = await overviewOf(control);
  const oldPid = before.daemon.pid;
  const bornAt = await pwa.evaluate(() => performance.timeOrigin);
  const restart = control.evaluate(() => window.nanachiControl.restartDaemon());
  await control.locator('[data-slot=sessions-unavailable]').waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal((await sessionsViewState(instance)).visible, false, 'while the daemon is not ready the section shows its own state, not the PWA');
  await shotControl(instance, control, '08-sessions-daemon-starting');
  const restarted = await restart;
  assert.equal(restarted.ok, true, `restartDaemon failed: ${JSON.stringify(restarted)}`);
  const newPid = restarted.value.pid;
  assert.ok(Number.isInteger(newPid) && newPid !== oldPid, 'the daemon was restarted');
  pids.add(newPid);
  await until('the old daemon process is gone', () => !isAlive(oldPid), 15_000);
  await until('the PWA view loads again after the restart', async () => (await pwa.evaluate(() => performance.timeOrigin).catch(() => bornAt)) !== bornAt, 60_000, control);
  await until('the view is shown again', async () => (await sessionsViewState(instance)).visible === true, 20_000, control);
  await expectViewGeometry(instance, control, RAIL, 'after the restart');
  await pwa.getByRole('button', { name: 'Ajustes', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await daemonPid(pwa), newPid, 'the reloaded PWA talks to the new daemon');
  log(`the daemon restarted under Sessões (pid ${oldPid} -> ${newPid}): the section showed its own state, then the PWA loaded again`);
  return newPid;
}

/**
 * A PWA page whose renderer keeps dying. The first death is replaced at once by a fresh view that shows the PWA; a second death
 * within 30 s is not replaced: the view is gone, the section says why, and opening the section again tries once more.
 * Returns the PWA page of the view that came back.
 */
async function checkSessionsCrashRecovery(instance, control, pwa) {
  const crash = () =>
    instance.evaluate(({ BrowserWindow }, base) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/control/index.html'));
      const view = win.contentView.children.find((child) => child.webContents.getURL().startsWith(base));
      view.webContents.forcefullyCrashRenderer();
    }, origin);
  const freshPage = async (older, why) => {
    let found = null;
    await until(
      why,
      async () => {
        found = instance.windows().find((window) => window.url().startsWith(`${origin}/`) && !window.isClosed() && window !== older) ?? null;
        return found !== null && (await sessionsViewState(instance))?.visible === true;
      },
      90_000,
      control,
    );
    await found.waitForLoadState('domcontentloaded');
    await found.getByRole('button', { name: 'Ajustes', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    return found;
  };

  await openSection(control, SESSIONS);
  await crash();
  const second = await freshPage(pwa, 'the first death is replaced by a new view that shows the PWA');
  await expectViewGeometry(instance, control, RAIL, 'after the first death');
  log('the first death of the PWA page was replaced by a fresh view');

  await crash();
  await control.locator('[data-slot=sessions-unavailable][data-state=crashed]').waitFor({ state: 'visible', timeout: 30_000 });
  const gone = await sessionsViewState(instance);
  assert.equal(gone.children, 0, 'the second death within 30 s is not replaced: the control window carries no view');
  assert.match((await control.locator('[data-slot=sessions-unavailable]').textContent()) ?? '', /As sessões pararam de funcionar/);
  await shotControl(instance, control, '08-sessions-crashed');
  log('the second death within 30 s was not replaced: the section says the sessions stopped working');

  await openSection(control, SECTIONS[0]);
  await openSection(control, SESSIONS);
  const third = await freshPage(second, 'opening the section again brings the PWA back');
  await expectViewGeometry(instance, control, RAIL, 'after the section was opened again');
  assert.equal(await control.locator('[data-slot=sessions-unavailable]').count(), 0, 'the explanation is gone with the view back');
  log('opening Sessões again tried once more, and the PWA is back');
  return third;
}

const LANGUAGE_RADIO = { 'pt-BR': 'Português (Brasil)', en: 'English', es: 'Español' };
const LANGUAGE_EXPECTATIONS = {
  'pt-BR': {
    settings: 'Ajustes',
    sections: ['Visão geral', 'Pastas e discos', 'Aparelhos', 'Contas dos agentes', 'Tailscale', 'Logs', 'Ajustes', 'Sessões'],
    minimize: 'Minimizar',
    tray: ['Nanachi · rodando', 'separator', 'Abrir Nanachi', 'Abrir sessões', 'Gerar código de pareamento', 'Iniciar com o Windows', 'separator', 'Sair'],
  },
  en: {
    settings: 'Settings',
    sections: ['Overview', 'Folders and drives', 'Devices', 'Agent accounts', 'Tailscale', 'Logs', 'Settings', 'Sessions'],
    minimize: 'Minimize',
    tray: ['Nanachi · running', 'separator', 'Open Nanachi', 'Open sessions', 'Generate pairing code', 'Start with Windows', 'separator', 'Quit'],
  },
  es: {
    settings: 'Ajustes',
    sections: ['Resumen', 'Carpetas y discos', 'Dispositivos', 'Cuentas de los agentes', 'Tailscale', 'Registros', 'Ajustes', 'Sesiones'],
    minimize: 'Minimizar',
    tray: ['Nanachi · en ejecución', 'separator', 'Abrir Nanachi', 'Abrir sesiones', 'Generar código de emparejamiento', 'Iniciar con Windows', 'separator', 'Salir'],
  },
};

/** The Sessões section as the sidebar names it in a language. */
const sessionsIn = (code) => ({ ...SESSIONS, label: LANGUAGE_EXPECTATIONS[code].sections[7] });

const storedLanguage = () => JSON.parse(readFileSync(join(userData, 'desktop-settings.json'), 'utf8')).language;

/** The width of the sidebar, in whole pixels (it animates for 150 ms when it changes). */
const sidebarWidth = (page) => sidebar(page).evaluate((element) => Math.round(element.getBoundingClientRect().width));

/** The "Idioma" row of Ajustes: the control center, the tray menu and the stored setting follow at once. */
async function switchLanguage(instance, control, code) {
  const expected = LANGUAGE_EXPECTATIONS[code];
  await control.keyboard.press('Control+7');
  const radio = control.getByRole('radio', { name: LANGUAGE_RADIO[code], exact: true });
  await radio.waitFor({ state: 'visible', timeout: 10_000 });
  await radio.click();
  await until(`the control center speaks ${code}`, async () => (await control.evaluate(() => document.documentElement.lang)) === code && (await control.locator('#page-title').textContent()) === expected.settings, 10_000, control);
  assert.deepEqual(await sidebar(control).locator('ul li button span.truncate').allTextContents(), expected.sections, `the sidebar in ${code}`);
  await control.locator('header').first().getByRole('button', { name: expected.minimize, exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await control.getByRole('radio', { name: LANGUAGE_RADIO[code], exact: true }).getAttribute('aria-checked'), 'true');
  await until(`the tray menu speaks ${code}`, async () => JSON.stringify(await trayLabels(instance)) === JSON.stringify(expected.tray), 10_000);
  await until(`${code} is stored`, async () => storedLanguage() === code, 5_000);
  assertNoControlProblems(`language ${code}`);
  log(`language ${code}: sidebar, title bar, headings and tray menu changed; desktop-settings.json says ${code}`);
}

/** What the PWA in the view says about its language (the key Desktop writes, and the document language). */
async function pwaLanguage(pwa) {
  return pwa.evaluate(() => ({ stored: localStorage.getItem('nanachi.language'), lang: document.documentElement.lang })).catch(() => null);
}

async function expectPwaLanguage(pwa, code, why) {
  let last = null;
  await until(
    `${why}: the PWA has nanachi.language = ${code}`,
    async () => {
      last = await pwaLanguage(pwa);
      return last !== null && last.stored === code && last.lang === code;
    },
    30_000,
  ).catch((error) => {
    throw new Error(`${error.message}; last seen ${JSON.stringify(last)}`);
  });
}

/** pt-BR -> English -> Spanish -> pt-BR, with the PWA following Desktop on each change, and a change made inside the PWA staying there. */
async function checkLanguages(instance, control) {
  assert.equal(storedLanguage(), 'pt-BR');
  await installMenuHook(instance);
  await rebuildTray(control);
  await until('the tray menu was rebuilt', async () => (await trayLabels(instance)) !== null, 10_000);
  assert.deepEqual(await trayLabels(instance), LANGUAGE_EXPECTATIONS['pt-BR'].tray);

  let pwa = await showSessions(instance, control);
  const bornAt = await pwa.evaluate(() => performance.timeOrigin);
  await switchLanguage(instance, control, 'en');
  await shotControl(instance, control, '09-settings-english');
  pwa = await showSessions(instance, control, 'keyboard', sessionsIn('en'));
  await expectPwaLanguage(pwa, 'en', 'after Desktop switched to English');
  assert.equal(storedLanguage(), 'en');
  assert.equal(await pwa.evaluate(() => performance.timeOrigin), bornAt, 'a language change in Desktop switches the PWA live: the page is not reloaded');

  // A language chosen inside the PWA stays in the PWA: Desktop writes again only when ITS language changes.
  await pwa.evaluate(() => localStorage.setItem('nanachi.language', 'pt-BR'));
  await pwa.reload();
  await expectPwaLanguage(pwa, 'pt-BR', 'after the user chose pt-BR inside the PWA and the page reloaded');
  assert.equal(storedLanguage(), 'en', "the PWA's own choice does not change Desktop's language");
  assert.equal(await control.evaluate(() => document.documentElement.lang), 'en');
  log("a language chosen inside the PWA survived a reload, and Desktop's stayed English");

  await switchLanguage(instance, control, 'es');
  await shotControl(instance, control, '09-settings-spanish');
  pwa = await showSessions(instance, control, 'keyboard', sessionsIn('es'));
  await expectPwaLanguage(pwa, 'es', 'after Desktop switched to Spanish');
  await shotWindow(instance, control, '09-sessions-spanish', pwa);

  await switchLanguage(instance, control, 'pt-BR');
  pwa = await showSessions(instance, control, 'keyboard', sessionsIn('pt-BR'));
  await expectPwaLanguage(pwa, 'pt-BR', 'after Desktop switched back to pt-BR');
  log('the PWA in the view got nanachi.language from Desktop on every change (English, Spanish, pt-BR)');
  return pwa;
}

async function daemonPid(page) {
  return page.evaluate(async () => (await window.nanachiDesktop.status()).pid);
}

async function openSettings(page) {
  const settings = page.getByRole('button', { name: 'Ajustes', exact: true }).first();
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
  // `--lang=pt-BR` is the operating system's locale for the very first run: Desktop takes its language from it and saves it.
  app = await launch('pt-BR');
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
  assert.equal(storedLanguage(), 'pt-BR', "the first run saved the language the system locale suggests");

  await checkTitleBar(app, control);
  let daemon = await checkControlCenter(app, control);
  pids.add(daemon);
  checkDesktopLog();
  await setTheme(app, control, 'light');
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'system';
  });

  // ----- 2. "Sessões": the PWA in a view of the control center -----
  let page = await checkSessionsSection(app, control);
  log(`PWA na vista: ${page.url()}`);
  assert.equal(await daemonPid(page), daemon, 'the PWA in the view reports the daemon the control center restarted');
  daemon = await checkRestartReloadsView(app, control, page);
  page = await showSessions(app, control);
  page = await checkSessionsCrashRecovery(app, control, page);

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
  // The PWA is only drawn (and clickable) while Sessões is on screen.
  page = await showSessions(app, control);

  // ----- 6. desligar: parada educada (stdin fechado) -----
  await tailscaleSwitch(page).click();
  await until('o sidecar falso terminar após fechar o stdin', () => recordEvents().includes('stdin-eof') && !isAlive(launched.pid), 15_000, page);
  await page.locator('[data-slot=desktop-tailscale-status]').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'false');
  await openSection(control, SECTIONS[4]);
  await control.getByText('Desligado', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 });
  page = await showSessions(app, control);
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
  // The system locale is English this time, but the language Desktop saved (pt-BR) wins: only the first run reads the locale.
  app = await launch('en-US');
  const controlAgain = await controlPage(app);
  assert.equal(storedLanguage(), 'pt-BR');
  log('a stored language wins over the system locale (--lang=en-US, the control center is still in pt-BR)');
  const reopened = await (await app.browserWindow(controlAgain)).evaluate((w) => w.getBounds());
  assert.deepEqual({ width: reopened.width, height: reopened.height }, { width: savedWindow.width, height: savedWindow.height }, 'the control center reopens at the saved size');
  page = await showSessions(app, controlAgain);
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

  // ----- 10. idiomas -----
  await checkLanguages(app, controlAgain);
  checkDesktopLog();

  // Deixa o ajuste desligado e fecha. (A PWA recarregou a cada troca de idioma: abre Ajustes de novo.)
  await openSettings(page);
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
