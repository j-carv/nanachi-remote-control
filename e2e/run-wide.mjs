/*
 * E2E of the wide layout of the PWA (two panes from 900 x 500 px, a third pane from 1280 px) next to the phone layout.
 * Starts the built daemon in a temporary folder on its own port, pairs through the UI, adds two workspaces (a git
 * repository with an uncommitted change, and a plain folder) and sessions of the fake agent through the API, and drives
 * the built PWA in headless Edge twice:
 *
 *   390x844 (iPhone 14)  the phone layout is untouched: no list pane, one screen at a time, Enter adds a line.
 *   1440x900             list pane with the machine's workspaces and sessions, the empty screen, the chat in the right
 *                        pane with a ~760 px reading column, Enter sends and Shift+Enter adds a line, a session picked
 *                        in the list, "new session" in a dialog, settings without a back button, changes / files /
 *                        editor / terminal in a third pane that Escape and the X close, sheets as centred dialogs and
 *                        side panels, pointer cursors, no horizontal overflow, in light and dark. Enter with the menu of a
 *                        typed `/ec` open completes the command instead of sending it.
 *   Resizing             899 px is the phone layout, 900 px two panes, 1279 px has no third pane, 1280 px has one. A short
 *                        viewport is the phone layout at any width (the largest iPhones in landscape: 932x430, 956x440).
 *                        A pick in the list while a screen sits on top of the chat leaves no dead history entry: one Back
 *                        goes to the first screen.
 *
 * Screenshots go to a folder under the system temp directory (WIDE_SHOTS overrides it), never into the repository.
 *
 * Run from the repository root, after the supervisor (or a build) has published a PWA release:
 *   npm run e2e:wide
 *
 * Prerequisites: Node 22+, Microsoft Edge installed, git on PATH, packages/daemon/dist built, port 7846 free. Everything
 * but the screenshots lives in $TEMP/nanachi-e2ewide-<rand> and is removed at the end.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = process.env.WIDE_SHOTS ?? join(tmpdir(), 'nanachi-wide-shots');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7846;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2ewide] ${line}`);

const home = join(tmpdir(), `nanachi-e2ewide-${randomBytes(4).toString('hex')}`);
const workDir = join(home, 'work');
const projDir = join(workDir, 'proj');
const notesDir = join(workDir, 'notes');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let token = null;
const pageErrors = [];
const consoleErrors = [];

// ---------- daemon, fixtures and cleanup ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-wide',
    allowedRoots: [workDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      fake: {
        label: 'Fake',
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        env: { FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_COMMANDS: '1' },
        kind: 'acp',
      },
    },
  };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: projDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Nanachi E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'Nanachi E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
    },
    encoding: 'utf8',
  }).trim();
}

/** A repository with a committed file, then an edit and a new file left uncommitted (what "Changes" shows). */
function setupRepo() {
  mkdirSync(join(projDir, 'src'), { recursive: true });
  writeFileSync(
    join(projDir, 'src', 'app.ts'),
    'export interface Greeting {\n  name: string;\n}\n\nexport function greet(user: Greeting): string {\n  return `Hello, ${user.name}!`;\n}\n',
  );
  writeFileSync(join(projDir, 'README.md'), '# proj\n\nA synthetic project for the wide layout e2e.\n');
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-m', 'chore: start']);
  writeFileSync(
    join(projDir, 'src', 'app.ts'),
    'export interface Greeting {\n  name: string;\n  formal?: boolean;\n}\n\nexport function greet(user: Greeting): string {\n  return user.formal === true ? `Good day, ${user.name}.` : `Hello, ${user.name}!`;\n}\n',
  );
  writeFileSync(join(projDir, 'src', 'extra.ts'), 'export const extra = 1;\n');
  writeFileSync(join(notesDir, 'todo.md'), '- one\n- two\n');
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

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  assert.ok(response.ok, `${init.method ?? 'GET'} ${path} -> ${response.status}`);
  return response.status === 204 ? null : response.json();
}

// ---------- page helpers ----------

