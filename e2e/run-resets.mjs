/*
 * E2E dos resets salvos na folha de uso ("Resets salvos", docs/PLAN.md, "rate-limit resets in the usage drawer").
 * Sobe o daemon buildado numa pasta temporária (porta livre), pareia pelo CLI e dirige o PWA buildado num Edge
 * headless com viewport de iPhone 14 (390x844). O agente é o fake (packages/daemon/test/fixtures/fake-agent.ts) com o
 * id "omp": ele responde a `/usage reset` com a listagem e a `/usage reset anthropic/1` com "Reset applied ...". O fake
 * não gasta nada de verdade; nunca use o omp ou o codex reais neste script.
 *
 * Confere: a folha de uso lista as linhas (conta, selo do provedor, contagens, expiração, nota); "Usar reset" só fica
 * habilitado com reset usável; abrir a folha e tocar na linha não gasta nada (o daemon não recebe nenhum POST); a
 * confirmação "Usar 1 reset?" tem o texto do contrato e Cancelar e Esc fecham sem gastar; só o "Usar reset" da
 * confirmação envia um POST (o alvo da linha), com o botão em andamento e todos os botões desabilitados; a resposta
 * aparece na folha com estilo de sucesso e a folha lê uso e resets de novo; a resposta continua depois de Atualizar e de fechar e abrir a folha, e só some ao dispensar. Um agente sem resets (id "claude") não pede
 * a lista. Screenshots nos dois temas em e2e/screenshots/resets/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:resets
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado. Tudo fica em $TEMP/nanachi-e2eresets-<rand> e é apagado no fim.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(here, 'screenshots', 'resets');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2eresets] ${line}`);

/** How long the fake holds a redeem, so the running state can be looked at. */
const REDEEM_DELAY_MS = 4000;

