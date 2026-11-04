/*
 * E2E de "Retomar do PC": sessões criadas fora do app (o agente lista em session/list) viram sessões do app.
 * Cobre: folha com agentes de chat (agente sem listagem mostra "Este agente não lista sessões"), listagem com
 * "Carregar mais" (página de 2), importação com o histórico no chat, selo "já no app" ao listar de novo, 409
 * already_running abrindo a sessão existente, 409 already_linked (sessão parada) abrindo para retomar, e título
 * "Sessão de <data e hora>" para sessão sem título, e "Remover do app" (swipe + confirmação): a sessão some da lista,
 * volta em Retomar do PC sem selo "já no app" e importar de novo cria uma sessão nova; o agente não recebe delete nem
 * close. Dirige o PWA buildado num Edge headless, viewport de iPhone 14
 * (390x844). O agente é o fake (packages/daemon/test/fixtures/fake-agent.ts) com FAKE_AGENT_STORE.
 *
 * Como rodar (a partir da raiz, depois de `npm run build`):
 *   npm run e2e:resume
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, porta 7796 livre. Tudo fica em
 * $TEMP/nanachi-e2eresume-<rand> (NANACHI_HOME, pasta do workspace, pids, store do agente, log) e é apagado no fim.
 * Screenshots: e2e/screenshots/resume/ (cada tela nos dois temas: <nome>-light.png e <nome>-dark.png).
 * Variável opcional: E2E_BROWSER_CHANNEL (default msedge).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(here, 'screenshots', 'resume');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7796;
const base = `http://127.0.0.1:${PORT}`;
const NAME = 'e2e-retomar';
const WORKSPACE_NAME = 'proj';
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2eresume] ${line}`);

const root = join(tmpdir(), `nanachi-e2eresume-${randomBytes(4).toString('hex')}`);
const home = join(root, 'home');
const rootDir = join(root, 'raiz');
const projDir = join(rootDir, 'proj');
const pidsDir = join(root, 'pids');
const storePath = join(root, 'sessoes-do-agente.json');
const logPath = join(root, 'daemon.log');

const TITLED_A = 'Revisar testes do parser';
const TITLED_C = 'Migrar config para zod';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const daemons = [];
let browser = null;
let page = null;
let token = '';
let workspaceId = '';
let untitledLabel = '';
const dialogs = [];
const consoleErrors = [];
const cspViolations = [];
const failedRequests = [];
const httpErrors = [];
/** 409 esperados: dois (já aberta, e já ligada mas parada). Qualquer outro 4xx/5xx é erro. */
let expectedConflicts = 0;

// ---------- processos ----------

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* já morreu */
    }
  }
}

