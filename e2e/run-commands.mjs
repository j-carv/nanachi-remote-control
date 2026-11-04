/*
 * E2E dos comandos do agente (available_commands_update → menu no composer). Sobe o daemon buildado numa pasta
 * temporária, pareia pelo CLI e dirige o PWA buildado num Edge headless com viewport de iPhone 14 (390x844).
 * O agente é o fake (packages/daemon/test/fixtures/fake-agent.ts) com FAKE_AGENT_COMMANDS=1: anuncia /loop, /mcp,
 * /skill:brainstorming e /eco; um segundo agente ("Sem comandos") não anuncia nada.
 * Confere: "/" no começo do composer abre o menu acima do campo (sem cobrir o campo), a busca filtra, o toque
 * insere "/<nome> " e o campo mantém o foco; o botão "/" abre o menu com busca e insere antes do texto; o comando
 * enviado vira prompt de texto e o fake responde ao /eco; a mensagem com comando aparece destacada; agente sem
 * comandos mostra "Este agente não anunciou comandos"; alvos de toque com 44px ou mais.
 * Screenshots nos dois temas (claro e escuro) em e2e/screenshots/commands/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:commands
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, porta 7802 livre. Tudo fica em
 * $TEMP/nanachi-e2ecmd-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'commands');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7802;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2ecmd] ${line}`);

const home = join(tmpdir(), `nanachi-e2ecmd-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
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
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const fake = {
    command: process.execPath,
    args: ['--import', tsxEsm, fakeAgentTs],
    kind: 'acp',
  };
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-comandos',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      fake: {
        ...fake,
        label: 'Fake',
        env: { FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_COMMANDS: '1' },
      },
      mudo: {
        ...fake,
        label: 'Sem comandos',
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
    await page.waitForTimeout(150);
  }
}

const button = (name) => page.getByRole('button', { name, exact: true });
const headerTitle = (text) => page.locator('.app-title', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`.pill-${status}`));
const composer = () => page.locator('.chat-textarea');
const composerValue = () => composer().inputValue();
const menu = () => page.locator('.slash-menu');
const menuItems = () => page.locator('.slash-item');
const commandButton = () => page.getByRole('button', { name: 'Comandos do agente', exact: true });

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
  await page.locator('.item-main', { hasText: 'proj' }).first().click();
  await page.getByRole('button', { name: '+ Nova sessão', exact: true }).waitFor();
}

async function newSession(agentLabel) {
  await openProjSessions();
  await button('+ Nova sessão').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await page.locator('.agent-choice', { hasText: agentLabel }).click();
  await button('Criar sessão').click();
}

async function pairAndWorkspace() {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport precisa ser 390x844');
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await button('Parear').click();
  await until('status online na home', () => hasCount(page.locator('.status-card.status-online')));

  await button('Workspaces').click();
  await headerTitle('Workspaces').waitFor();
  await button('+ Workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('.item-title', { hasText: 'proj' }).click();
  await page.locator('.app-header .muted', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('.item-main', { hasText: 'proj' }).first().waitFor();
}

/** Foco no campo: o teclado do iOS continua aberto depois de tocar um comando. */
const composerFocused = () => composer().evaluate((el) => document.activeElement === el);

/** A caixa do menu fica inteira acima do campo (não cobre o composer). */
async function menuAboveComposer() {
  const menuBox = await menu().boundingBox();
  const fieldBox = await composer().boundingBox();
  assert.ok(menuBox !== null && fieldBox !== null, 'menu e campo têm caixa');
  assert.ok(
    menuBox.y + menuBox.height <= fieldBox.y + 1,
    `menu acima do campo (${menuBox.y + menuBox.height} <= ${fieldBox.y})`,
  );
}

async function themeShots(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
}

// ---------- fluxo ----------

