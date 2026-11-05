/*
 * E2E for the language switch (pt-BR, English and Spanish) in Edge headless (iPhone 14 viewport, 390x844).
 * The app starts in pt-BR (no stored choice). In Settings, the "Idioma / Language" row switches to English: the
 * texts change at once without a reload, <html lang> follows, and the choice is stored under nanachi.language.
 * It checks the main screen, Settings, the devices screen and the pairing screen in English, reloads (the choice
 * persists), and switches back to Portuguese. A shorter pass does the same with Español: Settings, the main screen,
 * the pairing and devices screens, a reload, and the switch back. Screenshots of the main screen and Settings in
 * English and Spanish go to e2e/screenshots/i18n/.
 *
 * Run from the repository root, after the supervisor (or a build) has published a PWA release:
 *   npm run e2e:i18n
 *
 * Prerequisites: Node 22+, Microsoft Edge installed, packages/daemon/dist built, port 7834 free. Everything lives in
 * $TEMP/nanachi-e2ei18n-<rand> and is removed at the end. The daemon started here is stopped at the end.
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
const shotsDir = join(here, 'screenshots', 'i18n');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');

const PORT = 7834;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const MACHINE_NAME = 'e2e-idioma';
const LANGUAGE_KEY = 'nanachi.language';
const log = (line) => console.log(`[e2ei18n] ${line}`);

const home = join(tmpdir(), `nanachi-e2ei18n-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let page;
const pageErrors = [];

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
    await page.screenshot({ path: join(shotsDir, `${name}-${colorScheme}.png`) });
    log(`screenshot ${name}-${colorScheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const htmlLang = () => page.evaluate(() => document.documentElement.lang);
const storedLanguage = () => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_KEY);
const machineStatus = () => page.getByRole('region', { name: /^(Estado da máquina|Machine status|Estado de la máquina)$/ });

/** Picks a language in the Settings row. The screen must be open. */
async function chooseLanguage(code) {
  await page.locator('select[data-slot="language-select"]').selectOption(code);
}

async function expectTexts(locator, texts) {
  for (const text of texts) await locator.getByText(text, { exact: true }).first().waitFor({ timeout: 10_000 });
}

// ---------- steps ----------

async function pairMachine() {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.equal(await htmlLang(), 'pt-BR', 'no stored choice: the app starts in pt-BR');
  assert.equal(await storedLanguage(), null, 'nothing stored before the user chooses');
  await page.getByRole('heading', { name: 'Parear máquina' }).waitFor();
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await page.getByRole('button', { name: 'Parear', exact: true }).click();
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  log('machine paired, home in Portuguese');
}

