/*
 * E2E for the chat's Loop mode (PLAN.md, "Extra (05/11) — modo Loop"). Starts its own daemon on port 7806 with a temp
 * home, pairs the phone-sized browser (iPhone 14 emulation, 390x844), and drives the built PWA with the fake agent.
 *
 * Checks: the header button opens the "Modo Loop" sheet; an interval loop of 30 s with "Rodar agora" shows "Loop #1"
 * and the header chip counts down (the schedule is asserted through the countdown text, not by waiting a full
 * interval); "Rodar agora" gives "Loop #2"; pause and resume; `/loop 30s eco teste` typed in the composer creates the
 * loop directly; "Parar loop" with its confirmation removes the chip. Then a dynamic loop ("Automático") whose prompt
 * is `LOOP-NEXT=45s`: the fake agent ends its reply with `[[nanachi-loop-next: 45s]]`, and the chat must hide that
 * marker and the loop instruction, showing the muted "Próxima rodada em 45 s" note. Screenshots at 390x844 in both
 * themes go to e2e/screenshots/loop/.
 *
 * Run from the repo root, after the supervisor has built the daemon and the PWA:
 *   npm run e2e:loop
 *
 * Prerequisites: Node 22+, Microsoft Edge installed (set E2E_BROWSER_CHANNEL to change it), port 7806 free. Everything
 * lives in $TEMP/nanachi-e2eloop-<rand> and is removed at the end.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(here, 'screenshots', 'loop');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7806;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2eloop] ${line}`);

const home = join(tmpdir(), `nanachi-e2eloop-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let page;
const consoleErrors = [];

// ---------- daemon process and cleanup (only the process this script started) ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  // A git repo with one commit: the workspace's branch list answers 200 (a plain folder answers 400 and the console logs it).
  execFileSync('git', ['init', '-q'], { cwd: projDir });
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: projDir,
  });
  const fake = {
    command: process.execPath,
    args: ['--import', tsxEsm, fakeAgentTs],
    kind: 'acp',
  };
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-loop',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      // Id "claude": the sheet offers "Usar /loop nativo do Claude" only for this agent id.
      claude: {
        ...fake,
        label: 'Fake Claude',
        env: { FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_COMMANDS: '1' },
      },
    },
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

async function shotIn(theme, name) {
  mkdirSync(shotsDir, { recursive: true });
  // Let the drawer's open animation finish, so the sheet is not captured half-way up.
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shotsDir, `${name}-${theme}.png`) });
  log(`screenshot ${name}-${theme}`);
}

/** Header block (title, buttons, then the place line and chips), for the chip shots. */
async function headerShotIn(theme, name) {
  mkdirSync(shotsDir, { recursive: true });
  await page.locator('header').first().locator('xpath=..').screenshot({ path: join(shotsDir, `${name}-${theme}.png`) });
  log(`screenshot ${name}-${theme}`);
}

async function setTheme(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
}

