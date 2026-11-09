/*
 * E2E do terminal no workspace: abre o Terminal pela folha de shells, digita e roda um comando pela linha de texto,
 * rola o histórico por toque, encerra a sessão e confere o estado encerrado.
 * Sobe o daemon buildado numa pasta temporária, pareia pela API e cria o workspace; dirige o PWA buildado num Edge
 * headless com viewport de iPhone (390x844). A máquina entra no localStorage por addInitScript, para o teste começar
 * no workspace. (O pareamento por código na tela já é coberto por run-workspace.mjs.)
 * Confere: shell padrão marcado primeiro; o texto do comando aparece no xterm; o chat não aparece para o terminal (sem
 * Uso do agente, sem Configurar sessão); a tela não tem barra de teclas nem botões além da linha de texto e de Enviar;
 * rolagem por toque: 120 linhas de saída, arrasto vertical com CDP rola o histórico, arrasto horizontal não rola, toque
 * sem movimento foca o terminal, e Enviar leva a resposta de volta ao fim da saída; estado encerrado sem botão para
 * abrir outro. CSP e console sem erros. Screenshots nos dois temas em e2e/screenshots/terminal/.
 * O teclado do iOS não é testado aqui: o foco é conferido pelo elemento ativo.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:terminal
 *
 * Pré-requisitos: Node 22+, Microsoft Edge (ou E2E_BROWSER_CHANNEL), porta 7808 livre, Windows com cmd.exe.
 * Tudo fica em $TEMP/nanachi-e2eterm-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'terminal');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');

const PORT = 7808;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2eterm] ${line}`);
const WORKSPACE_NAME = 'proj';
const SHELL_TITLE = 'Terminal · cmd';

const home = join(tmpdir(), `nanachi-e2eterm-${randomBytes(4).toString('hex')}`);
const projDir = join(home, WORKSPACE_NAME);
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let page;
let machine = null;
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'README.md'), '# proj\n');
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-terminal',
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
      /* ainda subindo */
    }
    if (Date.now() > deadline) throw new Error(`daemon não respondeu. Log: ${tailLog()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

function tailLog() {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(sem log)';
}

function issuePairCode() {
  const output = execFileSync(process.execPath, [daemonCli, 'pair'], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    encoding: 'utf8',
  });
  const match = /(\d{6})/.exec(output);
  if (match === null) throw new Error(`código de pareamento não encontrado: ${output}`);
  return match[1];
}

/** Pareia pela API e cria o workspace (o pareamento por código na tela já é coberto por run-workspace.mjs). */
async function provisionMachine() {
  const pair = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issuePairCode(), deviceName: 'e2e' }),
  });
  assert.equal(pair.status, 200, 'pareamento por código na API');
  const paired = await pair.json();
  machine = { id: paired.machineId, name: paired.machineName, baseUrl, token: paired.token };

  const created = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.token}` },
    body: JSON.stringify({ path: projDir, name: WORKSPACE_NAME }),
  });
  assert.equal(created.status, 201, 'workspace criado pela API');
}

// ---------- helpers de página ----------

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

/** Mesma tela no claro e no escuro (o CSS segue o tema do sistema). Volta ao claro no fim. */
async function shotBothThemes(name) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot(`${name}-escuro`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  await shot(`${name}-claro`);
}

async function until(description, check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      await shot(`fail-${description.replace(/\W+/g, '-')}`).catch(() => undefined);
      throw new Error(`tempo esgotado esperando: ${description}`);
    }
    await page.waitForTimeout(150);
  }
}

const button = (name) => page.getByRole('button', { name, exact: true });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const rowsText = () => page.locator('[data-slot="terminal-view"] .xterm-rows').innerText();
const occurrences = (text, word) => text.split(word).length - 1;
const terminalLine = () => page.locator('[data-slot="terminal-line"]');
const sessionRows = () => page.locator('ul[aria-label="Sessões"] > li', { hasText: SHELL_TITLE });

async function goToWorkspace() {
  await until('home carregada', () => hasCount(page.getByRole('button', { name: /^Workspaces (de|on|en) /u })));
  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: WORKSPACE_NAME }).getByRole('button').first().click();
  await button('Nova sessão').waitFor();
}

/** Abre a folha "Terminal", confere a lista e abre o cmd. */
async function openCmdTerminal() {
  await button('Terminal').click();
  await page.getByRole('dialog', { name: 'Terminal' }).waitFor();
  await page.waitForTimeout(350);
  await shotBothThemes('01-folha-de-shells');

  const shells = await page.locator('[data-slot="shell-option"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-shell')),
  );
  assert.ok(shells.includes('cmd'), `cmd disponível na lista: ${shells.join(', ')}`);
  const first = page.locator('[data-slot="shell-option"]').first();
  assert.match(await first.innerText(), /Padrão deste PC/, 'o primeiro shell é o padrão marcado');

  await page.locator('[data-slot="shell-option"][data-shell="cmd"]').click();
  await page.locator('[data-slot="terminal-view"] .xterm').waitFor();
  await until('linha do terminal liberada', () => terminalLine().isEnabled());
  await page.waitForTimeout(300);
}