async function isAlive() {
  try {
    const res = await fetch(`${base}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function writeStore(cwd) {
  const now = Date.now();
  const sessions = [
    {
      sessionId: 'acp-a',
      cwd,
      title: TITLED_A,
      updatedAt: new Date(now - 2 * HOUR).toISOString(),
      history: [
        { role: 'user', text: 'Quais testes faltam?' },
        { role: 'agent', text: 'Faltam os testes de borda do tokenizer.' },
      ],
    },
    {
      sessionId: 'acp-b',
      cwd,
      title: null,
      updatedAt: new Date(now - 26 * HOUR).toISOString(),
      history: [
        { role: 'user', text: 'Ajuda com o build.' },
        { role: 'agent', text: 'Feito.' },
      ],
    },
    {
      sessionId: 'acp-c',
      cwd,
      title: TITLED_C,
      updatedAt: new Date(now - 5 * DAY).toISOString(),
      history: [],
    },
  ];
  writeFileSync(storePath, JSON.stringify(sessions));
  // Mesmo formato de "Sessão de <data e hora>" que o PWA mostra (relógio local deste PC).
  const date = new Date(now - 26 * HOUR);
  const pad = (value) => String(value).padStart(2, '0');
  untitledLabel = `Sessão de ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} às ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function writeConfig() {
  mkdirSync(home, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: NAME,
    allowedRoots: [rootDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      fake: {
        label: 'Fake',
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        env: { FAKE_AGENT_PID_DIR: pidsDir, FAKE_AGENT_STORE: storePath, FAKE_AGENT_PAGE_SIZE: '2' },
        kind: 'acp',
      },
      semlista: {
        label: 'Sem listagem',
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        env: { FAKE_AGENT_PID_DIR: pidsDir, FAKE_AGENT_LIST: 'none' },
        kind: 'acp',
      },
    },
  };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function startDaemon() {
  if (await isAlive()) throw new Error(`${base} já responde: mate o processo que ocupa a porta antes`);
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [daemonMain], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  daemons.push({ child });
  const deadline = Date.now() + 20_000;
  while (!(await isAlive())) {
    if (Date.now() > deadline) throw new Error(`daemon não respondeu. Log: ${tailLog()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  log(`daemon no ar em ${base} (home ${home})`);
}

function tailLog() {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(sem log)';
}

function issuePairCode() {
  const out = execFileSync(process.execPath, [daemonCli, 'pair'], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    encoding: 'utf8',
  });
  const match = /(\d{6})/.exec(out);
  if (match === null) throw new Error('código de pareamento não encontrado');
  return match[1];
}

// ---------- API direta ----------

async function apiFetch(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { ...init, headers });
}

async function apiJson(path) {
  const res = await apiFetch(path);
  assert.equal(res.status, 200, `GET ${path} → ${res.status}`);
  return res.json();
}

async function sessionsApi() {
  const { sessions } = await apiJson(`/api/workspaces/${workspaceId}/sessions`);
  return sessions;
}

async function sessionTitled(title) {
  const found = (await sessionsApi()).find((session) => session.title === title);
  assert.ok(found, `sessão "${title}" existe no daemon`);
  return found;
}

// ---------- helpers de página ----------

/** Captura a tela nos dois temas (o PWA segue prefers-color-scheme). */
async function shot(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  log(`screenshot ${name} (claro e escuro)`);
}

/** Espera até `check` ser verdadeiro. Em falha, tira screenshot e lança erro. */
async function until(description, check, timeout = 20_000) {
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

const button = (name) => page.getByRole('button', { name, exact: true });
const headerTitle = (text) => page.locator('.app-title', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const sheet = () => page.getByRole('dialog', { name: 'Retomar do PC' });
const sheetItem = (title) => sheet().locator('.item-main', { hasText: title });
const sheetItems = () => sheet().locator('.item-main');
const chatHasText = (text) => page.locator('body').innerText().then((body) => body.includes(text));

/** Volta pelo "Voltar" até o cabeçalho com o título dado. */
async function backTo(title) {
  for (let step = 0; step < 8; step += 1) {
    if (await hasCount(headerTitle(title))) return;
    if (await hasCount(button('Voltar'))) await button('Voltar').click();
    await page.waitForTimeout(200);
  }
  await until(`cabeçalho ${title}`, () => hasCount(headerTitle(title)));
}

/** Da home da máquina até a tela de sessões do workspace de teste. */
async function openProject() {
  for (let step = 0; step < 8; step += 1) {
    if (await hasCount(page.locator('.status-card'))) break;
    if (await hasCount(button('Voltar'))) await button('Voltar').click();
    await page.waitForTimeout(150);
  }
  await button('Workspaces').click();
  await page.locator('.item-main', { hasText: WORKSPACE_NAME }).first().click();
  await button('Retomar do PC').waitFor();
}

async function openSheetWith(agentLabel) {
  await button('Retomar do PC').click();
  await sheet().waitFor();
  await page.locator('.agent-choice', { hasText: agentLabel }).click();
}

// ---------- fluxo ----------

async function pairApp() {
  await page.goto(base, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport precisa ser 390x844');
  await page.fill('input[placeholder="000000"]', issuePairCode());
  await button('Parear').click();
  await until('status online na home', () => hasCount(page.locator('.status-card.status-online')));
  token = await page.evaluate(() => JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]')[0]?.token ?? '');
  assert.ok(token.length > 0, 'token do PC salvo no PWA');
}

async function createWorkspace() {
  const res = await apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projDir }),
  });
  assert.equal(res.status, 201, `POST /api/workspaces → ${res.status}`);
  workspaceId = (await res.json()).id;
}

/** Folha: agente sem listagem, depois o fake com a primeira página de 2 e "Carregar mais". */
async function stepListing() {
  await openProject();
  await openSheetWith('Sem listagem');
  await until('agente sem listagem avisa', () => hasCount(sheet().getByText('Este agente não lista sessões.')));

  await page.locator('.agent-choice', { hasText: 'Fake' }).click();
  await until('primeira página com 2 sessões', async () => (await sheetItems().count()) === 2);
  assert.equal(await sheetItem(TITLED_A).count(), 1, 'sessão com título aparece com o título');
  const untitled = sheetItem(untitledLabel);
  assert.equal(await untitled.count(), 1, `sessão sem título aparece como "${untitledLabel}"`);
  assert.equal(await sheet().locator('.chip', { hasText: 'já no app' }).count(), 0, 'nada "já no app" antes de importar');
  await shot('01-folha-lista');

  await button('Carregar mais').click();
  await until('terceira sessão depois de Carregar mais', async () => (await sheetItems().count()) === 3);
  assert.equal(await sheetItem(TITLED_C).count(), 1, 'sessão da segunda página entra na lista');
  assert.equal(await button('Carregar mais').count(), 0, 'sem Carregar mais no fim da lista');
  await shot('02-carregar-mais');
  log('listagem: agente sem listagem, página de 2, Carregar mais, sem título com data');
}

/** Importar a sessão com título: o histórico do fake aparece no chat. */
async function stepImport() {
  await sheetItem(TITLED_A).click();
  await until('chat da sessão importada', () => hasCount(headerTitle(TITLED_A)));
  await until('histórico importado no chat', () => chatHasText('Faltam os testes de borda do tokenizer.'));
  assert.ok(await chatHasText('Quais testes faltam?'), 'mensagem do usuário do histórico aparece');
  const session = await sessionTitled(TITLED_A);
  assert.equal(session.agent, 'fake', 'sessão importada usa o agente escolhido');
  assert.equal(session.status, 'idle', 'sessão importada fica pronta');
  const { events } = await apiJson(`/api/sessions/${session.id}/events?after=0&limit=500`);
  assert.ok(
    events.some((event) => event.kind === 'user_message' && event.text === 'Quais testes faltam?'),
    'histórico gravado como eventos no daemon',
  );
  await shot('03-chat-importado');
  log('importação: histórico do agente aparece no chat e fica gravado');
}

/** Listar de novo: a sessão já importada aparece com "já no app"; a outra não. */
async function stepAlreadyInApp() {
  await backTo(WORKSPACE_NAME);
  await openSheetWith('Fake');
  await until('sessão importada com selo "já no app"', () =>
    hasCount(sheetItem(TITLED_A).locator('.chip', { hasText: 'já no app' })),
  );
  assert.equal(await sheetItem(untitledLabel).locator('.chip').count(), 0, 'sessão não importada sem selo');
  await shot('04-ja-no-app');
  log('listagem de novo: selo "já no app" na sessão importada');
}

/** Tocar numa sessão já aberta no app: 409 already_running, o app abre a existente (sem criar outra). */
async function stepConflictOpensExisting() {
  const before = await sessionsApi();
  const existing = before.find((session) => session.title === TITLED_A);
  assert.ok(existing, 'sessão importada existe antes do 409');
  await sheetItem(TITLED_A).click();
  expectedConflicts += 1;
  await until('chat da sessão existente', () => hasCount(headerTitle(TITLED_A)));
  await until('histórico único (sem reimportar)', () => chatHasText('Faltam os testes de borda do tokenizer.'));
  const after = await sessionsApi();
  assert.equal(after.length, before.length, 'o 409 não cria sessão nova');
  assert.equal(after.find((session) => session.title === TITLED_A)?.id, existing.id, 'abre a mesma sessão');
  log('409 already_running: abriu a sessão existente, nenhuma nova');
}

/** Sessão parada: 409 already_linked também abre a existente (com Retomar, histórico só leitura). */
async function stepConflictStopped() {
  const existing = await sessionTitled(TITLED_A);
  const res = await apiFetch(`/api/sessions/${existing.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204, 'parar a sessão pela API');
  await until('sessão parada no daemon', async () => (await sessionTitled(TITLED_A)).status === 'stopped');

  await backTo(WORKSPACE_NAME);
  await openSheetWith('Fake');
  await sheetItem(TITLED_A).click();
  expectedConflicts += 1;
  await until('chat da sessão parada', () => hasCount(button('Retomar')));
  assert.equal((await sessionsApi()).length, 1, 'o 409 não cria sessão nova (continua só a sessão A)');
  log('409 already_linked: abriu a sessão parada, com Retomar');
}

/** Texto da confirmação de "Remover do app" para um agente com este rótulo (ver sessionRemoval.ts). */
const removalText = (label) =>
  `Remover esta sessão do app? O histórico continua no ${label} e você pode trazê-la de volta em Retomar do PC.`;

/**
 * Remover do app pela UI (swipe na linha, depois confirmação), listar de novo e importar de novo.
 * Sessão parada: a confirmação não avisa interrupção. Depois de remover, o fake não pode ter recebido delete/close.
 */
async function stepRemoveAndReimport() {
  const removed = await sessionTitled(TITLED_A);
  await backTo(WORKSPACE_NAME);

  const row = page.locator('.swipe-row', { has: page.locator('.item-main', { hasText: TITLED_A }) });
  const track = row.locator('.swipe-track');
  await track.waitFor();
  const box = await track.boundingBox();
  assert.ok(box !== null, 'linha da sessão visível');
  await row.locator('button[aria-haspopup="menu"]').click();
  const listMenu = page.getByRole('menu', { name: /Mais ações de/ });
  await listMenu.waitFor();
  const menuBox = await listMenu.boundingBox();
  assert.ok(
    menuBox !== null && menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 390 && menuBox.y + menuBox.height <= 844,
    'menu "…" da lista aparece dentro da tela',
  );
  await shot('10-menu-da-lista');
  await page.keyboard.press('Escape');
  await until('menu da lista fecha com Esc', async () => (await page.getByRole('menu').count()) === 0);

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 24, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 170, y, { steps: 10 });
  await page.mouse.up();
  await until('linha deslizada revela a ação', async () => (await track.getAttribute('style')) === 'transform: translateX(-96px);');
  await shot('06-swipe-remover-do-app');

  await row.locator('.swipe-action', { hasText: 'Remover do app' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remover do app' });
  await dialog.waitFor();
  assert.equal(await dialog.getByText(removalText('Fake'), { exact: true }).count(), 1, 'texto da confirmação');
  assert.equal(await dialog.getByText('Remover agora interrompe', { exact: false }).count(), 0, 'sessão parada não avisa');
  await shot('07-confirmacao-remover-do-app');

  await dialog.getByRole('button', { name: 'Remover', exact: true }).click();
  await until('folha de confirmação fecha', async () => (await dialog.count()) === 0);
  await until('sessão sumiu da lista sem recarregar', async () => (await page.locator('.item-main', { hasText: TITLED_A }).count()) === 0);
  assert.equal((await sessionsApi()).some((session) => session.id === removed.id), false, 'sessão apagada do daemon');
  const methods = existsSync(join(pidsDir, `${removed.id}.methods.jsonl`))
    ? readFileSync(join(pidsDir, `${removed.id}.methods.jsonl`), 'utf8')
    : '';
  assert.ok(methods.includes('"session/load"'), 'o fake registrou o session/load da importação');
  assert.ok(!methods.includes('"session/delete"') && !methods.includes('"session/close"'), 'agente não recebeu delete/close');

  await openSheetWith('Fake');
  await until('sessão removida volta em Retomar do PC', () => hasCount(sheetItem(TITLED_A)));
  assert.equal(await sheetItem(TITLED_A).locator('.chip', { hasText: 'já no app' }).count(), 0, 'sem selo "já no app"');
  await shot('08-retomar-sem-selo');

  await sheetItem(TITLED_A).click();
  await until('chat da sessão importada de novo', () => hasCount(headerTitle(TITLED_A)));
  await until('histórico importado de novo', () => chatHasText('Faltam os testes de borda do tokenizer.'));
  const again = await sessionTitled(TITLED_A);
  assert.notEqual(again.id, removed.id, 'importar de novo cria uma sessão nova');
  assert.equal(again.status, 'idle', 'sessão reimportada fica pronta');

  await page.getByRole('button', { name: 'Mais ações da sessão' }).click();
  await until('menu da sessão tem Remover do app', () => hasCount(page.getByRole('menuitem', { name: 'Remover do app' })));
  await shot('09-menu-da-sessao');
  await page.keyboard.press('Escape');
  await until('menu fecha com Esc', async () => (await page.getByRole('menu').count()) === 0);
  log('remover do app: swipe, confirmação, sumiu da lista, volta em Retomar do PC sem selo e importa de novo');
}

/** Sessão sem título: o título no app é o mesmo texto que a lista mostra. */
async function stepUntitled() {
  await backTo(WORKSPACE_NAME);
  await openSheetWith('Fake');
  await sheetItem(untitledLabel).click();
  await until('chat da sessão sem título', () => hasCount(headerTitle(untitledLabel)));
  const session = await sessionTitled(untitledLabel);
  assert.equal(session.title, untitledLabel, 'título da sessão importada = texto da lista');
  await shot('05-chat-sem-titulo');
  log(`sessão sem título importada como "${untitledLabel}"`);
}

/** Depois de tudo: só as duas sessões importadas existem no daemon (nenhum 409 criou duplicata). */
async function checkNoDuplicates() {
  const sessions = await sessionsApi();
  const titles = sessions.map((session) => session.title).sort();
  assert.deepEqual(titles, [TITLED_A, untitledLabel].sort(), 'duas sessões no total, sem duplicata');
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  for (const file of readdirSync(shotsDir)) rmSync(join(shotsDir, file), { force: true });
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'LEIAME.txt'), 'Pasta de teste da retomada.\n');
  writeStore(realpathSync(projDir));
  writeConfig();
  await startDaemon();

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
      window.__reportCsp?.(
        `${event.violatedDirective} -> ${event.blockedURI} @ ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} sample=${event.sample}`,
      );
    });
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      // O navegador loga cada 409 esperado do fluxo; o resto é erro de verdade.
      if (/status of 409/.test(message.text())) return;
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const status = response.status();
    if (status === 409 && response.request().method() === 'POST' && path === '/api/sessions') return;
    if (status >= 400) httpErrors.push(`${status} ${response.url()}`);
  });

  await pairApp();
  await createWorkspace();
  await stepListing();
  await stepImport();
  await stepAlreadyInApp();
  await stepConflictOpensExisting();
  await stepConflictStopped();
  await stepRemoveAndReimport();
  await stepUntitled();
  await checkNoDuplicates();

  assert.equal(httpErrors.length, 0, `sem resposta de erro fora dos 409 esperados: ${httpErrors.join(' | ')}`);
  assert.deepEqual(failedRequests, [], 'sem requisição que falhou no navegador');
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  assert.equal(expectedConflicts, 2, 'dois 409 esperados no fluxo');
  assert.deepEqual(dialogs, [], 'nenhum diálogo nativo');
  log('fluxo de retomada do PC OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2eresume] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  for (const entry of daemons) killTree(entry.child.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`temporários removidos: ${root}`);
}
process.exitCode = exitCode;
