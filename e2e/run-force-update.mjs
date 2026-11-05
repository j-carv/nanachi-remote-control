/*
 * E2E for "Forçar atualização" on the machines home: the header button opens a confirmation drawer, and
 * "Atualizar agora" runs the forced update against the built PWA in Edge headless (iPhone 14 viewport, 390x844).
 * Checks: the page reloads through a cache-busting navigation (?v=) and the ?v= is removed afterwards; the
 * machine is still listed (pairing kept in localStorage); the service worker stays registered and in control;
 * the Cache Storage entries seeded before the click are gone, and the precache is filled again with the same
 * number of entries. Screenshots (light and dark) of the button and of the drawer go to
 * e2e/screenshots/redesign/.
 *
 * Run from the repository root, after the supervisor (or a build) has published a PWA release:
 *   npm run e2e:force-update
 *
 * Prerequisites: Node 22+, Microsoft Edge installed, packages/daemon/dist built, port 7832 free. Everything lives in
 * $TEMP/nanachi-e2efu-<rand> and is removed at the end. The daemon started here is stopped at the end.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(here, 'screenshots', 'redesign');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');

const PORT = 7832;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const MACHINE_NAME = 'e2e-forca-atualizacao';
const MARKER_CACHE = 'e2e-force-update-marker';
const log = (line) => console.log(`[e2efu] ${line}`);

const home = join(tmpdir(), `nanachi-e2efu-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let page;
const pageErrors = [];
const documentLoadsWithBust = [];

// ---------- daemon and cleanup ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: MACHINE_NAME,
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {},
  };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function startDaemon() {
  const out = openSync(logPath, 'a');
  daemon = spawn(process.execPath, [daemonMain], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* still starting */
    }
    if (Date.now() > deadline) throw new Error(`daemon did not answer. Log: ${tailLog()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

function tailLog() {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(no log)';
}

function issuePairCode() {
  const output = execFileSync(process.execPath, [daemonCli, 'pair'], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    encoding: 'utf8',
  });
  const match = /(\d{6})/.exec(output);
  if (match === null) throw new Error(`pairing code not found: ${output}`);
  return match[1];
}

// ---------- page helpers ----------

async function shotBothThemes(name) {
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${name}-${colorScheme === 'dark' ? 'dark' : 'light'}.png`) });
    log(`screenshot ${name}-${colorScheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Waits until the service worker controls the page (first load: the SW installs, then claims the page). */
async function waitForController() {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
}

/** Cache Storage as the page sees it: cache names, and the number of entries in the precache. */
function cacheSnapshot() {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const precacheName = names.find((name) => name.startsWith('workbox-precache'));
    if (precacheName === undefined) return { names, precacheName: null, precacheEntries: 0, markerInPrecache: false };
    const precache = await caches.open(precacheName);
    const keys = await precache.keys();
    const markerInPrecache = keys.some((request) => new URL(request.url).pathname === '/e2e-marker.txt');
    return { names, precacheName, precacheEntries: keys.length, markerInPrecache };
  });
}

// ---------- steps ----------

async function pairMachine() {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await page.getByRole('button', { name: 'Parear', exact: true }).click();
  await page
    .getByRole('region', { name: 'Estado da máquina' })
    .getByText('Online', { exact: true })
    .waitFor({ timeout: 30_000 });
  await waitForController();
  log('machine paired, service worker controlling the page');
}

async function stepHomeButtonAndDrawer() {
  const button = page.getByRole('button', { name: 'Forçar atualização do app' });
  await button.waitFor();
  await shotBothThemes('force-update-button');

  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Baixa a versão mais recente do Nanachi e recarrega o app. Seus pareamentos ficam salvos.').waitFor();
  await dialog.getByText(/^Versão: /).waitFor();
  await shotBothThemes('force-update-drawer');

  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await dialog.waitFor({ state: 'detached' });
  log('drawer opened and cancelled');
}

async function stepForcedUpdate() {
  // Seed Cache Storage so the test can see what the update removes: a marker in the precache and an extra cache.
  // The manifest lists some files twice; workbox stores each URL once, so the count is the unique file count.
  const initial = await cacheSnapshot();
  assert.ok(initial.precacheEntries > 0, 'precache filled by the service worker install');

  await page.evaluate(async (markerCache) => {
    const names = await caches.keys();
    const precacheName = names.find((name) => name.startsWith('workbox-precache'));
    if (precacheName === undefined) throw new Error(`no precache cache before the update: ${names.join(', ')}`);
    await (await caches.open(precacheName)).put(new URL('/e2e-marker.txt', location.href), new Response('marker'));
    await (await caches.open(markerCache)).put(new URL('/e2e-marker-cache', location.href), new Response('marker'));
  }, MARKER_CACHE);
  const seeded = await cacheSnapshot();
  assert.equal(seeded.markerInPrecache, true, 'marker seeded in the precache');
  assert.ok(seeded.names.includes(MARKER_CACHE), 'marker cache seeded');

  // Track the reload: the document request carries the cache-busting ?v= parameter.
  const reloaded = page.waitForEvent('load', { timeout: 60_000 });
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Forçar atualização do app' }).click();
  await dialog.getByRole('button', { name: 'Atualizar agora' }).click();
  await reloaded;

  await page.waitForFunction(() => !new URL(location.href).searchParams.has('v'), undefined, { timeout: 15_000 });
  await page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  await waitForController();

  const machines = page.locator('ul[aria-label="Máquinas"]');
  await machines.getByText(MACHINE_NAME, { exact: true }).waitFor({ timeout: 15_000 });
  log('after reload: machine still listed, service worker still controlling');

  const after = await cacheSnapshot();
  assert.equal(after.markerInPrecache, false, 'precache marker removed by the forced update');
  assert.equal(after.names.includes(MARKER_CACHE), false, 'extra cache removed by the forced update');
  assert.equal(after.precacheEntries, initial.precacheEntries, 'precache repopulated with the same number of entries');
  log(`caches: ${after.names.join(', ')} | precache entries ${after.precacheEntries}`);

  assert.ok(documentLoadsWithBust.length > 0, 'the reload navigated with the ?v= cache-busting parameter');
  log(`cache-busting navigations: ${documentLoadsWithBust.length}`);
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  setupHome();
  await startDaemon();
  log(`daemon up at ${baseUrl} (home ${home})`);

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({
    ...devices['iPhone 14'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.isNavigationRequest() && new URL(request.url()).searchParams.has('v')) {
      documentLoadsWithBust.push(request.url());
    }
  });

  await pairMachine();
  await stepHomeButtonAndDrawer();
  await stepForcedUpdate();

  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
  log('forced update flow OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2efu] daemon log (end):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`temporary home removed: ${home}`);
}
process.exitCode = exitCode;