const until = async (page, description, check, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      await page.screenshot({ path: join(shotsDir, `fail-${description.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
      throw new Error(`timed out waiting for: ${description}`);
    }
    await page.waitForTimeout(120);
  }
};

const count = (locator) => locator.count();
const has = async (locator) => (await count(locator)) > 0;

async function shot(page, name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

/** The same screen in dark and in light. Leaves the page in light. */
async function shotBoth(page, name) {
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(250);
    await shot(page, `${name}-${colorScheme}`);
  }
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function box(locator) {
  const result = await locator.boundingBox();
  assert.ok(result !== null, 'element has a box');
  return result;
}

/** Synthetic logins for Settings: the daemon would read the real ones of this PC, which have no place in a screenshot. */
const FAKE_ACCOUNTS = {
  accounts: [
    {
      agentId: 'claude',
      label: 'Claude Code',
      status: 'logged_in',
      account: 'dev@example.test',
      detail: 'Example Org · team',
      checkedAt: Date.now(),
      supportsAccounts: true,
      profiles: [
        {
          id: 'default',
          label: 'Principal',
          isDefault: true,
          active: true,
          status: 'logged_in',
          account: 'dev@example.test',
          detail: 'Example Org · team',
          checkedAt: Date.now(),
        },
      ],
    },
    { agentId: 'fake', label: 'Fake', status: 'unknown', account: null, detail: null, checkedAt: Date.now(), supportsAccounts: false, profiles: [] },
  ],
};

async function newContext(options) {
  const context = await browser.newContext({ colorScheme: 'light', ...options });
  await context.route('**/api/agents/accounts**', (route) => route.fulfill({ json: FAKE_ACCOUNTS }));
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${message.text()} (${message.location().url})`);
  });
  return { context, page };
}

// ---------- phone ----------

async function pairOnPhone() {
  const { context, page } = await newContext({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'the phone viewport is 390x844');
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await page.getByRole('button', { name: 'Parear', exact: true }).click();
  await until(page, 'machine online on the phone home', () =>
    has(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })),
  );
  const machines = await page.evaluate(() => JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]'));
  token = machines[0].token;
  log('paired on the phone');
  return { context, page };
}

async function createContent() {
  const proj = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: projDir }) });
  const notes = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: notesDir }) });
  const rich = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId: proj.id, agent: 'fake' }) });
  const second = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId: proj.id, agent: 'fake' }) });
  const third = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId: notes.id, agent: 'fake' }) });
  log(`workspaces ${proj.id}, ${notes.id}; sessions ${rich.id}, ${second.id}, ${third.id}`);
  return { proj, notes, rich, second, third };
}

async function checkPhone(page, content) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await count(page.locator('[data-slot="wide-shell"]')), 0, 'phone: no wide shell');
  assert.equal(await count(page.locator('[data-slot="list-pane"]')), 0, 'phone: no list pane');
  assert.equal(await overflowX(page), 0, 'phone home: no horizontal overflow');
  await shotBoth(page, 'phone-home');

  // Open a session the way the phone always has: Workspaces -> workspace -> session.
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().click();
  await page.locator('ul[aria-label="Sessões"] > li button').first().click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();
  const position = await page.evaluate(() => {
    const root = document.querySelector('[data-slot="chat-timeline"]')?.closest('.fixed');
    return root === null || root === undefined ? null : getComputedStyle(root).position;
  });
  assert.equal(position, 'fixed', 'phone: the chat is still the fixed full-window root');
  assert.ok(await has(page.getByRole('button', { name: 'Voltar', exact: true })), 'phone: the chat keeps its back button');
  assert.equal(await count(page.locator('[data-slot="composer-hint"]:visible')), 0, 'phone: no Enter hint');

  // Enter is a new line on the phone, never a send.
  const field = page.locator('[data-slot="chat-textarea"]');
  await field.click();
  await field.fill('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  assert.equal(await field.inputValue(), 'line one\nline two', 'phone: Enter adds a line');
  assert.equal(await count(page.locator('[data-slot="bubble-user"]')), 0, 'phone: Enter did not send');
  await field.fill('');
  await shotBoth(page, 'phone-chat');
  assert.equal(await overflowX(page), 0, 'phone chat: no horizontal overflow');
  void content;
}

// ---------- wide ----------

const listSession = (page, index) => page.locator('[data-slot="list-session"]').nth(index);

async function openWide(storageState, width, height) {
  const { context, page } = await newContext({ viewport: { width, height }, storageState });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  return { context, page };
}