async function until(description, check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      await page.screenshot({ path: join(shotsDir, `fail-${description.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
      throw new Error(`timed out waiting for: ${description}`);
    }
    await page.waitForTimeout(150);
  }
}

const button = (name) => page.getByRole('button', { name, exact: true });
const headerTitle = (text) => page.locator('h1', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`[data-status="${status}"]`));
const composer = () => page.locator('[data-slot="chat-textarea"]');
const loopChip = () => page.locator('[data-slot="loop-chip"]');
const loopSheet = () => page.getByRole('dialog', { name: 'Modo Loop' });
const loopLabel = (text) => page.locator('[data-slot="loop-label"]', { hasText: text });
const loopNotice = (text) => page.locator('[data-slot="loop-notice"]', { hasText: text });
const loopNote = (text) => page.locator('[data-slot="loop-note"]', { hasText: text });

async function goToWorkspaces() {
  for (let step = 0; step < 6; step += 1) {
    if (await hasCount(headerTitle('Workspaces'))) return;
    if (await hasCount(page.getByRole('button', { name: 'Voltar', exact: true }))) {
      await button('Voltar').click();
    } else if (await hasCount(page.getByRole('button', { name: 'Workspaces', exact: true }))) {
      await button('Workspaces').click();
    } else {
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(150);
  }
  await headerTitle('Workspaces').waitFor({ timeout: 10_000 });
}

async function openProjSessions() {
  await goToWorkspaces();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Nova sessão', exact: true }).waitFor();
}

async function newSession(agentLabel) {
  await openProjSessions();
  await button('Nova sessão').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await page.locator('[role="dialog"] button[aria-pressed]', { hasText: agentLabel }).click();
  await button('Criar sessão').click();
}

async function pairAndWorkspace() {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport must be 390x844');
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await button('Parear').click();
  await until('machine online on home', () =>
    hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })),
  );

  await button('Workspaces').click();
  await headerTitle('Workspaces').waitFor();
  await button('Adicionar workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('ul[aria-label="Pastas"] > li button', { hasText: 'proj' }).click();
  await page.locator('h1 + p', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().waitFor();
}

async function openLoopFromHeader() {
  await button('Modo Loop').click();
  await loopSheet().waitFor();
}

async function closeSheet() {
  await page.keyboard.press('Escape');
  await loopSheet().waitFor({ state: 'hidden', timeout: 10_000 });
}

/** The chip's phase, read from its data attribute (see LoopChip.tsx). */
const chipPhase = () => loopChip().getAttribute('data-phase');

// ---------- flow ----------

async function stepSheetEmpty() {
  await newSession('Fake Claude');
  await until('fake session idle', () => statusIs('idle'), 60_000);
  assert.equal(await loopChip().count(), 0, 'no chip without a loop');

  await openLoopFromHeader();
  await until('empty sheet has the form', () => hasCount(page.locator('#loop-prompt')));
  assert.ok(await hasCount(page.getByRole('radio', { name: 'Intervalo fixo', checked: true })), 'fixed interval is the default');
  assert.ok(
    await hasCount(page.getByRole('button', { name: 'Usar /loop nativo do Claude', exact: true })),
    'Claude sessions offer the native /loop button',
  );
  assert.equal(await page.getByText('Loop atual', { exact: true }).count(), 0, 'no status block without a loop');
  await shotIn('light', 'sheet-novo');
  await setTheme('dark');
  await shotIn('dark', 'sheet-novo');
  await setTheme('light');

  // Automatic mode: its own helper text and summary, then the same two themes. The lower part of the sheet (summary,
  // options, "Como funciona" opened) gets its own shots, since the top shot does not reach it.
  await page.locator('#loop-prompt').fill('revise os testes');
  await page.getByRole('radio', { name: 'Automático', exact: true }).click();
  assert.ok(await hasCount(page.getByText('Se desligado, começa em 10 min.')), 'automatic mode: first round helper text');
  assert.equal(
    await page.locator('[data-slot="loop-summary"]').innerText(),
    'Vai mandar “revise os testes” agora; depois o agente decide quando repetir, até ele dizer que terminou.',
    'automatic mode: live summary',
  );
  await shotIn('light', 'sheet-novo-automatico');
  await setTheme('dark');
  await shotIn('dark', 'sheet-novo-automatico');
  await page.getByText('Como funciona', { exact: true }).click();
  await page.locator('[data-slot="loop-howto"]').scrollIntoViewIfNeeded();
  await shotIn('dark', 'sheet-novo-automatico-rodape');
  await setTheme('light');
  await shotIn('light', 'sheet-novo-automatico-rodape');
  await closeSheet();
}

async function stepStartLoop() {
  await openLoopFromHeader();
  await page.locator('#loop-prompt').fill('revise os testes');
  await page.locator('#loop-interval').fill('30s');
  assert.ok(await hasCount(page.getByText('Roda a cada 30 s, contando do fim de cada rodada.')), 'interval hint shows 30 s');
  assert.equal(
    await page.locator('[data-slot="loop-summary"]').innerText(),
    'Vai mandar “revise os testes” agora e depois a cada 30 s, sem limite de rodadas.',
    'live summary describes the loop before saving',
  );
  await button('Iniciar loop').click();

  await loopNotice('Loop iniciado').waitFor({ timeout: 10_000 });
  await loopLabel('Loop #1').waitFor({ timeout: 20_000 });
  await until('chip counts down to the next round', async () => (await chipPhase()) === 'countdown', 20_000);
  const chipText = await loopChip().innerText();
  assert.match(chipText, /Loop · próxima em \d+ s/, `chip shows the countdown, got "${chipText}"`);
  // A finished round leaves the chip on its countdown; the header status can still read idle just before a round starts.
  await until('round 1 finished', async () => (await chipPhase()) === 'countdown', 20_000);
  await headerShotIn('light', 'cabecalho-chip');

  // 320 px (the narrowest supported phone): nothing overflows, the chip falls back to its short label.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => {
    const chip = document.querySelector('[data-slot="loop-chip"]');
    const modo = document.querySelector('button[aria-label="Modo Loop"]');
    if (chip === null || modo === null) return null;
    return {
      pageWidth: document.documentElement.scrollWidth,
      chipRight: chip.getBoundingClientRect().right,
      modoRight: modo.getBoundingClientRect().right,
      chipText: chip.innerText,
    };
  });
  assert.notEqual(narrow, null, 'chip and header button are present at 320 px');
  assert.ok(narrow.pageWidth <= 320, `no horizontal page scroll at 320 px (got ${narrow.pageWidth})`);
  assert.ok(narrow.chipRight <= 320 && narrow.modoRight <= 320, 'chip and header button stay inside 320 px');
  assert.match(narrow.chipText, /^Loop · \d+ s$/, `short chip label at 320 px, got "${narrow.chipText}"`);
  await headerShotIn('light', 'cabecalho-320');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await setTheme('dark');
  await headerShotIn('dark', 'cabecalho-chip');
  await setTheme('light');
  await page.locator('[data-slot="chat-timeline"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await shotIn('light', 'timeline-loop');
  await setTheme('dark');
  await shotIn('dark', 'timeline-loop');
  await setTheme('light');
}

async function stepActiveSheetAndRunNow() {
  await loopChip().click();
  await loopSheet().waitFor();
  assert.ok(await hasCount(page.getByText('Loop atual', { exact: true })), 'status block shows the active loop');
  assert.ok(await hasCount(page.locator('[data-slot="loop-status"]', { hasText: 'Próxima rodada em' })), 'status line counts down');
  await shotIn('light', 'sheet-ativo');
  await setTheme('dark');
  await shotIn('dark', 'sheet-ativo');
  await setTheme('light');

  await button('Rodar agora').click();
  await loopLabel('Loop #2').waitFor({ timeout: 20_000 });
  await until('round 2 finished', async () => (await chipPhase()) === 'countdown', 20_000);
  await closeSheet();
}

async function stepPauseResume() {
  await openLoopFromHeader();
  await button('Pausar').click();
  await until('chip shows paused', async () => (await chipPhase()) === 'paused');
  assert.equal(await loopChip().innerText(), 'Loop pausado');
  await button('Retomar').click();
  // Resume runs the next round at once (nextRunAt = now), so the chip ends back on the countdown.
  await until('chip counts down again after resume', async () => (await chipPhase()) === 'countdown', 20_000);
  await closeSheet();
}

async function stepComposerLoop() {
  await until('round finished before composer command', async () => (await chipPhase()) === 'countdown', 20_000);
  await composer().fill('/loop 30s eco teste');
  await button('Enviar').click();
  await loopNotice('Loop iniciado').waitFor({ timeout: 10_000 });
  await until('new loop starts round 1 with the typed prompt', async () => {
    return (await loopLabel('Loop #1').count()) >= 2;
  }, 20_000);
  assert.ok(await hasCount(page.locator('[data-slot="bubble-user"]', { hasText: 'eco teste' })), 'prompt bubble shows the loop text');
  assert.equal(await composer().inputValue(), '', 'composer cleared after the command');
  await until('countdown after composer loop', async () => (await chipPhase()) === 'countdown', 20_000);
}

async function stepStop() {
  await openLoopFromHeader();
  await button('Parar loop').click();
  const confirm = page.getByRole('group', { name: 'Confirmar parada' });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Parar loop', exact: true }).click();
  await loopNotice('Loop parado').waitFor({ timeout: 10_000 });
  await loopSheet().waitFor({ state: 'hidden', timeout: 10_000 });
  await until('chip gone after stop', async () => (await loopChip().count()) === 0, 10_000);
  assert.ok(await hasCount(button('Modo Loop')), 'header button stays after stop');
}

async function stepDynamicNotes() {
  // Stopping deleted the loop, so the sheet is back in create mode.
  await openLoopFromHeader();
  await page.getByRole('radio', { name: 'Automático', exact: true }).click();
  await page.locator('#loop-prompt').fill('LOOP-NEXT=45s');
  await button('Iniciar loop').click();
  await page.locator('[data-slot="bubble-user"]', { hasText: 'LOOP-NEXT=45s' }).waitFor({ timeout: 20_000 });
  await loopNote('Próxima rodada em 45 s').waitFor({ timeout: 20_000 });

  // The reply's text stays; the marker and the loop instruction do not show anywhere in the chat.
  const timeline = await page.locator('[data-slot="chat-timeline"]').innerText();
  assert.ok(timeline.includes('Passo feito.'), `agent text stays visible, got "${timeline.slice(-300)}"`);
  assert.ok(!timeline.includes('nanachi'), `loop marker is hidden, got "${timeline.slice(-300)}"`);
  assert.ok(!timeline.includes('faz parte de um loop'), 'loop instruction is hidden');
  await until('chip counts down after the marked round', async () => (await chipPhase()) === 'countdown', 20_000);
  await page.locator('[data-slot="chat-timeline"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await shotIn('light', 'timeline-marcador');
  await setTheme('dark');
  await shotIn('dark', 'timeline-marcador');
  await setTheme('light');
}

// ---------- run ----------

let exitCode = 0;
try {
  mkdirSync(shotsDir, { recursive: true });
  for (const file of readdirSync(shotsDir)) rmSync(join(shotsDir, file), { force: true });
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
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  // The console's "Failed to load resource" line has no URL; name the failing request here.
  page.on('response', (response) => {
    if (response.status() >= 400) consoleErrors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
  });

  await pairAndWorkspace();
  await stepSheetEmpty();
  await stepStartLoop();
  await stepActiveSheetAndRunNow();
  await stepPauseResume();
  await stepComposerLoop();
  await stepStop();
  await stepDynamicNotes();
  assert.deepEqual(consoleErrors, [], 'browser console has no errors');
  log('Loop mode flow OK');
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2eloop] daemon log (tail):\n${tailLog()}`);
  const loopLines = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter((line) => /loop|warn|falhou|erro/i.test(line) && !/incoming request|request completed/.test(line))
    : [];
  console.error(`[e2eloop] daemon loop/warn lines:\n${loopLines.slice(-30).join('\n')}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`temporary home removed: ${home}`);
}
process.exitCode = exitCode;
