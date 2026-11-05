/*
 * E2E do "Entrar com Tailscale": pareia sem código de 6 dígitos quando o PC confia no login do Tailscale.
 * Sobe o daemon buildado com `tailscaleAutoPair: true` e uma allowlist com um login sintético. O navegador manda o
 * cabeçalho `Tailscale-User-Login` por extraHTTPHeaders (só no contexto que simula o login do tailnet; o daemon só
 * confia nele porque o peer é loopback).
 * Confere: sem o cabeçalho, o botão não aparece e o código continua sendo a única via; com o cabeçalho, aparece
 * "Entrar com Tailscale" com "Conectado como <login>" acima de "ou use um código de pareamento"; tocar pareia, grava a
 * máquina no aparelho e leva à home; revogado o aparelho, "Parear de novo" leva à mesma tela com o botão do Tailscale.
 * Screenshots nos dois temas em e2e/screenshots/pair/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:tailscale
 *
 * Pré-requisitos: Node 22+, Microsoft Edge (ou E2E_BROWSER_CHANNEL), porta 7810 livre. Tudo fica em
 * $TEMP/nanachi-e2etailscale-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'pair');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');

const PORT = 7810;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2etailscale] ${line}`);
/** Login sintético: nunca um e-mail real. */
const LOGIN = 'e2e-user@example.invalid';
const MACHINE_NAME = 'e2e-tailscale';

const home = join(tmpdir(), `nanachi-e2etailscale-${randomBytes(4).toString('hex')}`);
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(home, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: MACHINE_NAME,
    allowedRoots: [home],
    allowedTailscaleLogins: [LOGIN],
    tailscaleAutoPair: true,
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
      const res = await fetch(`${baseUrl}/api/pair/tailscale`);
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

/** Código do CLI só para a checagem de que o fluxo por código continua disponível (sem cabeçalho). */
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

// ---------- helpers de página ----------

async function shotBothThemes(page, name) {
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme === 'dark' ? 'escuro' : 'claro'}.png`) });
    log(`screenshot ${name} (${scheme})`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function until(page, description, check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      await page.screenshot({ path: join(shotsDir, `fail-${description.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
      throw new Error(`tempo esgotado esperando: ${description}`);
    }
    await page.waitForTimeout(150);
  }
}

const tailscaleButton = (page) => page.getByRole('button', { name: 'Entrar com Tailscale', exact: true });
const hasCount = (locator) => locator.count().then((n) => n > 0);

async function newPage(browserInstance, extraHTTPHeaders) {
  const context = await browserInstance.newContext({
    ...devices['iPhone 14'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders,
  });
  await context.exposeBinding('__reportCsp', (_source, line) => {
    cspViolations.push(line);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__reportCsp?.(`${event.violatedDirective} -> ${event.blockedURI}`);
    });
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  return { context, page };
}

async function main() {
  setupHome();
  await startDaemon();

  const health = await fetch(`${baseUrl}/api/pair/tailscale`);
  assert.equal(health.status, 200, 'GET /api/pair/tailscale responde sem token');
  assert.deepEqual(await health.json(), { available: false }, 'sem cabeçalho: indisponível, sem login');

  browser = await chromium.launch({ channel, headless: true });

  // 1) Sem o cabeçalho do Tailscale: o botão não aparece; o código segue como única via.
  const plain = await newPage(browser, undefined);
  await plain.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await plain.page.getByRole('heading', { name: 'Parear máquina' }).waitFor();
  await plain.page.waitForTimeout(1200);
  assert.equal(await hasCount(tailscaleButton(plain.page)), false, 'sem cabeçalho, o botão Entrar com Tailscale não aparece');
  assert.equal(await hasCount(plain.page.getByText('Conectado como')), false, 'sem cabeçalho, sem linha de login');
  await shotBothThemes(plain.page, '02-pareamento-sem-tailscale');
  await plain.context.close();

  // 2) Com o cabeçalho de um login da allowlist: aparece e pareia.
  const tailnet = await newPage(browser, { 'Tailscale-User-Login': LOGIN });
  const { page } = tailnet;
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await tailscaleButton(page).waitFor();
  await page.getByText(`Conectado como ${LOGIN}`, { exact: true }).waitFor();
  const divider = page.getByText('ou use um código de pareamento', { exact: true });
  await divider.waitFor();
  assert.equal(await page.getByLabel('Código').count(), 1, 'o campo de código continua abaixo do botão');
  await shotBothThemes(page, '01-pareamento-entrar-com-tailscale');

  await tailscaleButton(page).click();
  await until(page, 'home depois de entrar com Tailscale', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' })));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]'));
  assert.equal(stored.length, 1, 'a máquina foi gravada no aparelho');
  assert.equal(stored[0].name, MACHINE_NAME, 'nome da máquina');
  assert.equal(stored[0].baseUrl, baseUrl, 'endereço da máquina');
  assert.ok(typeof stored[0].token === 'string' && stored[0].token.length > 0, 'token gravado');
  log('pareado por Entrar com Tailscale');

  // 3) Aparelho revogado: "Parear de novo" leva para a mesma tela, com o botão do Tailscale primeiro.
  const devicesResponse = await fetch(`${baseUrl}/api/devices`, { headers: { authorization: `Bearer ${stored[0].token}`, 'Tailscale-User-Login': LOGIN } });
  const { devices: list } = await devicesResponse.json();
  const self = list[0];
  assert.ok(self !== undefined, 'o aparelho aparece em Dispositivos');
  const revoked = await fetch(`${baseUrl}/api/devices/${encodeURIComponent(self.id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${stored[0].token}`, 'Tailscale-User-Login': LOGIN },
  });
  assert.ok(revoked.ok, 'revogação do próprio aparelho pela API');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Parear de novo', exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Parear de novo', exact: true }).click();
  await tailscaleButton(page).waitFor();
  await page.getByText(`Conectado como ${LOGIN}`, { exact: true }).waitFor();
  await tailscaleButton(page).click();
  await until(page, 'home depois de parear de novo', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' })));
  log('re-pareado pelo Tailscale depois da revogação');

  await tailnet.context.close();

  // Código continua funcionando (o mesmo caminho de sempre).
  const coded = await newPage(browser, { 'Tailscale-User-Login': LOGIN });
  await coded.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await coded.page.getByRole('heading', { name: 'Parear máquina' }).waitFor();
  await coded.page.getByLabel('Código').fill(issuePairCode());
  await coded.page.getByRole('button', { name: 'Parear', exact: true }).click();
  // Mesmo com o login do tailnet, o código (campo abaixo do botão) grava um token novo.
  await until(coded.page, 'home depois do código', () => hasCount(coded.page.getByRole('region', { name: 'Estado da máquina' })));
  const afterCode = await coded.page.evaluate(() => JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]'));
  assert.notEqual(afterCode[0]?.token, stored[0].token, 'o pareamento por código trocou o token');
  await coded.context.close();

  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(
    consoleErrors.filter((line) => !/Failed to load resource: the server responded with a status of/.test(line)),
    [],
    'console do navegador sem erros',
  );
  log('fluxo Entrar com Tailscale OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2etailscale] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