/** Digita na linha de texto e manda com Enviar: a tela não tem outro jeito de enviar uma linha. */
async function typeCommand(text) {
  await terminalLine().fill(text);
  await button('Enviar').click();
}

async function stepEcho() {
  await openCmdTerminal();
  assert.equal(await button('Uso do agente').count(), 0, 'sem Uso do agente no terminal');
  assert.equal(await button('Configurar sessão').count(), 0, 'sem Configurar sessão no terminal');
  await typeCommand('echo nanachi-ok');
  await until('saída do echo no xterm', async () => occurrences(await rowsText(), 'nanachi-ok') >= 2);
  await shotBothThemes('02-terminal-com-barra-de-teclas');
}

/** Texto da primeira linha visível do xterm (muda quando a rolagem muda a área visível). */
const firstRowText = () => page.locator('[data-slot="terminal-view"] .xterm-rows > div').first().innerText();

/** Arrasto com o dedo do CDP: `touchStart`, passos de `touchMove`, `touchEnd`. */
async function touchDrag(cdp, from, to, steps = 12) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let step = 1; step <= steps; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function stepTouchScroll(cdp) {
  await typeCommand('for /L %i in (1,1,120) do @echo touch-%i');
  await until('saída de 120 linhas chegou ao fim', async () => (await rowsText()).includes('touch-120'));
  const bottomRow = await firstRowText();

  const box = await page.locator('[data-slot="terminal-view"]').boundingBox();
  assert.ok(box !== null, 'terminal tem caixa');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Dedo descendo: o conteúdo acompanha o dedo e a saída mais antiga aparece.
  await touchDrag(cdp, center, { x: center.x, y: center.y + 220 });
  await until('arrasto para baixo rolou o histórico', async () => (await firstRowText()) !== bottomRow);

  // Arrasto na horizontal não rola (espera a desaceleração do arrasto anterior terminar).
  await page.waitForTimeout(1200);
  const beforeHorizontal = await firstRowText();
  await touchDrag(cdp, center, { x: center.x + 200, y: center.y });
  await page.waitForTimeout(500);
  assert.equal(await firstRowText(), beforeHorizontal, 'arrasto na horizontal não rola');

  // Toque sem movimento: o terminal ganha foco (no iPhone, é o que abre o teclado).
  await page.touchscreen.tap(center.x, center.y);
  await until('toque põe o foco no terminal', () =>
    page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true),
  );

  // Enviar uma linha com o histórico rolado para cima leva a tela ao fim: a resposta aparece sem botão extra.
  await typeCommand('echo touch-end');
  await until('a resposta aparece no fim da saída', async () => occurrences(await rowsText(), 'touch-end') >= 2);
  await shotBothThemes('05-rolagem-por-toque');
}

async function stepStop() {
  await button('Voltar').click();
  await sessionRows().waitFor();
  assert.equal(await sessionRows().locator('[data-status]').getAttribute('data-status'), 'running', 'terminal em execução');
  await button(`Encerrar ${SHELL_TITLE}`).click();
  await until('sessão encerrada na lista', async () =>
    (await sessionRows().locator('[data-status]').getAttribute('data-status')) === 'stopped',
  );
  await sessionRows().getByText('Encerrado', { exact: true }).waitFor();
  await shotBothThemes('03-lista-com-terminal-encerrado');

  await page.locator('ul[aria-label="Sessões"] button', { hasText: SHELL_TITLE }).first().click();
  const closed = page.locator('[data-slot="terminal-closed"]');
  await closed.waitFor();
  await closed.getByText(/Terminal encerrado/).waitFor();
  assert.equal(await closed.getByRole('button').count(), 0, 'encerrado sem botão além da navegação');
  assert.equal(await terminalLine().isDisabled(), true, 'linha de texto desligada no encerrado');
  await shotBothThemes('04-terminal-encerrado');
  log('terminal encerrado OK');
}

async function main() {
  setupHome();
  await startDaemon();
  await provisionMachine();

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({
    ...devices['iPhone 14'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  // Máquina já pareada: entra no localStorage antes da primeira carga (só se ainda não houver nada salvo).
  await context.addInitScript(
    ({ machines, selected }) => {
      if (localStorage.getItem('nanachi.machines') === null) {
        localStorage.setItem('nanachi.machines', machines);
        localStorage.setItem('nanachi.selectedMachine', selected);
      }
    },
    { machines: JSON.stringify([machine]), selected: machine.id },
  );
  await context.exposeBinding('__reportCsp', (_source, line) => {
    cspViolations.push(line);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__reportCsp?.(`${event.violatedDirective} -> ${event.blockedURI}`);
    });
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport precisa ser 390x844');

  await goToWorkspace();
  await stepEcho();
  await stepTouchScroll(await context.newCDPSession(page));
  await stepStop();

  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(
    consoleErrors.filter((line) => !/Failed to load resource: the server responded with a status of/.test(line)),
    [],
    'console do navegador sem erros',
  );
  log('fluxo do terminal OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2eterm] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