async function checkWideShell(page) {
  await page.locator('[data-slot="wide-shell"]').waitFor();
  await page.locator('[data-slot="list-workspace"]').first().waitFor({ timeout: 30_000 });
  const workspaces = await count(page.locator('[data-slot="list-workspace"]'));
  assert.equal(workspaces, 2, 'the list pane shows both workspaces');
  assert.equal(await count(page.locator('[data-slot="list-session"]')), 3, 'the list pane shows the three sessions');
  assert.ok(await has(page.locator('[data-slot="empty-detail"]')), 'nothing picked yet: the empty screen');
  const list = await box(page.locator('[data-slot="list-pane-frame"]'));
  assert.ok(list.width >= 300 && list.width <= 340, `list pane width ${list.width} is within 300-340 px`);
  assert.equal(await overflowX(page), 0, 'wide home: no horizontal overflow');
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('[data-slot="list-session"]')).cursor);
  assert.equal(cursor, 'pointer', 'a mouse gets the pointer cursor on the list rows');
  const row = page.locator('[data-slot="list-session"]').first();
  const idle = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
  await row.hover();
  await page.waitForTimeout(300);
  const hovered = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(hovered, idle, `the row has a hover state (${idle} -> ${hovered})`);
  await page.mouse.move(700, 450);
  await shotBoth(page, 'wide-01-empty');
}

async function checkChatInPane(page) {
  // Rows are newest first inside a workspace; the first workspace is "proj" with two sessions.
  await listSession(page, 0).click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();
  const list = await box(page.locator('[data-slot="list-pane-frame"]'));
  const detail = await box(page.locator('[data-slot="detail-pane"]'));
  assert.ok(detail.x >= list.x + list.width - 1, 'the chat sits right of the list pane');
  assert.ok(await has(page.locator('[data-slot="list-session"][aria-current="page"]')), 'the open session is marked in the list');
  assert.equal(await count(page.getByRole('button', { name: 'Voltar', exact: true })), 0, 'no back button beside the list');

  const field = page.locator('[data-slot="chat-textarea"]');
  await field.click();
  assert.ok(await page.locator('[data-slot="composer-hint"]').isVisible(), 'the Enter hint shows for a mouse and keyboard');
  const form = await box(page.locator('[data-slot="chat-input"]'));
  assert.ok(form.width <= 762 && form.width >= 700, `composer column is ~760 px (is ${form.width})`);
  assert.ok(await page.locator('[data-slot="composer-hint"]').isVisible());

  // Shift+Enter adds a line; Enter sends. "flood" makes the fake agent write a long, varied conversation.
  await field.fill('flood');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('(second line)');
  assert.equal(await field.inputValue(), 'flood\n(second line)', 'Shift+Enter adds a line');
  await field.fill('flood');
  await page.keyboard.press('Enter');
  await until(page, 'the user message is sent with Enter', () => has(page.locator('[data-slot="bubble-user"]')), 15_000);
  assert.equal(await field.inputValue(), '', 'Enter sent and cleared the composer');
  await until(page, 'the flood turn ends', () => has(page.locator('[data-slot="agent-text"]', { hasText: 'FIM-DO-FLOOD' })), 240_000);
  await until(page, 'the session is idle again', () => has(page.locator('[data-slot="list-session"][data-status="idle"][aria-current="page"]')), 30_000);
  await page.waitForTimeout(500);

  const distance = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="chat-timeline"]');
    return el === null ? -1 : el.scrollHeight - el.scrollTop - el.clientHeight;
  });
  log('distance to the end after the flood: ' + Math.round(distance) + ' px');
  assert.ok(distance >= 0 && distance <= 80, 'the chat followed the end of the stream (distance ' + distance + ' px)');
  const feed = await box(page.locator('[data-slot="chat-feed"]'));
  assert.ok(feed.width <= 762, `the message column is at most ~760 px (is ${feed.width})`);
  assert.ok(feed.width >= 600, `the message column fills its reading width (is ${feed.width})`);
  const timeline = await box(page.locator('[data-slot="chat-timeline"]'));
  assert.ok(timeline.width > feed.width + 100, 'the timeline spans the pane and the column is centred in it');
  assert.equal(await overflowX(page), 0, 'wide chat: no horizontal overflow');
  await shotBoth(page, 'wide-02-chat');
}

