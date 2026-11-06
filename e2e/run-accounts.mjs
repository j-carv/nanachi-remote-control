/*
 * E2E de várias contas por agente (docs/PLAN.md, "several accounts per agent"). Sobe o daemon buildado numa pasta
 * temporária (porta livre) e dirige o PWA buildado num Edge headless com viewport de iPhone 14 (390x844).
 *
 * Nada aqui toca o login de verdade. O agente "claude" roda o fake (packages/daemon/test/fixtures/fake-agent.ts) e a
 * conta principal dele é uma pasta temporária (CLAUDE_CONFIG_DIR no env do agente e do daemon): o `%USERPROFILE%\.claude`
 * real nunca é lido nem escrito. O daemon sobe por e2e/fixtures/accounts-daemon.mjs, que usa o ponto de extensão que
 * os testes do daemon já usam (`buildServer({ accountRuntime })`): o login e a checagem de identidade rodam
 * e2e/fixtures/fake-claude-cli.mjs no lugar do binário `claude`. Nenhum código de teste existe no daemon.
 *
 * Fluxo: Ajustes lista a conta Principal ("Em uso") e um agente sem contas; "Adicionar conta" -> nome "Trabalho" ->
 * folha de login com o link (abre em outra aba, com rel="noopener noreferrer") e o campo do código; um código errado
 * falha (saída recolhida, código mascarado); Cancelar manda o DELETE; o código certo conecta a conta; renomear; "Usar em
 * novas sessões". Nova sessão mostra "Conta" já com a conta ativa e o agente enviado ao processo usa a pasta da conta
 * (CLAUDE_CONFIG_DIR). A folha de configuração trava a troca enquanto o agente trabalha (com a dica); remover a conta
 * com sessão ocupando é recusado; trocar para a Principal mostra "Conta trocada para Principal" e reinicia o agente
 * com a pasta principal; a folha de uso mostra "Conta: ...". Por fim, remover a conta (com confirmação).
 * Screenshots nos dois temas em e2e/screenshots/accounts/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:accounts
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado. Tudo fica em $TEMP/nanachi-e2eacc-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'accounts');
const daemonLauncher = join(here, 'fixtures', 'accounts-daemon.mjs');
const fakeCli = join(here, 'fixtures', 'fake-claude-cli.mjs');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2eacc] ${line}`);

const home = join(tmpdir(), `nanachi-e2eacc-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const principalHome = join(home, 'principal-claude');
const logPath = join(home, 'daemon.log');

const PRINCIPAL_EMAIL = 'principal@example.test';
const WORK_EMAIL = 'trabalho@example.test';

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
  mkdirSync(principalHome, { recursive: true });
  // The principal account is logged in (the marker stands for its credential file).
  writeFileSync(join(principalHome, 'e2e-login.json'), JSON.stringify({ email: PRINCIPAL_EMAIL }));
  const fake = {
    command: process.execPath,
    args: ['--import', tsxEsm, fakeAgentTs],
    kind: 'acp',
  };
  const config = {
    port,
    host: '127.0.0.1',
    machineName: 'e2e-accounts',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      // Id "claude": the daemon has an account adapter for it. Its principal home is the temp folder.
      claude: {
        ...fake,
        label: 'Claude Code',
        env: { FAKE_AGENT_PID_DIR: pidDir, CLAUDE_CONFIG_DIR: principalHome },
      },
      // An agent with no account adapter: it keeps its single row in Settings and has no "Conta" select.
      outro: {
        ...fake,
        label: 'Sem contas',
        env: { FAKE_AGENT_PID_DIR: pidDir },
      },
    },
  };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

const daemonEnv = () => ({
  ...process.env,
  NANACHI_HOME: home,
  CLAUDE_CONFIG_DIR: principalHome,
  E2E_FAKE_CLAUDE_CLI: fakeCli,
  E2E_FAKE_EMAIL: WORK_EMAIL,
});

async function startDaemon() {
  const out = openSync(logPath, 'a');
  daemon = spawn(process.execPath, [daemonLauncher], {
    cwd: repoRoot,
    env: daemonEnv(),
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
 * (e.g. DELETE ".../login"). This counts what the daemon really received, whatever the page or the service worker did.
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

/** The files of the fake agent with the env each process received (one per session id, also for the usage probe). */
const envFiles = () => readdirSync(pidDir).filter((name) => name.endsWith('.env.json'));