async function stepTypedMenu() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  // Os comandos chegam logo depois do session/new: o menu já tem a lista quando o chat abre.
  await until('menu lista os 4 comandos ao digitar /', async () => {
    await composer().fill('');
    await composer().pressSequentially('/');
    return (await menuItems().count()) === 4;
  });
  assert.equal(await menuItems().first().locator('.slash-name').innerText(), '/loop');
  assert.ok(await hasCount(page.locator('.slash-hint', { hasText: '[intervalo] [prompt]' })), 'dica do argumento aparece');
  assert.ok(
    await hasCount(page.locator('.slash-desc', { hasText: 'Repete um prompt em intervalo' })),
    'descrição aparece',
  );
  await menuAboveComposer();
  assert.ok(await composerFocused(), 'digitar / mantém o foco no campo');
  await shot('01-menu-barra-escuro');
  await themeShots('light');
  await shot('02-menu-barra-claro');
  await themeShots('dark');

  // Filtro: "/mc" mostra só o /mcp; "/bra" acha a skill pelo meio do nome; sem casamento, aviso.
  await composer().fill('');
  await composer().pressSequentially('/mc');
  assert.deepEqual(await menuItems().locator('.slash-name').allInnerTexts(), ['/mcp']);
  await composer().fill('');
  await composer().pressSequentially('/bra');
  assert.deepEqual(await menuItems().locator('.slash-name').allInnerTexts(), ['/skill:brainstorming']);
  await composer().fill('');
  await composer().pressSequentially('/zzz');
  await page.locator('.slash-empty', { hasText: 'Nenhum comando combina' }).waitFor();
  log('filtro: /mc, /bra e sem resultado OK');

  // Toque insere "/<nome> ", fecha o menu e mantém o foco no campo.
  await composer().fill('');
  await composer().pressSequentially('/lo');
  await page.locator('.slash-item', { hasText: '/loop' }).tap();
  await until('campo recebe "/loop "', async () => (await composerValue()) === '/loop ');
  assert.equal(await menu().count(), 0, 'menu fecha depois de inserir');
  assert.ok(await composerFocused(), 'toque no comando mantém o foco no campo');

  // Texto depois do comando: a busca some quando há espaço.
  await composer().pressSequentially('5m verificar o build');
  assert.equal(await composerValue(), '/loop 5m verificar o build');
  assert.equal(await menu().count(), 0, 'com espaço depois do comando, o menu não abre');
  log('inserção por toque e texto depois do comando OK');

  // Envio: o comando vai como texto. O /eco do fake responde só com o texto que vem depois.
  await composer().fill('');
  await composer().pressSequentially('/eco');
  await page.locator('.slash-item', { hasText: '/eco' }).tap();
  await composer().pressSequentially('oi, tudo bem');
  await button('Enviar').click();
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(300);

  const highlighted = page.locator('.chat-timeline .bubble-user .command-token');
  await until('comando destacado na mensagem enviada', () => hasCount(highlighted));
  assert.equal(await highlighted.first().innerText(), '/eco', 'o token destacado é o comando');
  const userText = await page.locator('.chat-timeline .bubble-user').first().innerText();
  assert.match(userText, /\/eco oi, tudo bem/, 'mensagem inteira no balão');
  await page.locator('.chat-timeline .agent-text', { hasText: 'oi, tudo bem' }).first().waitFor();
  assert.equal(
    await page.locator('.chat-timeline .agent-text', { hasText: 'Eco:' }).count(),
    0,
    '/eco responde só com o texto, sem o eco padrão',
  );
  log('envio do comando e resposta do /eco OK');
  await page.locator('.chat-timeline').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shot('03-chat-comando-enviado-escuro');
  await themeShots('light');
  await shot('04-chat-comando-enviado-claro');
  await themeShots('dark');
}

async function stepButtonMenu() {
  // Texto digitado antes: o botão põe o comando na frente do texto.
  await composer().fill('revisa o parser');
  await commandButton().tap();
  await page.locator('.slash-search').waitFor();
  assert.ok(
    await page.locator('.slash-search').evaluate((el) => document.activeElement === el),
    'busca do menu recebe o foco',
  );
  await menuAboveComposer();
  await page.locator('.slash-search').pressSequentially('loo');
  assert.deepEqual(await menuItems().locator('.slash-name').allInnerTexts(), ['/loop']);
  await shot('05-menu-botao-busca-escuro');
  await themeShots('light');
  await shot('06-menu-botao-busca-claro');
  await themeShots('dark');
  await page.locator('.slash-item', { hasText: '/loop' }).tap();
  await until('botão põe "/loop " antes do texto', async () => (await composerValue()) === '/loop revisa o parser');
  assert.equal(await menu().count(), 0, 'menu fecha depois de escolher');
  assert.ok(await composerFocused(), 'depois de escolher, o foco volta ao campo');

  // Fechar sem escolher: o "×" fecha e o texto não muda.
  await commandButton().tap();
  await page.locator('.slash-search').waitFor();
  await page.getByRole('button', { name: 'Fechar comandos', exact: true }).tap();
  assert.equal(await menu().count(), 0, 'o botão de fechar esconde o menu');
  assert.equal(await composerValue(), '/loop revisa o parser', 'fechar não mexe no texto');
  await composer().fill('');
  log('botão / com busca e inserção antes do texto OK');
}

async function stepTouchTargets() {
  await commandButton().tap();
  await page.locator('.slash-item').first().waitFor();
  const sizes = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.slash-item, .slash-close, .command-button, .attach-button')];
    return boxes.map((el) => {
      const rect = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') ?? el.className, h: rect.height, w: rect.width };
    });
  });
  for (const size of sizes) {
    assert.ok(size.h >= 44 && size.w >= 44, `alvo de toque ${size.name} com ${size.w}x${size.h}`);
  }
  log(`alvos de toque ≥ 44px: ${sizes.length}`);
  await commandButton().tap();
  await menu().waitFor({ state: 'detached' });
}

async function stepNoCommands() {
  await newSession('Sem comandos');
  await until('sessão sem comandos ociosa', () => statusIs('idle'), 60_000);
  await commandButton().tap();
  await page.locator('.slash-empty', { hasText: 'Este agente não anunciou comandos.' }).waitFor();
  await shot('07-sem-comandos-escuro');
  await themeShots('light');
  await shot('08-sem-comandos-claro');
  await themeShots('dark');
  await page.getByRole('button', { name: 'Fechar comandos', exact: true }).tap();
  assert.equal(await menu().count(), 0, 'fecha o menu sem comandos');
  log('agente sem comandos OK');
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  for (const file of readdirSync(shotsDir)) rmSync(join(shotsDir, file), { force: true });
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
  await stepTypedMenu();
  await stepButtonMenu();
  await stepTouchTargets();
  await stepNoCommands();
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  log('fluxo dos comandos do agente OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2ecmd] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