/** Enter with the slash menu of a typed command open completes the first match; it does not send `/ec`. */
async function checkSlashMenuEnter(page) {
  const field = page.locator('[data-slot="chat-textarea"]');
  const sentBefore = await count(page.locator('[data-slot="bubble-user"]'));
  await field.click();
  await field.fill('/ec');
  await page.locator('[data-slot="slash-menu"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-slot="slash-item"]', { hasText: '/eco' }).first().waitFor();
  await page.keyboard.press('Enter');
  await until(page, 'Enter completes /ec to the command', async () => (await field.inputValue()) === '/eco ');
  assert.equal(await count(page.locator('[data-slot="bubble-user"]')), sentBefore, 'Enter on the open menu did not send "/ec"');
  assert.equal(await count(page.locator('[data-slot="slash-menu"]')), 0, 'the menu closes once the command is picked');
  // With the command in place the next Enter sends it, as it always did.
  await page.keyboard.type('ola');
  await page.keyboard.press('Enter');
  await until(page, 'the completed command is sent with the next Enter', async () => (await count(page.locator('[data-slot="bubble-user"]'))) === sentBefore + 1);
  await until(page, 'the session is idle again after the command', () => has(page.locator('[data-slot="list-session"][data-status="idle"][aria-current="page"]')), 60_000);
  log('Enter with the slash menu open completed the command and the next Enter sent it');
}

async function checkPickAndNewSession(page) {
  // Another session of the same workspace, then one of the other workspace: the pane follows the list.
  await listSession(page, 1).click();
  await until(page, 'the second session opens', async () => (await page.locator('[data-slot="list-session"][aria-current="page"]').count()) === 1);
  assert.equal(await count(page.locator('[data-slot="bubble-user"]')), 0, 'the other session is a fresh conversation');
  await listSession(page, 2).click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();

  // "New session in <workspace>" from the list opens a dialog (not a bottom sheet) and opens the new session.
  const row = page.locator('[data-slot="list-workspace"]').first();
  await row.hover();
  await row.locator('[data-slot="list-new-session"]').click();
  const dialog = page.getByRole('dialog', { name: 'Nova sessão' });
  await dialog.waitFor();
  const viewport = page.viewportSize();
  const dialogBox = await box(dialog);
  const center = dialogBox.x + dialogBox.width / 2;
  assert.ok(Math.abs(center - viewport.width / 2) < 4, 'the new-session sheet is a centred dialog');
  assert.ok(dialogBox.y > 20 && dialogBox.y + dialogBox.height < viewport.height - 20, 'the dialog floats clear of the window edges');
  assert.ok(dialogBox.width <= 520, `the dialog is a reasonable width (is ${dialogBox.width})`);
  await shot(page, 'wide-03-new-session-dialog');
  await page.keyboard.press('Escape');
  await until(page, 'Escape closes the dialog', async () => (await count(page.getByRole('dialog'))) === 0);

  await row.hover();
  await row.locator('[data-slot="list-new-session"]').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await page.locator('[role="dialog"] button[aria-pressed]', { hasText: 'Fake' }).click();
  await page.getByRole('button', { name: 'Criar sessão' }).click();
  await until(page, 'the new session opens', async () => (await count(page.locator('[data-slot="list-session"]'))) === 4, 60_000);
  await page.locator('[data-slot="chat-textarea"]').waitFor();
}

async function checkSettings(page) {
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('heading', { name: 'Ajustes' }).waitFor();
  assert.equal(await count(page.getByRole('button', { name: 'Voltar', exact: true })), 0, 'settings beside the list has no back button');
  assert.ok(await has(page.locator('[data-slot="list-pane"]')), 'the list pane stays while settings is open');
  assert.equal(await overflowX(page), 0, 'wide settings: no horizontal overflow');
  await page.getByText('dev@example.test').first().waitFor();
  await shotBoth(page, 'wide-04-settings');
}