async function addWorkspaceAndReload() {
  const status = await page.evaluate(
    async ({ path }) => {
      const machines = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]');
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${machines[0].token}` },
        body: JSON.stringify({ path }),
      });
      return response.status;
    },
    { path: projDir },
  );
  assert.equal(status, 201, 'workspace created through the API');
  await page.reload({ waitUntil: 'networkidle' });
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
}

async function stepHomeInPortuguese() {
  const machines = page.locator('ul[aria-label="Máquinas"]');
  await expectTexts(machines, ['1 workspace', 'Nenhuma sessão ainda']);
  await page.getByRole('button', { name: 'Ajustes' }).waitFor();
  await page.getByRole('button', { name: 'Adicionar máquina' }).waitFor();
  await page.getByText('Nenhuma sessão rodando', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remover máquina' }).waitFor();
  log('home in Portuguese');
}

async function stepSwitchToEnglish() {
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('heading', { name: 'Ajustes', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'Idioma / Language' }).waitFor();
  const select = page.locator('select[data-slot="language-select"]');
  assert.equal(await select.inputValue(), 'pt-BR');
  const labels = await select.locator('option').allTextContents();
  assert.deepEqual(labels, ['Português (Brasil)', 'English', 'Español'], 'each option is written in its own language');

  const hadReload = page.evaluate(() => {
    window.__e2eNoReload = true;
  });
  await hadReload;
  await chooseLanguage('en');

  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__e2eNoReload === true), true, 'the switch did not reload the page');
  assert.equal(await htmlLang(), 'en', '<html lang> follows the language');
  assert.equal(await storedLanguage(), 'en', 'the choice is stored on the device');
  assert.equal(await page.locator('select[data-slot="language-select"]').inputValue(), 'en');

  await page.getByRole('heading', { name: 'Devices' }).waitFor();
  await page.getByRole('heading', { name: 'Notifications' }).waitFor();
  await page.getByRole('heading', { name: 'Idioma / Language' }).waitFor();
  await page.getByText("This machine's devices", { exact: true }).waitFor();
  await page.getByText('Language', { exact: true }).waitFor();
  assert.equal(await page.getByText('Dispositivos', { exact: true }).count(), 0, 'no Portuguese left in the headings');
  assert.equal(await page.getByRole('button', { name: 'Voltar' }).count(), 0, 'the back button is no longer "Voltar"');
  await page.getByRole('button', { name: 'Back' }).waitFor();
  // The accounts section above is long: bring the language row into the frame for the screenshot.
  await page.locator('select[data-slot="language-select"]').scrollIntoViewIfNeeded();
  await shotBothThemes('01-settings-en');
  log('settings switched to English without a reload');
}

async function stepDevicesInEnglish() {
  await page.getByRole('button', { name: /This machine's devices/ }).click();
  await page.getByRole('heading', { name: "This machine's devices", level: 1 }).waitFor();
  const list = page.getByRole('list', { name: 'Devices' });
  await list.waitFor({ timeout: 15_000 });
  await list.getByText('this device', { exact: true }).waitFor();
  await list.getByText(/^Created .* · last seen /).waitFor();
  await list.getByRole('button', { name: /^Revoke / }).waitFor();
  await page.screenshot({ path: join(shotsDir, '03-devices-en.png') });
  log('devices screen in English');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
}

async function stepHomeInEnglish() {
  await page.getByRole('button', { name: 'Back' }).click();
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  const machines = page.locator('ul[aria-label="Machines"]');
  await expectTexts(machines, ['1 workspace', 'No sessions yet']);
  await page.getByRole('button', { name: 'Settings' }).waitFor();
  await page.getByRole('button', { name: 'Add machine' }).waitFor();
  await page.getByRole('button', { name: 'Force app update' }).waitFor();
  await page.getByText('No sessions running', { exact: true }).waitFor();
  await page.getByText("Connected to this machine's daemon.", { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove machine' }).waitFor();
  await page.getByRole('button', { name: 'Workspaces' }).waitFor();
  await page.getByRole('region', { name: 'Machines summary' }).waitFor();
  await shotBothThemes('02-main-en');
  log('home in English');
}

async function stepPairingInEnglish() {
  await page.getByRole('button', { name: 'Add machine' }).click();
  await page.getByRole('heading', { name: 'Pair machine' }).waitFor();
  await page.getByText('PC address', { exact: true }).waitFor();
  await page.getByText("This device's name", { exact: true }).waitFor();
  await page.getByText('Code', { exact: true }).waitFor();
  await page.getByText('Generate a 6-digit code on the PC and enter it here. It is valid for 5 minutes.').waitFor();
  await page.getByRole('button', { name: 'Pair', exact: true }).waitFor();
  await page.screenshot({ path: join(shotsDir, '04-pairing-en.png') });

  // A refused pairing explains itself in English too.
  await page.fill('input[placeholder="000000"]', '12');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByRole('alert').getByText('The code has 6 digits.').waitFor();
  log('pairing screen in English');
  await page.getByRole('button', { name: 'Back' }).click();
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
}

async function stepReloadKeepsEnglish() {
  await page.reload({ waitUntil: 'networkidle' });
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await htmlLang(), 'en', 'the choice survives a reload');
  assert.equal(await storedLanguage(), 'en');
  await page.getByRole('button', { name: 'Add machine' }).waitFor();
  await page.getByText('No sessions running', { exact: true }).waitFor();
  log('reload kept English');
}

async function stepSwitchBack() {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  assert.equal(await page.locator('select[data-slot="language-select"]').inputValue(), 'en');
  await chooseLanguage('pt-BR');
  await page.getByRole('heading', { name: 'Ajustes', level: 1 }).waitFor({ timeout: 10_000 });
  assert.equal(await htmlLang(), 'pt-BR');
  assert.equal(await storedLanguage(), 'pt-BR');
  await page.getByRole('heading', { name: 'Notificações' }).waitFor();
  await page.getByText('Idioma', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Voltar' }).click();
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Adicionar máquina' }).waitFor();
  await page.getByText('Nenhuma sessão rodando', { exact: true }).waitFor();
  log('switched back to Portuguese');
}

/**
 * The same language switch with Español, shorter than the English pass: Settings, the main screen, the pairing and
 * devices screens, a reload that keeps the choice, and the way back to Portuguese. Starts and ends on the Portuguese
 * home screen.
 */
async function stepSpanish() {
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('heading', { name: 'Ajustes', level: 1 }).waitFor();
  assert.equal(await page.locator('select[data-slot="language-select"]').inputValue(), 'pt-BR');
  await page.evaluate(() => {
    window.__e2eNoReload = true;
  });
  await chooseLanguage('es');

  await page.getByRole('heading', { name: 'Configuración', level: 1 }).waitFor({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__e2eNoReload === true), true, 'the switch did not reload the page');
  assert.equal(await htmlLang(), 'es', '<html lang> follows the language');
  assert.equal(await storedLanguage(), 'es', 'the choice is stored on the device');
  assert.equal(await page.locator('select[data-slot="language-select"]').inputValue(), 'es');
  await page.getByRole('heading', { name: 'Dispositivos' }).waitFor();
  await page.getByRole('heading', { name: 'Notificaciones' }).waitFor();
  await page.getByRole('heading', { name: 'Idioma / Language' }).waitFor();
  await page.getByText('Dispositivos de esta máquina', { exact: true }).waitFor();
  await page.getByText('Idioma', { exact: true }).waitFor();
  assert.equal(await page.getByText('Notificações', { exact: true }).count(), 0, 'no Portuguese left in the headings');
  assert.equal(await page.getByRole('button', { name: 'Voltar' }).count(), 0, 'the back button is no longer "Voltar"');
  await page.getByRole('button', { name: 'Volver' }).waitFor();
  await page.locator('select[data-slot="language-select"]').scrollIntoViewIfNeeded();
  await shotBothThemes('05-settings-es');
  log('settings switched to Spanish without a reload');

  // Devices.
  await page.getByRole('button', { name: /Dispositivos de esta máquina/ }).click();
  await page.getByRole('heading', { name: 'Dispositivos de esta máquina', level: 1 }).waitFor();
  const list = page.getByRole('list', { name: 'Dispositivos' });
  await list.waitFor({ timeout: 15_000 });
  await list.getByText('este dispositivo', { exact: true }).waitFor();
  await list.getByText(/^Creado .* · visto por última vez /).waitFor();
  await list.getByRole('button', { name: /^Revocar / }).waitFor();
  await page.getByRole('button', { name: 'Volver' }).click();
  await page.getByRole('heading', { name: 'Configuración', level: 1 }).waitFor();

  // Home.
  await page.getByRole('button', { name: 'Volver' }).click();
  await machineStatus().getByText('En línea', { exact: true }).waitFor({ timeout: 30_000 });
  const machines = page.locator('ul[aria-label="Máquinas"]');
  await expectTexts(machines, ['1 workspace', 'Aún no hay sesiones']);
  await page.getByRole('button', { name: 'Configuración' }).waitFor();
  await page.getByRole('button', { name: 'Agregar máquina' }).waitFor();
  await page.getByRole('button', { name: 'Forzar actualización de la app' }).waitFor();
  await page.getByRole('button', { name: 'Quitar máquina' }).waitFor();
  await page.getByRole('button', { name: 'Workspaces' }).waitFor();
  await page.getByText('Ninguna sesión en ejecución', { exact: true }).waitFor();
  await page.getByText('Conectado al daemon de esta máquina.', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Resumen de las máquinas' }).waitFor();
  assert.equal(await page.getByText('Nenhuma sessão rodando', { exact: true }).count(), 0, 'no Portuguese on the home screen');
  await shotBothThemes('06-main-es');
  log('home in Spanish');

  // Pairing, with a refused code.
  await page.getByRole('button', { name: 'Agregar máquina' }).click();
  await page.getByRole('heading', { name: 'Vincular máquina' }).waitFor();
  await page.getByText('Dirección del PC', { exact: true }).waitFor();
  await page.getByText('Nombre de este dispositivo', { exact: true }).waitFor();
  await page.getByText('Código', { exact: true }).waitFor();
  await page.getByText('Genera un código de 6 dígitos en el PC y escríbelo aquí. Es válido por 5 minutos.').waitFor();
  await page.fill('input[placeholder="000000"]', '12');
  await page.getByRole('button', { name: 'Vincular', exact: true }).click();
  await page.getByRole('alert').getByText('El código tiene 6 dígitos.').waitFor();
  await page.screenshot({ path: join(shotsDir, '07-pairing-es.png') });
  log('pairing screen in Spanish');
  await page.getByRole('button', { name: 'Volver' }).click();
  await machineStatus().getByText('En línea', { exact: true }).waitFor({ timeout: 30_000 });

  // The choice survives a reload.
  await page.reload({ waitUntil: 'networkidle' });
  await machineStatus().getByText('En línea', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await htmlLang(), 'es', 'the choice survives a reload');
  assert.equal(await storedLanguage(), 'es');
  await page.getByRole('button', { name: 'Agregar máquina' }).waitFor();
  log('reload kept Spanish');

  // Back to Portuguese, so the steps after this one find the app as they expect.
  await page.getByRole('button', { name: 'Configuración' }).click();
  await page.getByRole('heading', { name: 'Configuración', level: 1 }).waitFor();
  assert.equal(await page.locator('select[data-slot="language-select"]').inputValue(), 'es');
  await chooseLanguage('pt-BR');
  await page.getByRole('heading', { name: 'Ajustes', level: 1 }).waitFor({ timeout: 10_000 });
  assert.equal(await htmlLang(), 'pt-BR');
  assert.equal(await storedLanguage(), 'pt-BR');
  await page.getByRole('button', { name: 'Voltar' }).click();
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Adicionar máquina' }).waitFor();
  await page.getByText('Nenhuma sessão rodando', { exact: true }).waitFor();
  log('switched back to Portuguese from Spanish');
}

// ---------- step: Settings "Agent accounts" and the usage drawer in English (own daemon and context) ----------

/**
 * "Agent accounts" in Settings and the usage drawer with "Saved resets", in English. Self-contained: it starts its own
 * daemon (the accounts launcher, so no real `claude` ever runs) with two fake agents, a Claude Code that has accounts
 * and an omp that answers /usage and /usage reset, and drives it in a second browser context whose stored language is
 * English from the first load. Nothing is spent: the confirmation of a reset is opened and cancelled.
 * Screenshots: e2e/screenshots/i18n/accounts-en.png and usage-en.png.
 */
async function stepAccountsAndUsageInEnglish() {
  const { createServer } = await import('node:net');
  const { pathToFileURL } = await import('node:url');
  const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;
  const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
  const launcher = join(here, 'fixtures', 'accounts-daemon.mjs');
  const fakeCli = join(here, 'fixtures', 'fake-claude-cli.mjs');
  const stepHome = join(tmpdir(), `nanachi-e2ei18n-acc-${randomBytes(4).toString('hex')}`);
  const stepProj = join(stepHome, 'proj');
  const stepPids = join(stepHome, 'pids');
  const principalHome = join(stepHome, 'principal-claude');
  const stepLog = join(stepHome, 'daemon.log');

  const freePort = () =>
    new Promise((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => resolvePort(chosen));
      });
    });

  const stepPort = await freePort();
  const stepUrl = `http://127.0.0.1:${stepPort}`;
  let stepDaemon = null;
  let context = null;
  try {
    mkdirSync(stepProj, { recursive: true });
    mkdirSync(stepPids, { recursive: true });
    mkdirSync(principalHome, { recursive: true });
    // The principal Claude account is logged in (the marker stands for its credential file).
    writeFileSync(join(principalHome, 'e2e-login.json'), JSON.stringify({ email: 'principal@example.test' }));
    const fake = { command: process.execPath, args: ['--import', tsxEsm, fakeAgentTs], kind: 'acp' };
    const config = {
      port: stepPort,
      host: '127.0.0.1',
      machineName: 'e2e-idioma-contas',
      allowedRoots: [stepProj],
      allowedTailscaleLogins: [],
      corsOrigins: [],
      agents: {
        claude: { ...fake, label: 'Claude Code', env: { FAKE_AGENT_PID_DIR: stepPids, CLAUDE_CONFIG_DIR: principalHome } },
        // Id "omp": the daemon picks the reset source by agent id, so the fake plays omp here.
        omp: { ...fake, label: 'Fake', env: { FAKE_AGENT_PID_DIR: stepPids } },
      },
    };
    writeFileSync(join(stepHome, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const out = openSync(stepLog, 'a');
    stepDaemon = spawn(process.execPath, [launcher], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NANACHI_HOME: stepHome,
        CLAUDE_CONFIG_DIR: principalHome,
        E2E_FAKE_CLAUDE_CLI: fakeCli,
        E2E_FAKE_EMAIL: 'trabalho@example.test',
      },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${stepUrl}/api/health`)).ok) break;
      } catch {
        /* still starting */
      }
      if (Date.now() > deadline) {
        throw new Error(`accounts daemon did not answer. Log: ${existsSync(stepLog) ? readFileSync(stepLog, 'utf8').slice(-2000) : '(no log)'}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    const pairOutput = execFileSync(process.execPath, [daemonCli, 'pair'], {
      cwd: repoRoot,
      env: { ...process.env, NANACHI_HOME: stepHome },
      encoding: 'utf8',
    });
    const code = /(\d{6})/.exec(pairOutput)?.[1];
    assert.ok(code !== undefined, `pairing code not found: ${pairOutput}`);

    context = await browser.newContext({
      ...devices['iPhone 14'],
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    // English from the first load, the way a device that already chose it starts.
    await context.addInitScript((key) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, 'en');
      } catch {
        /* storage unavailable: the step fails on the language check below */
      }
    }, LANGUAGE_KEY);
    const p = await context.newPage();
    p.on('pageerror', (error) => pageErrors.push(error.message));
    const shot = (name) => p.screenshot({ path: join(shotsDir, `${name}.png`) });

    await p.goto(stepUrl, { waitUntil: 'networkidle' });
    assert.equal(await p.evaluate(() => document.documentElement.lang), 'en', 'the stored language applies on the first load');
    await p.getByRole('heading', { name: 'Pair machine' }).waitFor();
    await p.fill('input[placeholder="000000"]', code);
    await p.getByRole('button', { name: 'Pair', exact: true }).click();
    const status = p.getByRole('region', { name: 'Machine status' });
    await status.getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });

    // A workspace and one omp session through the API, so the home card lists the session.
    const created = await p.evaluate(async ({ path }) => {
      const machines = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]');
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${machines[0].token}` };
      const workspace = await fetch('/api/workspaces', { method: 'POST', headers, body: JSON.stringify({ path }) });
      const workspaceId = (await workspace.json()).id;
      const session = await fetch('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ workspaceId, agent: 'omp' }) });
      return { workspace: workspace.status, session: session.status };
    }, { path: stepProj });
    assert.equal(created.workspace, 201, 'workspace created through the API');
    assert.equal(created.session, 201, 'omp session created through the API');
    await p.reload({ waitUntil: 'networkidle' });
    await status.getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });

    // ----- Settings: Agent accounts -----
    await p.getByRole('button', { name: 'Settings', exact: true }).click();
    await p.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    const accounts = p.locator('section[aria-labelledby="agent-accounts-title"]');
    await accounts.getByRole('heading', { name: 'Agent accounts' }).waitFor({ timeout: 20_000 });
    const claude = accounts.locator('[data-slot="agent-accounts"][aria-label="Claude Code"]');
    await claude.locator('[data-slot="account-row"]').first().waitFor({ timeout: 20_000 });
    await expectTexts(accounts, ["Each agent's login on e2e-idioma-contas."]);
    await expectTexts(claude, ['Claude Code', 'In use', 'Add account']);
    assert.match((await claude.innerText()).replace(/\s+/g, ' '), /Checked /, 'the check time is in English');
    const principal = claude.locator('[data-slot="account-row"][data-account="default"]');
    assert.match(await principal.innerText(), /principal@example\.test/, 'the e-mail of the principal account');
    assert.equal(await principal.getAttribute('data-active'), 'true');
    const accountsText = await accounts.innerText();
    for (const portuguese of ['Contas dos agentes', 'Em uso', 'Adicionar conta', 'Verificado']) {
      assert.ok(!accountsText.includes(portuguese), `no Portuguese left in the accounts section: ${portuguese}`);
    }
    await claude.scrollIntoViewIfNeeded();
    await shot('accounts-en');

    // The row's actions: the principal is already in use, so "Use for new sessions" is not offered.
    await principal.click();
    const actions = p.getByRole('dialog', { name: 'Account actions' });
    await actions.waitFor();
    await actions.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await actions.getByRole('button', { name: 'Use for new sessions', exact: true }).count(), 0);
    await p.keyboard.press('Escape');
    await actions.waitFor({ state: 'hidden' });

    // "Add account" opens the name sheet in English; cancelling creates nothing.
    await claude.getByRole('button', { name: 'Add account', exact: true }).click();
    const naming = p.getByRole('dialog', { name: 'Add account' });
    await naming.waitFor();
    await expectTexts(naming, ['Name the new Claude Code account. You sign in with it next.', 'Create']);
    await naming.getByRole('button', { name: 'Cancel', exact: true }).click();
    await naming.waitFor({ state: 'hidden' });
    log('settings accounts in English');

    // ----- Usage drawer and Saved resets -----
    await p.getByRole('button', { name: 'Back', exact: true }).click();
    await status.getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
    await p.locator('ul[aria-label="Machines"]').getByRole('button', { name: /^New session/ }).click();
    await p.locator('[data-status="idle"]').first().waitFor({ timeout: 60_000 });
    if ((await p.getByRole('button', { name: 'Agent usage', exact: true }).count()) === 0) {
      await p.getByRole('button', { name: 'More session actions', exact: true }).click();
    }
    await p.getByRole('button', { name: 'Agent usage', exact: true }).click();
    const drawer = p.getByRole('dialog', { name: 'Fake usage' });
    await drawer.waitFor();
    await drawer.getByText('62%').waitFor({ timeout: 30_000 });
    await expectTexts(drawer, ['Limits', '5 hours', '7 days', 'Resets in 2h', 'in use', 'Saved resets']);
    const resets = drawer.getByRole('region', { name: 'Saved resets' });
    const rows = resets.locator('[data-slot="reset-row"]');
    await rows.first().waitFor({ timeout: 30_000 });
    assert.equal(await rows.count(), 2, 'two saved-reset rows');
    const firstRow = (await rows.nth(0).innerText()).replace(/\s+/g, ' ');
    assert.match(firstRow, /2 saved · 1 available now/);
    assert.match(firstRow, /expires in 3 days/, 'the "expires" word is English, the omp text after it is shown as it is');
    assert.match((await rows.nth(1).innerText()).replace(/\s+/g, ' '), /1 saved · 0 available now/);
    await drawer.getByText(/^Updated /).waitFor();
    await drawer.getByRole('button', { name: 'Refresh usage', exact: true }).waitFor();
    const drawerText = await drawer.innerText();
    for (const portuguese of ['Resets salvos', 'Usar reset', 'Renova', 'Atualizado', 'salvos', 'Limites']) {
      assert.ok(!drawerText.includes(portuguese), `no Portuguese left in the usage drawer: ${portuguese}`);
    }
    await shot('usage-en');

    // The confirmation is in English too; cancelling spends nothing.
    await drawer.getByRole('button', { name: 'Use reset for fake@example.com · Org', exact: true }).click();
    const confirm = p.getByRole('dialog', { name: 'Use 1 reset?' });
    await confirm.waitFor();
    await expectTexts(confirm, ["fake@example.com · Org · Anthropic. Spends one saved reset and lifts the limit now. This can't be undone."]);
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    await p.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    log('usage drawer and saved resets in English');
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    if (stepDaemon !== null && stepDaemon.pid !== undefined) killTree(stepDaemon.pid);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    rmSync(stepHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

/**
 * Workspaces, the sessions screen, the branch, new-session, resume and shell sheets, files, editor, changes and the
 * terminal in English. The project folder becomes a small git repository (local only, synthetic identity) so the branch
 * chip, the worktree row and the changes list have something to show; git must be on the PATH. Ends on the home
 * screen with the project's session removed again, so the steps after this one find the home as it was.
 */
async function stepWorkspaceAreaInEnglish() {
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], {
      cwd: projDir,
      stdio: 'ignore',
    });
  mkdirSync(join(projDir, 'src'), { recursive: true });
  writeFileSync(join(projDir, 'README.md'), '# proj\n');
  writeFileSync(join(projDir, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(join(projDir, 'data.txt'), 'x'.repeat(1536));
  writeFileSync(join(projDir, '.gitignore'), '*.log\n');
  git('init', '-b', 'main');
  git('add', '.');
  git('commit', '-m', 'init');
  writeFileSync(join(projDir, 'debug.log'), '0123456789');

  // Workspaces list.
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await page.getByRole('heading', { name: 'Workspaces', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Add workspace', exact: true }).waitFor();
  const workspaceRow = page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' });
  await workspaceRow.getByRole('button', { name: 'Remove proj', exact: true }).waitFor();
  await workspaceRow.getByRole('button').first().click();

  // Sessions screen: buttons, mute row, empty state, branch chip, info bar.
  await page.getByRole('heading', { name: 'proj', level: 1 }).waitFor();
  for (const name of ['New session', 'Resume from PC', 'Terminal', 'Files']) {
    await page.getByRole('button', { name, exact: true }).waitFor();
  }
  await page.getByText('Mute notifications', { exact: true }).waitFor();
  await page.getByText("Your phone won't be notified about this workspace's sessions.", { exact: true }).waitFor();
  await page.getByText('No sessions in this workspace yet.', { exact: true }).waitFor();
  await page.getByRole('list', { name: 'Workspace status' }).getByText('no changes', { exact: true }).waitFor();
  assert.equal(await page.getByText('Nova sessão', { exact: true }).count(), 0, 'no Portuguese on the sessions screen');
  await page.screenshot({ path: join(shotsDir, 'workspace-en.png') });
  log('workspaces and sessions screens in English');

  // Branch sheet (not created: only opened and closed).
  await page.getByRole('button', { name: 'Branch main. Switch branch', exact: true }).click();
  const branchSheet = page.getByRole('dialog', { name: 'Switch branch' });
  await branchSheet.waitFor();
  await branchSheet.getByRole('searchbox', { name: 'Search branches' }).waitFor();
  await branchSheet.getByText('Local branches', { exact: true }).first().waitFor();
  await branchSheet.getByRole('button', { name: 'New branch', exact: true }).click();
  const branchName = branchSheet.getByRole('textbox', { name: 'New branch name' });
  await branchName.waitFor();
  assert.equal(await branchName.getAttribute('placeholder'), 'feature/my-branch');
  await branchSheet.getByRole('button', { name: 'Create', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await branchSheet.waitFor({ state: 'detached' });

  // New session sheet (opened and cancelled: no agent is started).
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const newSession = page.getByRole('dialog', { name: 'New session' });
  await newSession.waitFor();
  await newSession.getByText('Agent', { exact: true }).waitFor();
  await newSession.getByText('In a separate worktree', { exact: true }).waitFor();
  await newSession
    .getByText('Creates a branch and a folder just for this session; your checkout stays untouched.', { exact: true })
    .waitFor();
  await newSession.getByRole('button', { name: 'Create session', exact: true }).waitFor();
  await newSession.getByRole('button', { name: 'Cancel', exact: true }).click();
  await newSession.waitFor({ state: 'detached' });

  // Resume sheet (opened and closed: choosing an agent would start it).
  await page.getByRole('button', { name: 'Resume from PC', exact: true }).click();
  const resume = page.getByRole('dialog', { name: 'Resume from PC' });
  await resume.waitFor();
  await resume.getByText('proj · sessions created in the terminal in this folder', { exact: true }).waitFor();
  await resume.getByRole('button', { name: 'Close', exact: true }).click();
  await resume.waitFor({ state: 'detached' });
  log('branch, new-session and resume sheets in English');

  // Files: toolbar, row details, the name sheet and its validation, the row menu, the delete sheet.
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('heading', { name: 'Files', level: 1 }).waitFor();
  await page.getByRole('navigation', { name: 'Folder path' }).waitFor();
  for (const name of ['Refresh', 'New file', 'New folder']) {
    await page.getByRole('button', { name, exact: true }).waitFor();
  }
  const entries = page.getByRole('list', { name: 'Contents of proj' });
  await entries.getByText('1.5 KB', { exact: true }).waitFor();
  await entries.getByText('Folder', { exact: true }).waitFor();
  await entries.getByText('10 B · ignored by git', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const nameSheet = page.getByRole('dialog', { name: 'New file' });
  await nameSheet.waitFor();
  await nameSheet.getByText('In proj. The file opens in the editor as soon as it is created.', { exact: true }).waitFor();
  await nameSheet.getByLabel('Name', { exact: true }).fill('a/b');
  await nameSheet.getByText('Use a name without slashes.', { exact: true }).waitFor();
  await nameSheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await nameSheet.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'More actions for README.md', exact: true }).click();
  const rowMenu = page.getByRole('dialog', { name: 'More actions for README.md' });
  for (const name of ['Rename', 'Delete', 'Copy path']) {
    await rowMenu.getByRole('button', { name, exact: true }).waitFor();
  }
  await rowMenu.getByRole('button', { name: 'Delete', exact: true }).click();
  const deleteSheet = page.getByRole('dialog', { name: 'Delete README.md?' });
  await deleteSheet.waitFor();
  await deleteSheet.getByText("The file is deleted from your PC. This can't be undone.", { exact: true }).waitFor();
  await deleteSheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await deleteSheet.waitFor({ state: 'detached' });
  log('files screen and its sheets in English');

  // Editor: toolbar, the unsaved mark, the conflict sheet and the discard confirmation.
  await entries.getByRole('button', { name: /README\.md/ }).first().click();
  await page.getByRole('heading', { name: 'README.md', level: 1 }).waitFor();
  await page.getByText('Markdown', { exact: true }).waitFor();
  for (const name of ['Undo', 'Redo', 'Word wrap']) {
    await page.getByRole('button', { name, exact: true }).waitFor();
  }
  const save = page.getByRole('button', { name: 'Save', exact: true });
  assert.equal(await save.isDisabled(), true, 'nothing to save yet');
  await page.getByLabel('Editor for README.md').locator('.cm-content').click();
  await page.keyboard.type('hello');
  await page.getByText('Unsaved', { exact: true }).waitFor();
  writeFileSync(join(projDir, 'README.md'), '# changed on disk\n');
  await save.click();
  const conflict = page.getByRole('dialog', { name: 'The file changed on your PC' });
  await conflict.waitFor();
  await conflict
    .getByText('Another program saved this file after you opened it. Choose what to do with your edits.', { exact: true })
    .waitFor();
  await conflict.getByRole('button', { name: 'Reload from PC (discards your edits)', exact: true }).waitFor();
  await conflict.getByRole('button', { name: 'Overwrite anyway', exact: true }).waitFor();
  await conflict.getByRole('button', { name: 'Cancel', exact: true }).click();
  await conflict.waitFor({ state: 'detached' });
  const asked = new Promise((resolveAsked) => {
    page.once('dialog', async (dialog) => {
      resolveAsked(dialog.message());
      await dialog.accept();
    });
  });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await asked, 'Discard unsaved changes?');
  await page.getByRole('heading', { name: 'Files', level: 1 }).waitFor();
  log('editor in English');

  // Terminal: the shell sheet, the screen, the copy note, the changes list, the closed state.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'proj', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const shellSheet = page.getByRole('dialog', { name: 'Terminal' });
  await shellSheet.waitFor();
  await shellSheet.getByText('Opens a terminal in the proj folder.', { exact: true }).waitFor();
  await shellSheet.getByRole('list', { name: 'Available shells' }).waitFor();
  await shellSheet.getByText("This PC's default", { exact: true }).waitFor();
  await shellSheet.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await page.locator('[data-slot="shell-option"][data-shell="cmd"]').click();
  await page.locator('[data-slot="terminal-view"] .xterm').waitFor();
  const line = page.locator('[data-slot="terminal-line"]');
  await page.waitForFunction(() => document.querySelector('[data-slot="terminal-line"]')?.disabled === false);
  await page.getByRole('toolbar', { name: 'Special keys' }).waitFor();
  for (const name of [
    'Decrease terminal font size',
    'Increase terminal font size',
    'Copy selection',
    'Changes',
    'Up arrow',
    'Paste from the clipboard',
    'Ctrl, the next key becomes a control key',
    'Send',
  ]) {
    await page.getByRole('button', { name, exact: true }).waitFor();
  }
  assert.equal(await line.getAttribute('placeholder'), 'Text for the terminal');
  await page.getByRole('button', { name: 'Copy selection', exact: true }).click();
  await page.getByText('Select some terminal text to copy.', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shotsDir, 'terminal-en.png') });

  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('heading', { name: 'Changes', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).waitFor();
  const changed = page.getByRole('list', { name: 'Changed files' });
  await changed.getByText('Modified', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  await line.waitFor();
  await line.fill('exit');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const closed = page.locator('[data-slot="terminal-closed"]');
  await closed.getByText('Terminal closed (exit code 0)', { exact: true }).waitFor({ timeout: 15_000 });
  await closed.getByRole('button', { name: 'Open new terminal', exact: true }).waitFor();
  assert.equal(await line.getAttribute('placeholder'), 'Terminal closed');
  log('terminal in English');

  // Back on the sessions list: the closed terminal, its row menu, then clean up and return home.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const sessions = page.getByRole('list', { name: 'Sessions' });
  await sessions.getByText('Stopped', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^More actions for / }).click();
  const sessionMenu = page.getByRole('dialog', { name: /^More actions for / });
  await sessionMenu.getByRole('button', { name: 'Remove from app', exact: true }).waitFor();
  await sessionMenu.getByRole('button', { name: 'Cancel', exact: true }).click();
  await sessionMenu.waitFor({ state: 'detached' });

  await page.evaluate(async () => {
    const machine = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]')[0];
    const headers = { authorization: `Bearer ${machine.token}` };
    const { workspaces } = await (await fetch('/api/workspaces', { headers })).json();
    for (const workspace of workspaces) {
      const { sessions: listed } = await (await fetch(`/api/workspaces/${workspace.id}/sessions`, { headers })).json();
      for (const session of listed) await fetch(`/api/sessions/${session.id}?forget=1`, { method: 'DELETE', headers });
    }
  });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('heading', { name: 'Workspaces', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await machineStatus().getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  log('workspace area in English');
}

// ---------- step: the chat in English (own daemon and context) ----------

/**
 * The chat and its sheets in English: header, composer, slash menu, a tool card, the session settings sheet and the
 * Loop sheet. Self-contained: it starts its own daemon with the fake agent announcing commands (the main flow's daemon
 * has no agent) and drives it in a second browser context whose stored language is English from the first load.
 * Agent text (the echo, the tool title, the command descriptions) is data and stays as the agent wrote it.
 * Screenshots: e2e/screenshots/i18n/chat-en.png and chat-loop-en.png.
 */
async function stepChatInEnglish() {
  const { createServer } = await import('node:net');
  const { pathToFileURL } = await import('node:url');
  const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;
  const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
  const stepHome = join(tmpdir(), `nanachi-e2ei18n-chat-${randomBytes(4).toString('hex')}`);
  const stepProj = join(stepHome, 'proj');
  const stepPids = join(stepHome, 'pids');
  const stepLog = join(stepHome, 'daemon.log');

  const freePort = () =>
    new Promise((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => resolvePort(chosen));
      });
    });

  const stepPort = await freePort();
  const stepUrl = `http://127.0.0.1:${stepPort}`;
  let stepDaemon = null;
  let context = null;
  let p = null;
  let finished = false;
  try {
    mkdirSync(stepProj, { recursive: true });
    mkdirSync(stepPids, { recursive: true });
    const config = {
      port: stepPort,
      host: '127.0.0.1',
      machineName: 'e2e-idioma-chat',
      allowedRoots: [stepProj],
      allowedTailscaleLogins: [],
      corsOrigins: [],
      agents: {
        // Id "omp": the daemon maps /usage by agent id, so the fake plays omp here.
        omp: {
          command: process.execPath,
          args: ['--import', tsxEsm, fakeAgentTs],
          kind: 'acp',
          label: 'Fake',
          env: { FAKE_AGENT_PID_DIR: stepPids, FAKE_AGENT_COMMANDS: '1' },
        },
      },
    };
    writeFileSync(join(stepHome, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const out = openSync(stepLog, 'a');
    stepDaemon = spawn(process.execPath, [daemonMain], {
      cwd: repoRoot,
      env: { ...process.env, NANACHI_HOME: stepHome },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${stepUrl}/api/health`)).ok) break;
      } catch {
        /* still starting */
      }
      if (Date.now() > deadline) {
        throw new Error(`chat daemon did not answer. Log: ${existsSync(stepLog) ? readFileSync(stepLog, 'utf8').slice(-2000) : '(no log)'}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    const pairOutput = execFileSync(process.execPath, [daemonCli, 'pair'], {
      cwd: repoRoot,
      env: { ...process.env, NANACHI_HOME: stepHome },
      encoding: 'utf8',
    });
    const code = /(\d{6})/.exec(pairOutput)?.[1];
    assert.ok(code !== undefined, `pairing code not found: ${pairOutput}`);

    context = await browser.newContext({
      ...devices['iPhone 14'],
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    // English from the first load, the way a device that already chose it starts.
    await context.addInitScript((key) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, 'en');
      } catch {
        /* storage unavailable: the step fails on the language check below */
      }
    }, LANGUAGE_KEY);
    p = await context.newPage();
    p.on('pageerror', (error) => pageErrors.push(error.message));
    const shot = (name) => p.screenshot({ path: join(shotsDir, `${name}.png`) });

    await p.goto(stepUrl, { waitUntil: 'networkidle' });
    assert.equal(await p.evaluate(() => document.documentElement.lang), 'en', 'the stored language applies on the first load');
    await p.getByRole('heading', { name: 'Pair machine' }).waitFor();
    await p.fill('input[placeholder="000000"]', code);
    await p.getByRole('button', { name: 'Pair', exact: true }).click();
    const status = p.getByRole('region', { name: 'Machine status' });
    await status.getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });

    // A workspace and one session through the API; the home card lists it and opens it.
    const created = await p.evaluate(async ({ path }) => {
      const machines = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]');
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${machines[0].token}` };
      const workspace = await fetch('/api/workspaces', { method: 'POST', headers, body: JSON.stringify({ path }) });
      const workspaceId = (await workspace.json()).id;
      const session = await fetch('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ workspaceId, agent: 'omp' }) });
      return { workspace: workspace.status, session: session.status };
    }, { path: stepProj });
    assert.equal(created.workspace, 201, 'workspace created through the API');
    assert.equal(created.session, 201, 'session created through the API');
    await p.reload({ waitUntil: 'networkidle' });
    await status.getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
    await p.locator('ul[aria-label="Machines"]').getByRole('button', { name: /^New session/ }).click();
    await p.locator('[data-status="idle"]').first().waitFor({ timeout: 60_000 });

    // ----- Header and composer -----
    await p.getByRole('heading', { name: 'New session', level: 1 }).waitFor();
    for (const name of ['Back', 'Loop mode', 'Session settings', 'More session actions']) {
      await p.getByRole('button', { name, exact: true }).waitFor();
    }
    const composer = p.locator('[data-slot="chat-textarea"]');
    assert.equal(await composer.getAttribute('placeholder'), 'Message');
    await p.getByRole('button', { name: 'Attach file', exact: true }).waitFor();
    await p.getByRole('button', { name: 'Agent commands', exact: true }).waitFor();
    await p.getByRole('button', { name: 'Send', exact: true }).waitFor();
    await p.getByRole('button', { name: 'More session actions', exact: true }).click();
    const moreActions = p.getByRole('dialog', { name: /./ });
    for (const name of ['Agent usage', 'Changes', 'Remove from app']) {
      await moreActions.getByRole('button', { name, exact: true }).waitFor();
    }
    await p.keyboard.press('Escape');
    await moreActions.waitFor({ state: 'detached' });

    // ----- A message, its tool card, the slash menu -----
    await composer.fill('hello');
    await p.getByRole('button', { name: 'Send', exact: true }).click();
    // The echo and the tool title come from the agent and are shown as written (the echo also carries the daemon's
    // Portuguese phone-send note); the badge and the counts are ours.
    await p.getByText(/^Eco: hello/).waitFor({ timeout: 30_000 });
    const card = p.locator('[data-slot="tool-card"]').first();
    await card.getByText('Completed', { exact: true }).waitFor({ timeout: 30_000 });
    await card.locator('[role="img"][aria-label="1 line added, 1 removed"]').waitFor();
    await p.locator('[data-status="idle"]').first().waitFor({ timeout: 30_000 });

    await composer.fill('');
    await composer.pressSequentially('/');
    const slash = p.getByRole('region', { name: 'Agent commands' });
    await slash.waitFor();
    await slash.locator('[data-slot="slash-item"]').first().waitFor();
    await composer.fill('');
    await composer.pressSequentially('/zzz');
    await slash.getByText('No command matches “zzz”.', { exact: true }).waitFor();
    await composer.fill('');
    await slash.waitFor({ state: 'detached' });
    await shot('chat-en');

    // ----- Session settings -----
    await p.getByRole('button', { name: 'Session settings', exact: true }).click();
    const settings = p.getByRole('dialog', { name: 'Session settings' });
    await settings.waitFor();
    await settings.locator('[aria-label="Session options"]').waitFor();
    for (const label of ['Access', 'Model', 'Effort']) {
      await settings.getByText(label, { exact: true }).first().waitFor();
    }
    await settings.getByText('More options', { exact: true }).waitFor();
    await p.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });

    // ----- Loop sheet (opened and closed: nothing is started) -----
    await p.getByRole('button', { name: 'Loop mode', exact: true }).click();
    const loop = p.getByRole('dialog', { name: 'Loop mode' });
    await loop.waitFor();
    await expectTexts(loop, [
      'Repeats a prompt in this session, even with your phone closed.',
      'Prompt',
      'When to run',
      'Fixed interval',
      'Automatic',
      'Interval',
      'Custom interval',
      'Round limit',
      'First round now',
      'How it works',
    ]);
    await loop.getByRole('button', { name: 'Start loop', exact: true }).waitFor();
    await loop.locator('#loop-prompt').fill('review the tests');
    await loop
      .locator('[data-slot="loop-summary"]')
      .getByText('Will send “review the tests” now, then every 5 min, with no round limit.', { exact: true })
      .waitFor();
    await shot('chat-loop-en');
    await p.keyboard.press('Escape');
    await loop.waitFor({ state: 'detached' });

    // None of the chat's Portuguese is left in the header or the composer.
    const chatText = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    for (const portuguese of ['Modo Loop', 'Configurar sessão', 'Anexar arquivo', 'Comandos do agente', 'Enviar']) {
      assert.ok(!chatText.includes(portuguese), `no Portuguese left in the chat: ${portuguese}`);
    }
    finished = true;
    log('chat in English');
  } finally {
    if (!finished && p !== null) await p.screenshot({ path: join(shotsDir, 'chat-fail.png') }).catch(() => undefined);
    if (context !== null) await context.close().catch(() => undefined);
    if (stepDaemon !== null && stepDaemon.pid !== undefined) killTree(stepDaemon.pid);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    rmSync(stepHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
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

  await pairMachine();
  await addWorkspaceAndReload();
  await stepHomeInPortuguese();
  await stepSwitchToEnglish();
  await stepDevicesInEnglish();
  await stepHomeInEnglish();
  await stepPairingInEnglish();
  await stepWorkspaceAreaInEnglish();
  await stepReloadKeepsEnglish();
  await stepSwitchBack();
  await stepSpanish();
  await stepAccountsAndUsageInEnglish();
  await stepChatInEnglish();

  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
  log('language switch flow OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  if (page !== undefined) {
    await page.screenshot({ path: join(shotsDir, 'fail.png') }).catch(() => undefined);
  }
  console.error(`[e2ei18n] daemon log (end):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`temporary home removed: ${home}`);
}
process.exitCode = exitCode;