const home = join(tmpdir(), `nanachi-e2eresets-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let port = 0;
let baseUrl = '';
let daemon = null;
let browser = null;
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** A port the OS says is free right now. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const chosen = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(chosen));
    });
  });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const fake = {
    command: process.execPath,
    args: ['--import', tsxEsm, fakeAgentTs],
    kind: 'acp',
  };
  const config = {
    port,
    host: '127.0.0.1',
    machineName: 'e2e-resets',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      // Id "omp": the daemon picks the reset source by agent id, so the fake plays omp here.
      omp: {
        ...fake,
        label: 'Fake',
        env: { FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_RESET_DELAY_MS: String(REDEEM_DELAY_MS) },
      },
      // Id "claude": an agent without saved resets. Its usage drawer must not ask for the list.
      claude: {
        ...fake,
        label: 'Sem resets',
        env: { FAKE_AGENT_PID_DIR: pidDir },
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

/**
 * Requests that reached the daemon, read from its own log: `method` and the end of the path
 * (e.g. POST ".../usage/resets"). This counts what the daemon really received, whatever the page or the service
 * worker did.
 */
function daemonRequests(method, pathEnd) {
  if (!existsSync(logPath)) return 0;
  let count = 0;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.msg !== 'incoming request' || entry.req === undefined) continue;
    const url = String(entry.req.url ?? '').split('?')[0];
    if (entry.req.method === method && url.endsWith(pathEnd)) count += 1;
  }
  return count;
}

const redeemPosts = () => daemonRequests('POST', '/usage/resets');
const resetListGets = () => daemonRequests('GET', '/usage/resets');
const usagePosts = () => daemonRequests('POST', '/usage');

// ---------- helpers de página ----------

let page;

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

async function until(description, check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      await shot(`fail-${description.replace(/\W+/g, '-')}`).catch(() => undefined);
      throw new Error(`tempo esgotado esperando: ${description}`);
    }
    await page.waitForTimeout(100);
  }
}

const button = (name) => page.getByRole('button', { name, exact: true });
const headerTitle = (text) => page.locator('h1', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`[data-status="${status}"]`));

async function goToWorkspaces() {
  for (let step = 0; step < 6; step += 1) {
    if (await hasCount(headerTitle('Workspaces'))) return;
    if (await hasCount(page.getByRole('button', { name: 'Voltar', exact: true }))) {
      await button('Voltar').click();
    } else if (await hasCount(page.getByRole('button', { name: /^Workspaces (de|on|en) /u }))) {
      await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
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
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport precisa ser 390x844');
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await button('Parear').click();
  await until('status online na home', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })));

  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await headerTitle('Workspaces').waitFor();
  await button('Adicionar workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('ul[aria-label="Pastas"] > li button', { hasText: 'proj' }).click();
  await page.locator('h1 + p', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().waitFor();
}

async function themeShots(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
}

/** Opens "Uso do agente" (in the header, or in "Mais ações da sessão" on narrow screens) and returns the dialog. */
async function openUsageDrawer(agentLabel) {
  if ((await button('Uso do agente').count()) === 0) {
    await page.getByRole('button', { name: 'Mais ações da sessão', exact: true }).tap();
    await button('Uso do agente').tap();
  } else {
    await button('Uso do agente').tap();
  }
  const drawer = page.getByRole('dialog', { name: `Uso do ${agentLabel}` });
  await drawer.waitFor();
  return drawer;
}

async function closeUsageDrawer(drawer) {
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
}

const ACCOUNT_ONE = 'fake@example.com · Org';
const ACCOUNT_TWO = 'other@example.com';
const rowButton = (drawer, account) => drawer.getByRole('button', { name: `Usar reset de ${account}`, exact: true });

// ---------- fluxo ----------

async function stepRowsAndButtons() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  const drawer = await openUsageDrawer('Fake');
  await until('resposta do uso aparece na folha', () => hasCount(drawer.getByText('62%')), 30_000);

  const section = drawer.getByRole('region', { name: 'Resets salvos' });
  await section.waitFor({ timeout: 30_000 });
  const rows = section.locator('[data-slot="reset-row"]');
  await until('duas linhas de reset', async () => (await rows.count()) === 2, 30_000);

  // "Under the limit cards": the section comes after the window cards in the drawer.
  const order = await drawer.evaluate((root) => {
    const cards = root.querySelector('[role="progressbar"]');
    const resets = root.querySelector('#usage-resets');
    if (cards === null || resets === null) return null;
    return Boolean(cards.compareDocumentPosition(resets) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(order, true, 'a seção de resets fica abaixo dos cartões de limite');

  const first = rows.nth(0);
  const firstText = await first.innerText();
  assert.match(firstText, /fake@example\.com · Org/, 'rótulo da conta');
  assert.ok(await hasCount(first.locator('[data-slot="badge"]', { hasText: 'Anthropic' })), 'selo do provedor');
  assert.match(firstText, /2 salvos · 1 disponível agora/, 'contagens da primeira linha');
  assert.match(firstText, /expira in 3 days/, 'expiração da primeira linha');
  const second = rows.nth(1);
  const secondText = await second.innerText();
  assert.match(secondText, /other@example\.com/, 'rótulo da segunda conta');
  assert.ok(await hasCount(second.locator('[data-slot="badge"]', { hasText: 'OpenAI Codex' })), 'selo do segundo provedor');
  assert.match(secondText, /1 salvo · 0 disponíveis agora/, 'contagens da segunda linha');
  assert.match(secondText, /not constrained/, 'nota da segunda linha');

  assert.equal(await rowButton(drawer, ACCOUNT_ONE).isEnabled(), true, 'linha com reset usável: botão habilitado');
  assert.equal(await rowButton(drawer, ACCOUNT_TWO).isEnabled(), false, 'linha sem reset usável: botão desabilitado');
  const box = await rowButton(drawer, ACCOUNT_ONE).boundingBox();
  assert.ok(box !== null && box.height >= 44, `botão com 44px ou mais (${box?.height})`);

  const overflow = await drawer.evaluate((root) => root.scrollWidth - root.clientWidth);
  assert.ok(overflow <= 0, `a folha não rola na horizontal (${overflow}px)`);

  assert.equal(redeemPosts(), 0, 'abrir a folha não gasta nenhum reset');
  assert.ok(resetListGets() >= 1, 'a lista foi pedida ao daemon');
  log('linhas, selos, contagens, expiração, nota e estado dos botões OK; nenhum POST ao abrir');
  await shot('01-resets-escuro');
  await themeShots('light');
  await shot('02-resets-claro');
  await themeShots('dark');
  return drawer;
}

async function stepCancelDoesNothing(drawer) {
  const confirm = page.getByRole('dialog', { name: 'Usar 1 reset?' });

  // Cancelar.
  await rowButton(drawer, ACCOUNT_ONE).tap();
  await confirm.waitFor();
  assert.match(
    await confirm.innerText(),
    /fake@example\.com · Org · Anthropic\. Gasta um reset salvo e libera o limite agora\. Não dá para desfazer\./,
    'texto da confirmação',
  );
  assert.equal(redeemPosts(), 0, 'abrir a confirmação não gasta nada');
  const cancelBox = await confirm.getByRole('button', { name: 'Cancelar', exact: true }).boundingBox();
  const useBox = await confirm.getByRole('button', { name: 'Usar reset', exact: true }).boundingBox();
  assert.ok(cancelBox !== null && cancelBox.height >= 44, 'Cancelar com 44px ou mais');
  assert.ok(useBox !== null && useBox.height >= 44, 'Usar reset com 44px ou mais');
  await page.waitForTimeout(600); // the sheet rises with a transition
  await shot('03-confirmacao-escuro');
  await themeShots('light');
  await shot('04-confirmacao-claro');
  await themeShots('dark');
  await confirm.getByRole('button', { name: 'Cancelar', exact: true }).tap();
  await confirm.waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);
  assert.equal(redeemPosts(), 0, 'Cancelar não gasta nada');
  assert.ok(await drawer.isVisible(), 'a folha de uso continua aberta depois de Cancelar');
  assert.equal(await hasCount(drawer.locator('[data-slot="reset-result"]')), false, 'sem resposta de resgate');

  // Esc fecha só a confirmação.
  await rowButton(drawer, ACCOUNT_ONE).tap();
  await confirm.waitFor();
  await page.keyboard.press('Escape');
  await confirm.waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);
  assert.equal(redeemPosts(), 0, 'Esc não gasta nada');
  assert.ok(await drawer.isVisible(), 'Esc fecha só a confirmação; a folha de uso continua aberta');

  // Voltar do navegador (o gesto de voltar do iPhone) fecha só a confirmação.
  await rowButton(drawer, ACCOUNT_ONE).tap();
  await confirm.waitFor();
  await page.goBack();
  await confirm.waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);
  assert.equal(redeemPosts(), 0, 'o voltar do navegador não gasta nada');
  assert.ok(await drawer.isVisible(), 'o voltar fecha só a confirmação');
  log('Cancelar, Esc e o voltar fecham a confirmação sem gastar nada');
}

async function stepRedeem(drawer) {
  const confirm = page.getByRole('dialog', { name: 'Usar 1 reset?' });
  const listsBefore = resetListGets();
  const usageBefore = usagePosts();

  await rowButton(drawer, ACCOUNT_ONE).tap();
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Usar reset', exact: true }).tap();
  await confirm.waitFor({ state: 'hidden' });

  // Running: spinner on the redeemed row, every reset button and the refresh button disabled, one POST sent.
  const section = drawer.getByRole('region', { name: 'Resets salvos' });
  await until('botão em andamento', async () => (await rowButton(drawer, ACCOUNT_ONE).getAttribute('aria-busy')) === 'true', 5_000);
  assert.ok(await hasCount(rowButton(drawer, ACCOUNT_ONE).locator('svg.animate-spin')), 'spinner no botão da linha');
  assert.equal(await rowButton(drawer, ACCOUNT_ONE).isDisabled(), true, 'botão da linha desabilitado em andamento');
  assert.equal(await rowButton(drawer, ACCOUNT_TWO).isDisabled(), true, 'o botão da outra linha também');
  assert.equal(await drawer.getByRole('button', { name: 'Atualizar uso', exact: true }).isDisabled(), true, 'atualizar uso espera o resgate');
  await shot('05-resgate-em-andamento-escuro');
  assert.equal(redeemPosts(), 1, 'um POST de resgate enviado');

  // Result: success styling and the agent line; then usage and resets are read again.
  const result = section.locator('[data-slot="reset-result"]');
  await until('resposta do resgate', () => hasCount(result), REDEEM_DELAY_MS + 15_000);
  assert.equal(await result.getAttribute('data-tone'), 'success', 'estilo de sucesso para reset aplicado');
  assert.match(await result.innerText(), /Reset applied for fake@example\.com \(Anthropic\)/, 'linha do agente');
  assert.doesNotMatch(await result.innerText(), /\u001b|\[32m|\[39m/, 'resposta sem escapes ANSI');

  await until('uso e resets lidos de novo', async () => resetListGets() > listsBefore && usagePosts() > usageBefore, 30_000);
  await until('linhas de volta depois da leitura', async () => (await section.locator('[data-slot="reset-row"]').count()) === 2, 30_000);
  assert.equal(await hasCount(drawer.locator('[data-slot="reset-result"]')), true, 'a resposta continua na folha depois da leitura');
  assert.equal(await drawer.getByRole('button', { name: 'Atualizar uso', exact: true }).isEnabled(), true, 'atualizar uso volta a habilitar');
  assert.equal(await rowButton(drawer, ACCOUNT_ONE).isEnabled(), true, 'botão volta a habilitar (o fake não gasta nada)');
  assert.equal(redeemPosts(), 1, 'depois da leitura continua um único POST de resgate (nada reenviado)');
  log('resgate: um POST, spinner, botões desabilitados, resposta de sucesso e releitura OK');
  await shot('06-resgate-sucesso-escuro');
  await themeShots('light');
  await shot('07-resgate-sucesso-claro');
  await themeShots('dark');
}

async function stepReplyStaysUntilDismissed(drawer) {
  // A manual refresh reads everything again and never redeems. The reply of the redeem stays: it only goes away when
  // the user dismisses it or starts another redeem, and it survives closing and opening the drawer.
  const before = redeemPosts();
  await drawer.getByRole('button', { name: 'Atualizar uso', exact: true }).tap();
  await until('linhas de volta depois de Atualizar', async () => (await drawer.locator('[data-slot="reset-row"]').count()) === 2, 30_000);
  assert.equal(await drawer.locator('[data-slot="reset-result"]').count(), 1, 'a resposta do resgate continua depois de Atualizar');
  assert.equal(redeemPosts(), before, 'Atualizar uso nunca gasta um reset');

  await closeUsageDrawer(drawer);
  const reopened = await openUsageDrawer('Fake');
  await until('linhas de volta ao reabrir', async () => (await reopened.locator('[data-slot="reset-row"]').count()) === 2, 30_000);
  assert.equal(await reopened.locator('[data-slot="reset-result"]').count(), 1, 'a resposta continua ao fechar e abrir a folha');
  assert.equal(redeemPosts(), before, 'reabrir a folha nunca gasta um reset');

  // The close button (44px) dismisses it.
  const dismiss = reopened.getByRole('button', { name: 'Dispensar aviso', exact: true });
  const box = await dismiss.boundingBox();
  assert.ok(box !== null && box.height >= 44 && box.width >= 44, 'Dispensar aviso com 44px ou mais');
  await dismiss.tap();
  await until('resposta some ao dispensar', async () => (await reopened.locator('[data-slot="reset-result"]').count()) === 0, 5_000);
  assert.equal(redeemPosts(), before, 'dispensar não gasta nada');
  log('a resposta do resgate fica depois de Atualizar e de fechar e abrir; só some ao dispensar');
  await closeUsageDrawer(reopened);
}

async function stepAgentWithoutResets() {
  await newSession('Sem resets');
  await until('sessão sem resets ociosa', () => statusIs('idle'), 60_000);
  const listsBefore = resetListGets();
  const drawer = await openUsageDrawer('Sem resets');
  await until('uso do agente sem resets aparece', () => hasCount(drawer.getByText(/Atualizado /)), 30_000);
  await page.waitForTimeout(1500);
  assert.equal(await hasCount(drawer.getByText('Resets salvos')), false, 'agente sem resets não mostra a seção');
  assert.equal(resetListGets(), listsBefore, 'agente sem resets não pede a lista');
  log('agente sem resets: nenhuma seção e nenhum pedido de lista');
  await closeUsageDrawer(drawer);
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  for (const file of readdirSync(shotsDir)) rmSync(join(shotsDir, file), { force: true });
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  setupHome();
  await startDaemon();
  log(`daemon no ar em ${baseUrl} (home ${home})`);

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({
    ...devices['iPhone 14'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
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

  await pairAndWorkspace();
  await themeShots('dark');
  const drawer = await stepRowsAndButtons();
  await stepCancelDoesNothing(drawer);
  await stepRedeem(drawer);
  await stepReplyStaysUntilDismissed(drawer);
  await stepAgentWithoutResets();
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  log('fluxo dos resets salvos OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2eresets] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