async function checkWorkspaceScreens(page) {
  // A workspace picked in the list shows its sessions screen in the right pane, with no back button.
  await page.locator('[data-slot="list-workspace-open"]').first().click();
  await page.getByRole('heading', { name: 'proj', exact: true }).waitFor();
  assert.equal(await count(page.getByRole('button', { name: 'Voltar', exact: true })), 0, 'the sessions screen beside the list has no back button');
  assert.ok(await has(page.locator('[data-slot="list-workspace-open"][aria-current="page"]')), 'the open workspace is marked in the list');
  assert.equal(await overflowX(page), 0, 'wide sessions screen: no horizontal overflow');
  await shotBoth(page, 'wide-04b-workspace-sessions');

  // Add workspace: the folder picker opens on top, with a way back to the empty screen.
  await page.getByRole('button', { name: 'Adicionar workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'Escolher pasta' }).waitFor();
  assert.ok(await has(page.getByRole('button', { name: 'Voltar', exact: true })), 'the folder picker keeps its back button');
  await shot(page, 'wide-04c-folder-picker');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.locator('[data-slot="empty-detail"]').waitFor();

  // The empty screen offers the workspaces screen.
  await page.locator('[data-slot="empty-detail"]').getByRole('button', { name: 'Workspaces', exact: true }).click();
  await page.locator('[data-slot="detail-pane"] h1', { hasText: 'Workspaces' }).waitFor();
  assert.equal(await count(page.locator('[data-slot="detail-pane"]').getByRole('button', { name: 'Voltar', exact: true })), 0, 'workspaces beside the list has no back button');
  await shot(page, 'wide-04d-workspaces');
}

async function openChatOf(page, index) {
  await listSession(page, index).click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();
}

async function checkSidePane(page) {
  await openChatOf(page, 0);
  const sideCount = () => count(page.locator('[data-slot="side-pane"]'));
  assert.equal(await sideCount(), 0, 'no third pane until something opens in it');

  // Changes (diff).
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await page.locator('[data-slot="side-pane"]').waitFor();
  await page.locator('[data-slot="change-row"]').first().waitFor({ timeout: 20_000 });
  const side = await box(page.locator('[data-slot="side-pane"]'));
  const viewport = page.viewportSize();
  assert.ok(Math.abs(side.x + side.width - viewport.width) < 2, 'the third pane is flush with the right edge');
  assert.ok(side.width >= 380 && side.width <= 640, `third pane width ${side.width} is within 380-640 px`);
  assert.ok(await has(page.locator('[data-slot="chat-textarea"]')), 'the chat stays beside the changes');
  assert.ok(await has(page.getByRole('button', { name: 'Fechar', exact: true })), 'the first screen of the pane has a close button');
  await page.locator('[data-slot="change-toggle"]').first().click();
  await page.waitForTimeout(300);
  assert.equal(await overflowX(page), 0, 'third pane: no horizontal overflow');
  await shotBoth(page, 'wide-05-changes-pane');

  // Escape closes the pane.
  await page.locator('body').press('Escape');
  await until(page, 'Escape closes the third pane', async () => (await sideCount()) === 0);

  // Files -> a file in the editor, with a back button inside the pane.
  await page.getByRole('button', { name: 'Arquivos', exact: true }).click();
  await page.locator('[data-slot="side-pane"]').waitFor();
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: /app\.ts|src/ }).first().waitFor({ timeout: 20_000 });
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: /^src/ }).first().click();
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: /app\.ts/ }).first().click();
  await page.locator('[data-slot="side-pane"] .cm-editor').waitFor({ timeout: 20_000 });
  assert.ok(await has(page.locator('[data-slot="side-pane"]').getByRole('button', { name: 'Voltar', exact: true })), 'the editor in the pane goes back to the explorer');
  const editor = await box(page.locator('[data-slot="side-pane"] .cm-editor'));
  assert.ok(editor.width <= side.width, 'the editor fits the pane');
  await shotBoth(page, 'wide-06-editor-pane');
  // Escape inside the editor belongs to the editor.
  await page.locator('[data-slot="side-pane"] .cm-content').click();
  await page.keyboard.press('Escape');
  assert.equal(await sideCount(), 1, 'Escape in the editor does not close the pane');
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: /app\.ts/ }).first().waitFor();
  // Back again, to the root of the explorer: the first screen of the pane has the X instead of a back button.
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: /^src/ }).first().waitFor();
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: 'Fechar', exact: true }).click();
  await until(page, 'the X closes the pane', async () => (await sideCount()) === 0);

  // Terminal: the shell sheet is a dialog; the terminal opens in the third pane.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor();
  await page.locator('[data-slot="shell-option"]').first().click();
  await page.locator('[data-slot="side-pane"] .xterm').waitFor({ timeout: 30_000 });
  assert.ok(await has(page.locator('[data-slot="chat-textarea"]')), 'the conversation stays on screen beside the terminal');
  const term = await box(page.locator('[data-slot="side-pane"] [data-slot="terminal-view"]'));
  assert.ok(term.width <= side.width, 'the terminal fits its pane');
  // A physical keyboard types straight into the terminal: the phone's key bar and line field are not drawn.
  assert.equal(await page.locator('[data-slot="terminal-key"]:visible').count(), 0, 'no on-screen key bar for a mouse and keyboard');
  assert.equal(await page.locator('[data-slot="terminal-line"]:visible').count(), 0, 'no line field for a mouse and keyboard');
  await page.waitForTimeout(1000);
  await page.keyboard.type('echo wide-terminal-ok');
  await page.keyboard.press('Enter');
  await until(page, 'typing reaches the terminal without a click', async () =>
    (await page.locator('[data-slot="side-pane"] .xterm-rows').innerText()).split('wide-terminal-ok').length > 2,
  );
  await shotBoth(page, 'wide-07-terminal-pane');
  await page.locator('[data-slot="side-pane"]').getByRole('button', { name: 'Fechar', exact: true }).click();
  await until(page, 'the terminal pane closes', async () => (await sideCount()) === 0);

  // The pane belongs to the conversation: a pane opened here is gone when another session is picked.
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await page.locator('[data-slot="side-pane"]').waitFor();
  await page.locator('[data-slot="list-workspace"]').nth(1).locator('[data-slot="list-session"]').first().click();
  await until(page, 'the other conversation opens', async () =>
    (await count(page.locator('[data-slot="list-workspace"]').nth(1).locator('[aria-current="page"]'))) === 1,
  );
  assert.equal(await sideCount(), 0, 'another conversation closes the third pane');
}