/** File of the session's own agent: the only one there is before anything opens the usage probe. */
let sessionEnvFile = null;

/** The environment the session's agent process received at its last start, from the fake agent's own file. */
function agentEnv() {
  assert.notEqual(sessionEnvFile, null, 'o arquivo de env da sessão ainda não foi identificado');
  return JSON.parse(readFileSync(join(pidDir, sessionEnvFile), 'utf8'));
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
    await page.waitForTimeout(100);
  }
}

const button = (name) => page.getByRole('button', { name, exact: true });
const headerTitle = (text) => page.locator('h1', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const dialog = (name) => page.getByRole('dialog', { name });

async function setTheme(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(250);
}

/** Dark shot, then light shot, then back to dark. */
async function shotBoth(name) {
  await shot(`${name}-escuro`);
  await setTheme('light');
  await shot(`${name}-claro`);
  await setTheme('dark');
}

async function goHome() {
  for (let step = 0; step < 8; step += 1) {
    if (await hasCount(button('Ajustes'))) return;
    if (await hasCount(button('Voltar'))) await button('Voltar').click();
    await page.waitForTimeout(250);
  }
  await button('Ajustes').waitFor({ timeout: 10_000 });
}

async function openSettings() {
  await goHome();
  await button('Ajustes').click();
  await headerTitle('Ajustes').waitFor();
  await group().waitFor({ timeout: 20_000 });
  await until('lista de contas carregada', () => hasCount(group().locator('[data-slot="account-row"]')), 20_000);
}

async function goToWorkspaces() {
  for (let step = 0; step < 6; step += 1) {
    if (await hasCount(headerTitle('Workspaces'))) return;
    if (await hasCount(button('Voltar'))) {
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
  await button('Nova sessão').waitFor();
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

/** The "Claude Code" accounts group in Settings. */
const group = () => page.getByRole('group', { name: 'Claude Code', exact: true });
const rowOf = (accountId) => group().locator(`[data-slot="account-row"][data-account="${accountId}"]`);
const rows = () => group().locator('[data-slot="account-row"]');

/** The id of the extra account named `label`, read from its row. */
async function accountIdOf(label) {
  const row = rows().filter({ has: page.locator('span.font-medium', { hasText: new RegExp(`^${label}$`) }) });
  assert.equal(await row.count(), 1, `uma linha chamada ${label}`);
  const id = await row.getAttribute('data-account');
  assert.ok(id !== null && id !== 'default', 'id da conta extra');
  return id;
}

/** Opens the action sheet of a row and returns its dialog. */
async function openActions(accountId) {
  await rowOf(accountId).click();
  const sheet = dialog('Ações da conta');
  await sheet.waitFor();
  await page.waitForTimeout(450); // the sheet rises with a transition
  return sheet;
}

const itemTexts = (sheet) => sheet.locator('[data-slot="action-sheet-item"] [data-slot="action-sheet-label"]').allInnerTexts();

async function pickAction(sheet, label) {
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: label }).click();
  await sheet.waitFor({ state: 'hidden' });
}

const touchHeight = async (locator) => (await locator.boundingBox())?.height ?? 0;

// ---------- fluxo ----------

async function stepSettingsBeforeAccounts() {
  await openSettings();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `Ajustes não rola na horizontal (${overflow}px)`);

  assert.equal(await rows().count(), 1, 'só a conta Principal');
  const principal = rowOf('default');
  const text = await principal.innerText();
  assert.match(text, /Principal/, 'nome da conta principal');
  assert.match(text, /Em uso/, 'a principal é a conta em uso');
  assert.ok(text.includes(PRINCIPAL_EMAIL), `e-mail da principal (${text})`);
  assert.ok(await touchHeight(principal) >= 44, 'linha com 44px ou mais');

  // The agent without an adapter keeps its single row and has no account actions.
  const plain = page.locator('li', { hasText: 'Sem contas' });
  assert.ok(await hasCount(plain), 'agente sem contas listado como antes');
  assert.equal(await hasCount(page.getByRole('group', { name: 'Sem contas', exact: true })), false, 'agente sem contas não tem grupo de contas');
  assert.ok(await touchHeight(group().locator('[data-slot="add-account"]')) >= 44, '"Adicionar conta" com 44px ou mais');
  await shotBoth('01-ajustes-principal');

  // The principal can log in again and be the account of new sessions, nothing else.
  const sheet = await openActions('default');
  assert.deepEqual(await itemTexts(sheet), ['Entrar'], 'a principal em uso só oferece "Entrar"');
  await shot('02-acoes-principal-escuro');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  log('Ajustes: a Principal (Em uso, e-mail), agente sem contas à parte, ações da principal OK');
}

async function stepAddAccountAndFailLogin() {
  await group().getByRole('button', { name: 'Adicionar conta', exact: true }).click();
  const name = dialog('Adicionar conta');
  await name.waitFor();
  await page.waitForTimeout(450);
  assert.ok(await touchHeight(name.getByRole('button', { name: 'Criar', exact: true })) >= 44, 'Criar com 44px ou mais');
  assert.equal(await name.getByRole('button', { name: 'Criar', exact: true }).isDisabled(), true, 'Criar espera um nome');
  await name.locator('#entry-name').fill('x'.repeat(41));
  await name.getByText('Nome longo demais (máx. 40 caracteres).').waitFor();
  assert.equal(await name.getByRole('button', { name: 'Criar', exact: true }).isDisabled(), true, '41 caracteres não passa');
  await name.locator('#entry-name').fill('  Trabalho ');
  await shot('03-nome-da-conta-escuro');
  await name.getByRole('button', { name: 'Criar', exact: true }).click();

  const login = dialog('Entrar na conta');
  await login.waitFor({ timeout: 20_000 });
  assert.equal(daemonRequests('POST', '/api/agents/claude/accounts'), 1, 'um POST de criação');
  assert.equal(await login.getByText('Claude Code · Trabalho').count(), 1, 'a folha diz agente e conta');

  const link = login.locator('[data-slot="login-link"]');
  await link.waitFor({ timeout: 30_000 });
  const href = await link.getAttribute('href');
  assert.match(href ?? '', /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/, 'o link é o da página de login');
  assert.equal(await link.getAttribute('target'), '_blank', 'o link abre em outra aba');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer', 'sem opener nem referrer');
  assert.ok(await touchHeight(link) >= 44, 'Abrir link com 44px ou mais');
  assert.ok(await hasCount(login.getByRole('button', { name: 'Copiar link', exact: true })), 'botão de copiar o link');
  assert.ok(await hasCount(login.getByText('O PC também pode abrir uma aba de login; pode ignorar.')), 'aviso da aba no PC (só o Claude)');
  assert.ok(await hasCount(login.getByText('Aguardando você entrar…')), 'estado "Aguardando você entrar…"');
  assert.equal(await hasCount(login.locator('[data-slot="login-user-code"]')), false, 'o Claude não mostra código para digitar');
  assert.equal(await login.getByRole('button', { name: 'Enviar', exact: true }).isDisabled(), true, 'Enviar espera o código');
  assert.ok(await touchHeight(login.getByRole('button', { name: 'Cancelar', exact: true })) >= 44, 'Cancelar com 44px ou mais');

  // Polling: one GET every 1.5 s while the sheet is open.
  const before = daemonRequests('GET', '/login');
  await page.waitForTimeout(3300);
  const polls = daemonRequests('GET', '/login') - before;
  assert.ok(polls >= 2 && polls <= 4, `consulta o login a cada ~1,5 s (${polls} em 3,3 s)`);
  await shotBoth('04-login-link');

  // A wrong code fails the login: the reason, and the output (folded) with the code masked.
  const code = login.locator('[data-slot="login-code"]');
  await code.fill('wrong');
  await login.getByRole('button', { name: 'Enviar', exact: true }).click();
  await until('login falhou', () => hasCount(login.getByText('O login falhou (código 1)')), 30_000);
  assert.equal(await hasCount(login.locator('[data-slot="login-code"]')), false, 'sem campo de código depois da falha');
  const output = login.locator('[data-slot="login-output"]');
  assert.equal(await output.evaluate((node) => node.open), false, 'a saída começa recolhida');
  await output.locator('summary').click();
  const outputText = await output.locator('pre').innerText();
  assert.match(outputText, /Paste code here if prompted/, 'a saída mostra o que o login imprimiu');
  assert.match(outputText, /invalid code: ••••/, 'o código colado aparece mascarado');
  assert.doesNotMatch(outputText, /wrong/, 'o código nunca volta na saída');
  assert.match(await output.locator('pre').evaluate((node) => getComputedStyle(node).fontFamily), /mono/i, 'saída em fonte monoespaçada');
  await shotBoth('05-login-falha');

  // Failed: polling stopped and "Fechar" closes.
  const stopped = daemonRequests('GET', '/login');
  await page.waitForTimeout(3300);
  assert.equal(daemonRequests('GET', '/login'), stopped, 'depois do fim do login não consulta mais');
  await login.getByRole('button', { name: 'Fechar', exact: true }).click();
  await login.waitFor({ state: 'hidden' });

  await until('conta nova listada', async () => (await rows().count()) === 2);
  const workId = await accountIdOf('Trabalho');
  const text = await rowOf(workId).innerText();
  assert.match(text, /Deslogado/, 'a conta nova começa deslogada');
  assert.doesNotMatch(text, /Em uso/, 'conta nova não está em uso');
  log('Adicionar conta: nome validado, login com link/código, falha com saída mascarada, polling parado');
  return workId;
}

async function stepCancelThenLogin(workId) {
  // Cancelar sends DELETE and closes.
  let sheet = await openActions(workId);
  assert.deepEqual(await itemTexts(sheet), ['Usar em novas sessões', 'Entrar', 'Renomear', 'Remover'], 'ações de uma conta extra');
  await pickAction(sheet, 'Entrar');
  let login = dialog('Entrar na conta');
  await login.locator('[data-slot="login-link"]').waitFor({ timeout: 30_000 });
  const deletesBefore = daemonRequests('DELETE', '/login');
  await login.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await login.waitFor({ state: 'hidden' });
  assert.equal(daemonRequests('DELETE', '/login'), deletesBefore + 1, 'Cancelar envia um DELETE do login');
  assert.match(await rowOf(workId).innerText(), /Deslogado/, 'cancelar não conecta a conta');

  // The right code connects the account; the sheet shows the success and closes by itself.
  sheet = await openActions(workId);
  await pickAction(sheet, 'Entrar');
  login = dialog('Entrar na conta');
  await login.locator('[data-slot="login-link"]').waitFor({ timeout: 30_000 });
  await login.locator('[data-slot="login-code"]').fill('  abc#123 ');
  const codePosts = daemonRequests('POST', '/login/code');
  await login.getByRole('button', { name: 'Enviar', exact: true }).click();
  await until('conta conectada', () => hasCount(login.getByText(`Conta conectada: ${WORK_EMAIL}`)), 30_000);
  assert.equal(daemonRequests('POST', '/login/code'), codePosts + 1, 'um POST com o código');
  await shot('06-login-sucesso-escuro');
  await login.waitFor({ state: 'hidden', timeout: 10_000 });
  await until('lista atualizada', async () => (await rowOf(workId).innerText()).includes(WORK_EMAIL));
  assert.doesNotMatch(await rowOf(workId).innerText(), /Deslogado/, 'a conta aparece conectada');
  log('Cancelar envia DELETE; o código certo conecta, fecha a folha e atualiza a lista');
}

async function stepRenameAndUse(workId) {
  // Rename there and back.
  let sheet = await openActions(workId);
  await pickAction(sheet, 'Renomear');
  let rename = dialog('Renomear conta');
  await rename.waitFor();
  await page.waitForTimeout(450);
  assert.equal(await rename.locator('#entry-name').inputValue(), 'Trabalho', 'o nome atual vem preenchido');
  assert.equal(await rename.getByRole('button', { name: 'Salvar', exact: true }).isDisabled(), true, 'Salvar espera uma mudança');
  await rename.locator('#entry-name').fill('Trabalho 2');
  await rename.getByRole('button', { name: 'Salvar', exact: true }).click();
  await rename.waitFor({ state: 'hidden' });
  await until('nome novo na lista', async () => (await rowOf(workId).innerText()).includes('Trabalho 2'));

  sheet = await openActions(workId);
  await pickAction(sheet, 'Renomear');
  rename = dialog('Renomear conta');
  await rename.waitFor();
  await page.waitForTimeout(450);
  await rename.locator('#entry-name').fill('Trabalho');
  await rename.getByRole('button', { name: 'Salvar', exact: true }).click();
  await rename.waitFor({ state: 'hidden' });
  await until('nome de volta', async () => !(await rowOf(workId).innerText()).includes('Trabalho 2'));

  // Use for new sessions: the badge moves.
  sheet = await openActions(workId);
  await pickAction(sheet, 'Usar em novas sessões');
  await until('Trabalho em uso', async () => (await rowOf(workId).getAttribute('data-active')) === 'true');
  assert.equal(await rowOf('default').getAttribute('data-active'), 'false', 'a principal deixa de estar em uso');
  assert.equal(await rowOf(workId).locator('[data-slot="badge"]', { hasText: 'Em uso' }).count(), 1, 'selo "Em uso" na conta nova');
  assert.equal(await rowOf('default').locator('[data-slot="badge"]').count(), 0, 'sem selo na principal');
  assert.equal(daemonRequests('PUT', '/accounts/active'), 1, 'um PUT da conta ativa');
  await shotBoth('07-ajustes-duas-contas');
  log('Renomear (ida e volta) e "Usar em novas sessões" movem o selo "Em uso"');
}

async function stepNewSession(workId) {
  await openProjSessions();
  await button('Nova sessão').click();
  const sheet = dialog('Nova sessão');
  await sheet.waitFor();
  // The daemon adds its default agents to the config, and the first one is not Claude Code.
  await sheet.locator('button[aria-pressed]', { hasText: 'Claude Code' }).click();
  const select = sheet.locator('[data-slot="account-select"] select');
  await until('seletor de conta na nova sessão', () => hasCount(select), 30_000);
  assert.equal(await select.inputValue(), workId, 'a conta ativa vem escolhida');
  assert.deepEqual(
    await select.locator('option').evaluateAll((nodes) => nodes.map((node) => node.textContent)),
    ['Principal', 'Trabalho'],
    'uma opção por conta',
  );
  assert.match(await sheet.locator('[data-slot="account-select"]').innerText(), new RegExp(WORK_EMAIL), 'e-mail da conta escolhida');

  // An agent without accounts has no "Conta" row.
  await sheet.locator('button[aria-pressed]', { hasText: 'Sem contas' }).click();
  await until('sem seletor de conta', async () => (await sheet.locator('[data-slot="account-select"]').count()) === 0, 5_000);
  await sheet.locator('button[aria-pressed]', { hasText: 'Claude Code' }).click();
  await select.waitFor();
  assert.equal(await select.inputValue(), workId, 'a escolha continua a conta ativa');
  await page.waitForTimeout(450);
  await shotBoth('08-nova-sessao-conta');

  await button('Criar sessão').click();
  await until('chat ocioso', () => hasCount(page.getByPlaceholder('Mensagem')), 60_000);
  await until('env do agente gravado', async () => envFiles().length === 1, 30_000);
  sessionEnvFile = envFiles()[0];
  const env = agentEnv();
  const expected = join(home, 'accounts', 'claude', workId);
  assert.equal(env.CLAUDE_CONFIG_DIR, expected, 'o agente da sessão recebeu a pasta da conta');
  assert.ok(existsSync(join(expected, 'projects')), 'a pasta da conta tem os diretórios compartilhados com a principal');
  log(`Nova sessão: seletor "Conta" na conta ativa, sem seletor no agente sem contas; o agente recebeu ${expected}`);
}

async function sendPrompt(text) {
  await page.getByPlaceholder('Mensagem').fill(text);
  await button('Enviar').click();
}

/** Opens "Configurar sessão" and returns its dialog. */
async function openConfig() {
  await button('Configurar sessão').click();
  const sheet = dialog('Configurar sessão');
  await sheet.waitFor();
  await page.waitForTimeout(450);
  return sheet;
}

async function closeSheet(sheet) {
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
}

async function stepUsageHeader(label, email) {
  if ((await button('Uso do agente').count()) === 0) {
    await page.getByRole('button', { name: 'Mais ações da sessão', exact: true }).click();
    await page.locator('[data-slot="action-sheet-item"]', { hasText: 'Uso do agente' }).click();
  } else {
    await button('Uso do agente').click();
  }
  const usage = dialog('Uso do Claude Code');
  await usage.waitFor();
  const line = usage.locator('[data-slot="usage-account"]');
  await line.waitFor({ timeout: 30_000 });
  const text = await line.innerText();
  assert.ok(text.includes(`Conta: ${label}`), `cabeçalho da folha de uso: ${text}`);
  assert.ok(text.includes(email), `e-mail no cabeçalho da folha de uso: ${text}`);
  await page.waitForTimeout(400);
  await shotBoth(`09-uso-conta-${label.toLowerCase()}`);
  await closeSheet(usage);
}

async function stepLockWhileRunning(workId) {
  await stepUsageHeader('Trabalho', WORK_EMAIL);

  await sendPrompt('slow');
  await until('agente trabalhando', () => hasCount(page.getByText('Trabalhando…')), 30_000);
  const sheet = await openConfig();
  const row = sheet.locator('[data-slot="account-select"]');
  await row.waitFor({ timeout: 30_000 });
  assert.equal(await row.locator('select').isDisabled(), true, 'a troca de conta trava enquanto o agente trabalha');
  assert.ok(await hasCount(sheet.getByText('Troque quando o agente terminar', { exact: true })), 'dica da trava');
  assert.equal(await row.locator('select').inputValue(), workId, 'a conta atual continua escolhida');
  await shotBoth('10-config-conta-travada');
  await closeSheet(sheet);

  await button('Parar').click();
  await until('agente ocioso de novo', () => hasCount(page.getByPlaceholder('Mensagem')), 30_000);
  log('A folha de configuração trava o seletor com a dica enquanto o agente trabalha');
}

async function stepRemoveBlocked(workId) {
  // The idle session still holds the account (its process uses the folder): removing is refused with the reason.
  await openSettings();
  const sheet = await openActions(workId);
  await pickAction(sheet, 'Remover');
  const confirm = dialog('Remover conta');
  await confirm.waitFor();
  await page.waitForTimeout(450);
  const text = await confirm.innerText();
  assert.ok(text.includes('Remover "Trabalho" de Claude Code?'), `texto da confirmação: ${text}`);
  assert.ok(text.includes('as sessões que a usavam voltam para a conta principal'), 'o texto diz o que acontece com as sessões');
  assert.ok(await touchHeight(confirm.getByRole('button', { name: 'Remover', exact: true })) >= 44, 'Remover com 44px ou mais');
  await confirm.getByRole('button', { name: 'Remover', exact: true }).click();
  await until('recusa por sessão em uso', () => hasCount(confirm.getByText('Uma sessão está trabalhando nesta conta. Espere terminar e tente de novo.')), 20_000);
  await shot('11-remover-bloqueado-escuro');
  await confirm.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.ok(await hasCount(rowOf(workId)), 'a conta continua listada');
  log('Remover com sessão ocupando a conta: 409 mostrado na folha, a conta continua');
}

async function stepSwitchAccount(workId) {
  await goHome();
  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await headerTitle('Workspaces').waitFor();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().click();
  await page.locator('ul[aria-label="Sessões"] > li').first().locator('button', { hasText: 'Claude Code' }).first().click();
  await until('chat aberto', () => hasCount(page.getByPlaceholder('Mensagem')), 30_000);

  const sheet = await openConfig();
  const select = sheet.locator('[data-slot="account-select"] select');
  await select.waitFor({ timeout: 30_000 });
  assert.equal(await select.isDisabled(), false, 'ocioso: a troca é permitida');
  assert.equal(await select.inputValue(), workId, 'a sessão está na conta Trabalho');
  const puts = daemonRequests('PUT', '/account');
  await select.selectOption('default');

  await until('linha de troca no chat', async () => (await hasCount(page.locator('[data-slot="account-changed"]'))), 60_000);
  await closeSheet(sheet).catch(() => undefined);
  const line = page.locator('[data-slot="account-changed"]');
  assert.equal((await line.innerText()).trim(), 'Conta trocada para Principal', 'texto da linha de troca');
  assert.equal(daemonRequests('PUT', '/account'), puts + 1, 'um PUT da conta da sessão');
  const align = await line.evaluate((node) => ({ text: getComputedStyle(node).textAlign, self: getComputedStyle(node).alignSelf }));
  assert.equal(align.text, 'center', 'linha centralizada');
  await until('agente reiniciado com a pasta principal', async () => agentEnv().CLAUDE_CONFIG_DIR === principalHome, 60_000);
  await until('sessão pronta de novo', () => hasCount(page.getByPlaceholder('Mensagem')), 60_000);
  await shotBoth('12-chat-conta-trocada');

  // The session is on the principal now: the usage header says so and the sheet shows the principal.
  await stepUsageHeader('Principal', PRINCIPAL_EMAIL);
  const config = await openConfig();
  assert.equal(await config.locator('[data-slot="account-select"] select').inputValue(), 'default', 'a folha mostra a Principal');
  await closeSheet(config);
  log('Trocar a conta: linha "Conta trocada para Principal", agente reiniciado na pasta principal, uso e folha em dia');
}

async function stepRemoveAccount(workId) {
  await openSettings();
  assert.equal(await rowOf('default').getAttribute('data-active'), 'false', 'a principal ainda não é a conta em uso');
  const sheet = await openActions(workId);
  await pickAction(sheet, 'Remover');
  const confirm = dialog('Remover conta');
  await confirm.waitFor();
  await page.waitForTimeout(450);
  await shotBoth('13-remover-conta');

  // Cancelar keeps it.
  const deletes = daemonRequests('DELETE', `/accounts/${workId}`);
  await confirm.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(daemonRequests('DELETE', `/accounts/${workId}`), deletes, 'Cancelar não remove');
  assert.ok(await hasCount(rowOf(workId)), 'a conta continua depois de Cancelar');

  // Remover removes it, and the principal is the account in use again.
  const again = await openActions(workId);
  await pickAction(again, 'Remover');
  const sure = dialog('Remover conta');
  await sure.waitFor();
  await page.waitForTimeout(450);
  await sure.getByRole('button', { name: 'Remover', exact: true }).click();
  await sure.waitFor({ state: 'hidden', timeout: 20_000 });
  await until('conta removida da lista', async () => (await rows().count()) === 1);
  assert.equal(daemonRequests('DELETE', `/accounts/${workId}`), deletes + 1, 'um DELETE da conta');
  assert.equal(await rowOf('default').getAttribute('data-active'), 'true', 'a principal volta a ser a conta em uso');
  assert.ok(!existsSync(join(home, 'accounts', 'claude', workId)), 'a pasta da conta foi apagada');
  assert.ok(existsSync(join(principalHome, 'e2e-login.json')), 'a pasta principal continua intacta');
  await shotBoth('14-ajustes-depois-de-remover');
  log('Remover: confirmação, Cancelar não remove, Remover apaga a conta e a pasta; a Principal volta a ser a conta em uso');
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
  await setTheme('dark');
  await stepSettingsBeforeAccounts();
  const workId = await stepAddAccountAndFailLogin();
  await stepCancelThenLogin(workId);
  await stepRenameAndUse(workId);
  await stepNewSession(workId);
  await stepLockWhileRunning(workId);
  await stepRemoveBlocked(workId);
  await stepSwitchAccount(workId);
  await stepRemoveAccount(workId);
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  // The only console error is the browser's own line for the 409 the blocked removal provoked on purpose.
  const conflicts = consoleErrors.filter((line) => line.includes('status of 409'));
  assert.equal(conflicts.length, 1, 'um único 409 no console (a remoção recusada)');
  assert.deepEqual(
    consoleErrors.filter((line) => !line.includes('status of 409')),
    [],
    'console do navegador sem outros erros',
  );
  log('fluxo de várias contas por agente OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2eacc] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