async function checkSheets(page) {
  // Configure session: a centred dialog.
  await page.getByRole('button', { name: 'Configurar sessão', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurar sessão' });
  await dialog.waitFor();
  const viewport = page.viewportSize();
  const dialogBox = await box(dialog);
  assert.ok(Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2) < 4, 'configure is a centred dialog');
  await page.waitForTimeout(300);
  await shotBoth(page, 'wide-08-config-dialog');
  await page.keyboard.press('Escape');
  await until(page, 'Escape closes the configure dialog', async () => (await count(page.getByRole('dialog'))) === 0);

  // Usage: a side panel on the right edge.
  await page.getByRole('button', { name: 'Uso do agente', exact: true }).click();
  const panel = page.locator('[data-slot="drawer-content"][data-panel="side"]');
  await panel.waitFor();
  await page.waitForTimeout(400);
  const panelBox = await box(panel);
  assert.ok(Math.abs(panelBox.x + panelBox.width - viewport.width) < 2, 'usage is a panel on the right edge');
  assert.ok(panelBox.height >= viewport.height - 2, 'the panel is full height');
  await shot(page, 'wide-09-usage-panel');
  await page.keyboard.press('Escape');
  await until(page, 'Escape closes the usage panel', async () => (await count(page.locator('[data-slot="drawer-content"]'))) === 0);
}

async function checkBreakpoints(storageState) {
  const { context, page } = await openWide(storageState, 899, 800);
  await page.getByRole('region', { name: 'Estado da máquina' }).waitFor({ timeout: 30_000 });
  assert.equal(await count(page.locator('[data-slot="wide-shell"]')), 0, '899 px is the phone layout');

  // A short viewport is the phone layout at any width: the largest iPhones in landscape are 932x430 and 956x440.
  for (const [width, height] of [[932, 430], [956, 440], [1440, 450], [1280, 499]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    assert.equal(await count(page.locator('[data-slot="wide-shell"]')), 0, `${width}x${height} is the phone layout`);
    assert.ok(await has(page.getByRole('region', { name: 'Estado da máquina' })), `${width}x${height}: the phone home is on screen`);
  }
  await page.setViewportSize({ width: 900, height: 500 });
  await page.locator('[data-slot="wide-shell"][data-layout="two-pane"]').waitFor();
  log('932x430, 956x440, 1440x450 and 1280x499 are the phone layout; 900x500 is two panes');

  await page.setViewportSize({ width: 900, height: 800 });
  await page.locator('[data-slot="wide-shell"][data-layout="two-pane"]').waitFor();
  await page.locator('[data-slot="list-workspace"]').first().waitFor({ timeout: 30_000 });
  assert.equal(await overflowX(page), 0, '900 px: no horizontal overflow');
  await shot(page, 'wide-10-900px');

  await page.locator('[data-slot="list-session"][data-kind="acp"]').first().click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();
  assert.equal(await overflowX(page), 0, '900 px chat: no horizontal overflow');
  await shot(page, 'wide-11-900px-chat');
  await page.getByRole('button', { name: 'Arquivos', exact: true }).waitFor({ state: 'detached', timeout: 1000 }).catch(() => undefined);
  assert.equal(await count(page.getByRole('button', { name: 'Arquivos', exact: true })), 0, 'two panes: no Files button in the chat (no third pane)');

  await page.setViewportSize({ width: 1279, height: 800 });
  await page.locator('[data-slot="wide-shell"][data-layout="two-pane"]').waitFor();
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await page.getByRole('heading', { name: 'Alterações' }).waitFor();
  assert.equal(await count(page.locator('[data-slot="side-pane"]')), 0, '1279 px: changes take the right pane, no third pane');
  assert.ok(await has(page.getByRole('button', { name: 'Voltar', exact: true })), '1279 px: changes keeps its back button');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();

  // A pick in the list while a screen sits on top of the chat (depth 2) leaves no dead history entries behind: the picked
  // session is at depth 1, and one Back goes to the first screen (the empty one), not to the screen that was replaced.
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await page.getByRole('heading', { name: 'Alterações' }).waitFor();
  await until(page, 'the changes screen is at history depth 2', async () => (await page.evaluate(() => history.state?.depth)) === 2);
  await listSession(page, 1).click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();
  await until(page, 'the pick is at history depth 1', async () => (await page.evaluate(() => history.state?.depth)) === 1);
  await page.goBack();
  await until(page, 'one Back after a pick from depth 2 shows the empty screen', async () => (await count(page.locator('[data-slot="empty-detail"]'))) === 1);
  assert.equal(await page.evaluate(() => history.state?.depth), 0, 'the history is back at depth 0');
  await page.locator('[data-slot="list-session"][data-kind="acp"]').first().click();
  await page.locator('[data-slot="chat-textarea"]').waitFor();
  log('a pick from depth 2 left no dead history entry: one Back went to the first screen');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-slot="wide-shell"][data-layout="three-pane"]').waitFor();
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await page.locator('[data-slot="side-pane"]').waitFor();
  await shot(page, 'wide-12-1280px-changes');

  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('[data-slot="wide-shell"][data-layout="two-pane"]').waitFor();
  assert.equal(await count(page.locator('[data-slot="side-pane"]')), 0, 'shrinking below 1280 px hides the third pane');
  await context.close();
}

// ---------- main ----------

async function main() {
  setupHome();
  setupRepo();
  await startDaemon();
  browser = await chromium.launch({ channel, headless: true });
  log(`screenshots in ${shotsDir}`);

  const phone = await pairOnPhone();
  const content = await createContent();
  await checkPhone(phone.page, content);
  const storageState = await phone.context.storageState();
  // The phone left its last screen saved: the wide windows start from the home (the empty screen), as a fresh open.
  for (const origin of storageState.origins) {
    origin.localStorage = origin.localStorage.filter((item) => item.name !== 'nanachi.lastRoute');
  }
  await phone.context.close();

  const { context, page } = await openWide(storageState, 1440, 900);
  await checkWideShell(page);
  await checkChatInPane(page);
  await checkSlashMenuEnter(page);
  await checkPickAndNewSession(page);
  await checkSettings(page);
  await checkWorkspaceScreens(page);
  await checkSidePane(page);
  await checkSheets(page);
  await context.close();

  await checkBreakpoints(storageState);

  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
  // The fake agent has no usage to report: opening the usage panel gets a 400 from the daemon, which the panel shows inline.
  const realErrors = consoleErrors.filter(
    (text) => !/favicon|Failed to load resource.*(404|401)/.test(text) && !/status of 400 .*\/api\/sessions\/[^/]+\/usage\)$/.test(text),
  );
  assert.deepEqual(realErrors, [], 'no console errors');
  log('OK: phone layout intact, two panes from 900 px, third pane from 1280 px');
}

try {
  await main();
} catch (error) {
  console.error(error);
  console.error(`daemon log tail:\n${tailLog()}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (daemon?.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true });
}
