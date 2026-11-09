/*
 * E2E da fase 5 do Nanachi Remote: contexto do workspace (branch, alterações, CLAUDE.md), tela Alterações,
 * worktree separado, dispositivos (pareamento pelo CLI + API, revogar outro e revogar o próprio), terminal
 * (terminal sem barra de teclas e pill "Em execução"), lazy chunks, CORS/WS por Origin e vários PCs (dois daemons, seletor de máquinas).
 * Dirige o PWA buildado num Edge headless com viewport de iPhone 14 (390x844). Nenhum agente real: o agente é o
 * fake (packages/daemon/test/fixtures/fake-agent.ts) e o terminal é o powershell.exe.
 *
 * Como rodar (a partir da raiz, depois de `npm run build`):
 *   npm run e2e:5
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, portas 7798 e 7799 livres. Tudo fica em
 * $TEMP/nanachi-e2e5-<rand> (duas NANACHI_HOME, repositórios git temporários, worktrees, logs) e é apagado no fim.
 * Screenshots: e2e/screenshots/phase5/. Variável opcional: E2E_BROWSER_CHANNEL (default msedge).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const WebSocket = require('ws');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(here, 'screenshots', 'phase5');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT_A = 7798;
const PORT_B = 7799;
const urlA = `http://127.0.0.1:${PORT_A}`;
const urlB = `http://127.0.0.1:${PORT_B}`;
const NAME_A = 'e2e-pc-principal';
const NAME_B = 'e2e-pc-secundario';
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2e5] ${line}`);

const root = join(tmpdir(), `nanachi-e2e5-${randomBytes(4).toString('hex')}`);
const homeA = join(root, 'home-a');
const homeB = join(root, 'home-b');
const rootA = join(root, 'raiz-a');
const rootB = join(root, 'raiz-b');
const repoA = join(rootA, 'proj');
const dirB = join(rootB, 'proj-b');
const pidsA = join(root, 'pids-a');
const pidsB = join(root, 'pids-b');
const logA = join(root, 'daemon-a.log');
const logB = join(root, 'daemon-b.log');

const daemons = [];
let browser = null;
let page = null;
let tokenA = '';
let tokenB = '';
let revokedSelf = false;
const dialogs = [];
const consoleErrors = [];
const cspViolations = [];
const failedRequests = [];
const httpErrors = [];
const lazyChunks = [];

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

async function isAlive(url) {
  try {
    const res = await fetch(`${url}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function writeConfig(home, { port, machineName, rootDir, pidDir, corsOrigins }) {
  mkdirSync(home, { recursive: true });
  const config = {
    port,
    host: '127.0.0.1',
    machineName,
    allowedRoots: [rootDir],
    allowedTailscaleLogins: [],
    corsOrigins,
    agents: {
      fake: {
        label: 'Fake',
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        env: { FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_PROMPT_IMAGE: '1' },
        kind: 'acp',
      },
      shell: {
        label: 'Shell',
        kind: 'pty',
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile'],
        env: {},
      },
    },
  };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function startDaemon(name, home, url, logPath) {
  if (await isAlive(url)) throw new Error(`${url} já responde: mate o processo que ocupa a porta antes`);
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [daemonMain], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  const entry = { name, child, home, logPath };
  daemons.push(entry);
  const deadline = Date.now() + 20_000;
  while (!(await isAlive(url))) {
    if (Date.now() > deadline) throw new Error(`daemon ${name} não respondeu. Log: ${tailLog(logPath)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  log(`daemon ${name} no ar em ${url} (home ${home})`);
  return entry;
}

function tailLog(logPath) {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(sem log)';
}

function cli(home, args) {
  return execFileSync(process.execPath, [daemonCli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, NANACHI_HOME: home },
    encoding: 'utf8',
  });
}

function issuePairCode(home) {
  const match = /(\d{6})/.exec(cli(home, ['pair']));
  if (match === null) throw new Error('código de pareamento não encontrado');
  return match[1];
}

// ---------- git e arquivos ----------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Repo git com 1 commit, uma alteração rastreada (README) e um arquivo não rastreado (notas.txt). */
function setupRepoA() {
  mkdirSync(repoA, { recursive: true });
  git(repoA, ['init', '-b', 'main']);
  writeFileSync(join(repoA, 'README.md'), '# Projeto de teste\n\nPrimeira linha.\n');
  writeFileSync(join(repoA, 'CLAUDE.md'), '# Instruções do projeto\n\nResponda em português.\n');
  git(repoA, ['add', '-A']);
  git(repoA, ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-m', 'inicial']);
  writeFileSync(join(repoA, 'README.md'), '# Projeto de teste\n\nPrimeira linha alterada.\nSegunda linha.\n');
  writeFileSync(join(repoA, 'notas.txt'), 'Arquivo não rastreado.\n');
}

/** Pasta comum (sem git) para o PC secundário. */
function setupDirB() {
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirB, 'LEIAME.txt'), 'Pasta do PC secundário.\n');
}

/** Caminho comparável no Windows (barras, minúsculas). */
function norm(path) {
  return resolve(path).replace(/\\/g, '/').toLowerCase();
}

// ---------- API direta ----------

async function apiFetch(base, token, path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { ...init, headers });
}

async function apiJson(base, token, path) {
  const res = await apiFetch(base, token, path);
  assert.equal(res.status, 200, `GET ${path} → ${res.status}`);
  return res.json();
}

async function workspaceNamed(base, token, name) {
  const { workspaces } = await apiJson(base, token, '/api/workspaces');
  const found = workspaces.find((workspace) => basename(workspace.path) === name);
  assert.ok(found, `workspace ${name} existe em ${base}`);
  return found;
}

async function sessionsNamed(base, token, name) {
  const workspace = await workspaceNamed(base, token, name);
  const { sessions } = await apiJson(base, token, `/api/workspaces/${workspace.id}/sessions`);
  return sessions;
}

function readPrompts(pidDir, sessionId) {
  const file = join(pidDir, `${sessionId}.prompts.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function readAgentEnv(pidDir, sessionId) {
  return JSON.parse(readFileSync(join(pidDir, `${sessionId}.env.json`), 'utf8'));
}

// ---------- helpers de página ----------

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

/** Espera até `check` ser verdadeiro. Em falha, tira screenshot e lança erro. */
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
const headerTitle = (text) => page.locator('h1', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`[data-status="${status}"]`));

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

/** Volta pelo "Voltar" até a home da máquina (cartão de status). */
async function goHome() {
  for (let step = 0; step < 8; step += 1) {
    if (await hasCount(page.getByRole('region', { name: 'Estado da máquina' }))) return;
    if (await hasCount(button('Voltar'))) await button('Voltar').click();
    await page.waitForTimeout(150);
  }
  await until('home', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' })));
}

async function openWorkspace(name) {
  await goToWorkspaces();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: name }).getByRole('button').first().click();
  await button('Nova sessão').waitFor();
}

async function newSession(agentLabel, workspaceName) {
  await openWorkspace(workspaceName);
  await button('Nova sessão').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await page.locator('[role="dialog"] button[aria-pressed]', { hasText: agentLabel }).click();
  await button('Criar sessão').click();
}

/** Escolhe a pasta no seletor: entra na raiz permitida (se preciso) e depois na subpasta `name`. */
async function pickFolder(name, rootName) {
  await headerTitle('Escolher pasta').waitFor();
  const target = page.locator('ul[aria-label="Pastas"] > li button', { hasText: name }).first();
  if (!(await hasCount(target))) {
    await page.locator('ul[aria-label="Pastas"] > li button', { hasText: rootName }).first().click();
    await target.waitFor();
  }
  await target.click();
  await page.locator('h1 + p', { hasText: name }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: name }).getByRole('button').first().waitFor();
}

/** Token que o PWA guardou para a máquina com esta baseUrl. */
async function machineToken(baseUrl) {
  return page.evaluate((base) => {
    const machines = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]');
    return machines.find((machine) => machine.baseUrl === base)?.token ?? '';
  }, baseUrl);
}

async function switchMachine(name) {
  await goHome();
  await page.locator('h1 button').click();
  await page.getByRole('menuitemradio', { name }).click();
  await until(`home de ${name}`, async () => (await page.locator('h1').innerText()) === name);
}

// ---------- fluxo ----------

async function pairAppA() {
  await page.goto(urlA, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport precisa ser 390x844');
  await page.fill('input[placeholder="000000"]', issuePairCode(homeA));
  await button('Parear').click();
  await until('status online na home (PC principal)', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })));
  tokenA = await machineToken(urlA);
  assert.ok(tokenA.length > 0, 'token do PC principal salvo no PWA');
}

async function addWorkspace(name, rootName) {
  await goHome();
  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await headerTitle('Workspaces').waitFor();
  await button('Adicionar workspace').click();
  await pickFolder(name, rootName);
}

async function stepWorkspaceInfo() {
  await addWorkspace('proj', 'raiz-a');
  await openWorkspace('proj');
  const info = page.locator('ul[aria-label="Estado do workspace"]');
  await until('chips de estado do workspace', () => hasCount(info));
  const text = await info.innerText();
  // O branch sai no chip do cabeçalho (BranchSwitcher); a barra de info não repete o branch nesta tela.
  assert.ok(await hasCount(page.getByRole('button', { name: /^Branch main\./ })), 'chip do cabeçalho com o branch main');
  assert.match(text, /2 alterações/, 'chip com o número de alterações');
  assert.match(text, /CLAUDE\.md/, 'chip de instrução CLAUDE.md');
  assert.equal(await page.locator('ul[aria-label="Estado do workspace"] li', { hasText: 'AGENTS.md' }).count(), 0, 'sem chip para AGENTS.md');
  await shot('00-workspace-info');
}

async function stepChanges() {
  await newSession('Fake', 'proj');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  // Phone header: "Histórico de commits" is a row of "Mais ações da sessão". The row has no detail line, so its exact name is
  // stable. Its first row, "Árvore de trabalho" (the working tree), opens the session's uncommitted changes.
  await page.getByRole('button', { name: 'Mais ações da sessão', exact: true }).click();
  await page.getByRole('button', { name: 'Histórico de commits', exact: true }).click();
  await headerTitle('Histórico de commits').waitFor();
  await page.locator('[data-slot="working-tree-row"]').click();
  await headerTitle('Alterações').waitFor();
  await until('duas alterações listadas', async () => (await page.locator('[data-slot="change-row"]').count()) === 2);
  await shot('01-alteracoes-lista');

  const readme = page.locator('[data-slot="change-row"]', { hasText: 'README.md' });
  await readme.locator('[data-slot="change-toggle"]').click();
  const added = readme.locator('[data-slot="diff-line"][data-kind="add"]');
  const removed = readme.locator('[data-slot="diff-line"][data-kind="del"]');
  await until('patch do README com linhas coloridas', async () => (await added.count()) >= 1 && (await removed.count()) >= 1);
  const colors = await Promise.all([
    added.first().evaluate((el) => getComputedStyle(el).backgroundColor),
    removed.first().evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  assert.notEqual(colors[0], 'rgba(0, 0, 0, 0)', 'linha adicionada tem fundo colorido');
  assert.notEqual(colors[1], 'rgba(0, 0, 0, 0)', 'linha removida tem fundo colorido');
  assert.notEqual(colors[0], colors[1], 'adição e remoção com cores diferentes');
  assert.match(await readme.innerText(), /\+2/, 'contagem de adições do README');
  await shot('02-alteracoes-patch');

  const notas = page.locator('[data-slot="change-row"]', { hasText: 'notas.txt' });
  await notas.locator('[data-slot="change-toggle"]').click();
  await until('patch do arquivo não rastreado', async () => (await notas.locator('[data-slot="diff-line"][data-kind="add"]').count()) >= 1);
  assert.match(await notas.innerText(), /Novo/, 'arquivo não rastreado aparece como novo');
  log('alterações: lista e patch coloridos (README e notas.txt)');
}

async function stepWorktree() {
  await openWorkspace('proj');
  await button('Nova sessão').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await page.locator('[role="dialog"] button[aria-pressed]', { hasText: 'Fake' }).click();
  const worktreeSwitch = page.getByRole('switch', { name: /Em worktree separado/ });
  await worktreeSwitch.click();
  assert.equal(await worktreeSwitch.getAttribute('aria-checked'), 'true', 'switch "Em worktree separado" ligado antes de criar');
  await button('Criar sessão').click();
  await until('chip do branch no chat', () => hasCount(page.locator('[data-slot="session-place"]', { hasText: 'nanachi/' })), 20_000);
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);

  const session = (await sessionsNamed(urlA, tokenA, 'proj')).find((item) => item.worktree !== null);
  assert.ok(session, 'sessão com worktree na API');
  const { branch, path: worktreePath } = session.worktree;
  assert.match(branch, /^nanachi\//, 'branch do worktree');
  assert.ok(existsSync(worktreePath), 'pasta do worktree existe');
  assert.equal(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), branch, 'worktree está no branch informado');
  assert.equal(await page.locator('[data-slot="session-place"]', { hasText: branch }).count(), 1, 'chip do branch no chat');

  await until('fake gravou o env', () => existsSync(join(pidsA, `${session.id}.env.json`)));
  const env = readAgentEnv(pidsA, session.id);
  assert.equal(norm(env.cwd), norm(worktreePath), 'o fake roda no cwd do worktree');
  assert.notEqual(norm(env.cwd), norm(repoA), 'o fake não roda no checkout principal');
  await shot('03-worktree-chip');
  log(`worktree: ${branch} em ${worktreePath}; fake cwd confere`);
  return { branch, worktreePath };
}

async function stepEndWorktree({ branch, worktreePath }) {
  await button('Voltar').click();
  await button('Nova sessão').waitFor();
  const row = page.locator('li', { hasText: branch });
  await row.getByRole('button', { name: /^Encerrar / }).click();
  await until('pasta do worktree removida', async () => !existsSync(worktreePath), 20_000);
  await until('sessão encerrada na lista', () => hasCount(row.locator('[data-status="stopped"]')), 20_000);
  await until('branch do worktree apagado (mergeado)', () => git(repoA, ['branch', '--list', branch]) === '', 20_000);
  assert.ok(dialogs.includes('Remover o worktree também?'), 'pergunta "Remover o worktree também?"');
  await shot('04-worktree-removido');
}

async function stepTerminal() {
  await newSession('Shell', 'proj');
  await page.locator('[data-slot="terminal-view"] .xterm').waitFor({ timeout: 20_000 });
  await until('pill "Em execução" no terminal', () => hasCount(page.locator('[data-status="running"]', { hasText: 'Em execução' })), 20_000);

  // The screen has no special-key bar: only the terminal, the line field and Send.
  assert.equal(await page.locator('[data-slot="terminal-key"]').count(), 0, 'sem barra de teclas');
  assert.equal(await page.locator('[data-slot="terminal-line"]').count(), 1, 'linha de texto com Enviar');
  await shot('05-terminal');
  await until('terminal segue rodando', () => statusIs('running'), 10_000);
  log('terminal: sem barra de teclas; linha de texto e pill "Em execução"');
}

async function stepDevices() {
  const codeSecond = issuePairCode(homeA);
  const pairRes = await fetch(`${urlA}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeSecond, deviceName: 'Celular de teste' }),
  });
  assert.equal(pairRes.status, 200, 'pareamento do 2º device pela API');
  const second = await pairRes.json();
  assert.ok(second.token.length > 0, 'token do 2º device');

  const { devices } = await apiJson(urlA, tokenA, '/api/devices');
  assert.equal(devices.length, 2, 'API lista os dois devices');
  assert.equal(devices.filter((device) => device.current).length, 1, 'exatamente um device é o atual');
  assert.ok(cli(homeA, ['devices']).includes('Celular de teste'), 'CLI lista o 2º device');

  await goHome();
  await button('Ajustes').click();
  await headerTitle('Ajustes').waitFor();
  await page.getByRole('button', { name: /^Dispositivos desta máquina/ }).click();
  await headerTitle('Dispositivos desta máquina').waitFor();
  await until('dois dispositivos na tela', async () => (await page.locator('ul[aria-label="Dispositivos"] > li').count()) === 2);
  const list = await page.locator('ul[aria-label="Dispositivos"]').innerText();
  assert.match(list, /Celular de teste/, 'tela mostra o 2º device');
  assert.match(list, /este aparelho/, 'tela marca este aparelho');
  await shot('06-dispositivos-dois');

  await page.locator('ul[aria-label="Dispositivos"] > li', { hasText: 'Celular de teste' }).getByRole('button', { name: /^Revogar/ }).click();
  await until('2º device some da lista', async () => (await page.locator('ul[aria-label="Dispositivos"] > li', { hasText: 'Celular de teste' }).count()) === 0);
  assert.equal((await apiFetch(urlA, second.token, '/api/workspaces')).status, 401, 'token revogado não entra mais');
  assert.equal((await apiJson(urlA, tokenA, '/api/devices')).devices.length, 1, 'API lista só este device');
  await shot('07-dispositivo-revogado');
  log('dispositivos: 2º device pareado por CLI+API, visto, revogado (some e 401)');
}

async function startDaemonB() {
  mkdirSync(homeB, { recursive: true });
  const vapidA = join(homeA, 'vapid.json');
  assert.ok(existsSync(vapidA), 'o PC principal gerou vapid.json');
  copyFileSync(vapidA, join(homeB, 'vapid.json'));
  writeConfig(homeB, { port: PORT_B, machineName: NAME_B, rootDir: rootB, pidDir: pidsB, corsOrigins: [urlA] });
  return startDaemon('B (PC secundário)', homeB, urlB, logB);
}

function connectWs(url, headers) {
  return new Promise((resolveConnect) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolveConnect({ timeout: true });
    }, 5_000);
    ws.on('error', () => undefined);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolveConnect({ open: true });
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolveConnect({ open: false, status: response.statusCode });
    });
  });
}

/** CORS (preflight) e Origin do WS, dos dois lados: origem listada passa, estranha leva 403. */
async function stepSecurityHeaders() {
  const preflightB = await fetch(`${urlB}/api/pair`, {
    method: 'OPTIONS',
    headers: {
      origin: urlA,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflightB.status, 204, 'preflight de origem listada → 204');
  assert.equal(preflightB.headers.get('access-control-allow-origin'), urlA, 'ACAO ecoa a origem listada');
  assert.match(preflightB.headers.get('access-control-allow-methods') ?? '', /PATCH/, 'métodos incluem PATCH');
  assert.match(preflightB.headers.get('access-control-allow-methods') ?? '', /DELETE/, 'métodos incluem DELETE');
  assert.match(preflightB.headers.get('access-control-allow-headers') ?? '', /authorization/i, 'headers incluem Authorization');
  assert.match(preflightB.headers.get('access-control-allow-headers') ?? '', /x-file-name/i, 'headers incluem X-File-Name');
  assert.equal(preflightB.headers.get('access-control-allow-credentials'), null, 'sem credenciais no CORS');

  const preflightEvil = await fetch(`${urlB}/api/pair`, {
    method: 'OPTIONS',
    headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflightEvil.headers.get('access-control-allow-origin'), null, 'origem fora de corsOrigins não recebe ACAO');

  const preflightNoList = await fetch(`${urlA}/api/pair`, {
    method: 'OPTIONS',
    headers: { origin: urlB, 'access-control-request-method': 'POST' },
  });
  assert.equal(preflightNoList.headers.get('access-control-allow-origin'), null, 'PC sem corsOrigins não libera CORS');

  const wsA = `ws://127.0.0.1:${PORT_A}/ws?token=${tokenA}`;
  const wsB = `ws://127.0.0.1:${PORT_B}/ws?token=${tokenB}`;
  assert.deepEqual(await connectWs(wsA, { origin: 'http://evil.example' }), { open: false, status: 403 }, 'WS: Origin estranho → 403 (PC principal)');
  assert.deepEqual(await connectWs(wsA, { origin: 'null' }), { open: false, status: 403 }, 'WS: Origin "null" → 403');
  assert.deepEqual(await connectWs(wsA, { origin: urlA }), { open: true }, 'WS: a própria origem passa');
  assert.deepEqual(await connectWs(wsA, {}), { open: true }, 'WS: sem Origin (cliente não-browser) passa');
  assert.deepEqual(await connectWs(wsB, { origin: urlA }), { open: true }, 'WS: origem listada em corsOrigins passa (PC secundário)');
  assert.deepEqual(await connectWs(wsB, { origin: 'http://evil.example' }), { open: false, status: 403 }, 'WS: Origin estranho → 403 (PC secundário)');
  log('CORS preflight e Origin do WS conferem nos dois PCs');
}

/** Vários PCs: pareia o 2º pelo "+ adicionar máquina", troca no seletor, cria workspace/sessão e manda prompt. */
async function stepMultiPc() {
  setupDirB();
  const codeB = issuePairCode(homeB);
  await goHome();
  await button('Adicionar máquina').click();
  await page.getByRole('heading', { name: 'Parear máquina' }).waitFor();
  await page.locator('input[type="url"]').fill(urlB);
  await page.locator('input[placeholder="000000"]').fill(codeB);
  await page.getByLabel('Nome deste dispositivo').fill('Celular (PC secundário)');
  await button('Parear').click();
  await until('home do PC secundário online', async () =>
    (await hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true }))) && (await page.locator('h1').innerText()) === NAME_B,
  30_000);
  tokenB = await machineToken(urlB);
  assert.ok(tokenB.length > 0, 'token do PC secundário salvo no PWA');

  await stepSecurityHeaders();

  await addWorkspace('proj-b', 'raiz-b');
  await newSession('Fake', 'proj-b');
  await until('sessão fake do PC secundário ociosa', () => statusIs('idle'), 60_000);
  await page.locator('[data-slot="chat-textarea"]').fill('Olá do segundo PC');
  await button('Enviar').click();
  await until('bolha do prompt no chat', () => hasCount(page.locator('[data-slot="bubble-user"]', { hasText: 'Olá do segundo PC' })), 20_000);
  const sessionB = (await sessionsNamed(urlB, tokenB, 'proj-b'))[0];
  assert.ok(sessionB, 'sessão criada no PC secundário');
  await until('fake do PC secundário recebeu o prompt', () =>
    readPrompts(pidsB, sessionB.id).some((blocks) => blocks.some((block) => block.type === 'text' && block.text === 'Olá do segundo PC')),
  20_000);
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 60_000);
  await shot('09-pc-secundario-chat');
  log('vários PCs: workspace e sessão no PC secundário, prompt entregue ao fake');

  await goHome();
  await page.locator('h1 button').click();
  await until('os dois PCs aparecem Online no seletor', async () => (await page.locator('[role="menuitemradio"] .bg-success').count()) === 2);
  await shot('08-seletor-dois-pcs');
  await page.getByRole('menuitemradio', { name: NAME_A }).click();
  await until('voltou ao PC principal, online', async () =>
    (await page.locator('h1').innerText()) === NAME_A && (await hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true }))),
  );
  await shot('10-volta-pc-principal');
  log('vários PCs: os dois mostram Online no seletor; voltou ao PC principal');
}

/** Remove o PC secundário da app e revoga o próprio device: a app tem que voltar ao pareamento. */
async function stepRevokeSelf() {
  await switchMachine(NAME_B);
  // "Remover máquina" is a row of the "..." menu on the home screen.
  await button(`Mais ações de ${NAME_B}`).click();
  await button('Remover máquina').click();
  await until('PC secundário removido, PC principal selecionado', async () => (await page.locator('h1').innerText()) === NAME_A);

  await goHome();
  await button('Ajustes').click();
  await headerTitle('Ajustes').waitFor();
  await page.getByRole('button', { name: /^Dispositivos desta máquina/ }).click();
  await headerTitle('Dispositivos desta máquina').waitFor();
  const own = page.locator('ul[aria-label="Dispositivos"] > li', { hasText: 'este aparelho' });
  await own.getByRole('button', { name: /^Revogar/ }).click();
  revokedSelf = true;
  await page.getByRole('heading', { name: 'Parear máquina' }).waitFor({ timeout: 20_000 });
  assert.match(dialogs.at(-1) ?? '', /Este é este aparelho/, 'confirmação avisa que é este aparelho');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]').length), 0, 'máquina esquecida no PWA');
  assert.equal((await apiFetch(urlA, tokenA, '/api/workspaces')).status, 401, 'token do próprio device revogado');
  await shot('11-pareamento-apos-revogar');
  log('revogar o próprio device: app voltou ao pareamento');
}

/** Lazy chunks das telas (chat, terminal, alterações) carregaram sem erro de rede. */
function assertLazyChunks() {
  for (const name of ['ChatScreen', 'TerminalScreen', 'ChangesScreen']) {
    assert.ok(
      lazyChunks.some((chunk) => chunk.name.startsWith(`${name}-`) && chunk.status === 200),
      `chunk ${name} carregou (200)`,
    );
  }
  log(`lazy chunks carregaram: ${lazyChunks.map((chunk) => chunk.name.split('-')[0]).join(', ')}`);
}

async function checkStorageHasNoApi() {
  const cached = await page.evaluate(async () => {
    const found = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith('/api/')) found.push(request.url);
      }
    }
    return found;
  });
  assert.deepEqual(cached, [], '/api não pode estar em CacheStorage');
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  for (const file of readdirSync(shotsDir)) rmSync(join(shotsDir, file), { force: true });
  setupRepoA();
  writeConfig(homeA, { port: PORT_A, machineName: NAME_A, rootDir: rootA, pidDir: pidsA, corsOrigins: [] });
  await startDaemon('A (PC principal)', homeA, urlA, logA);

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
      // Depois de revogar o próprio device, o navegador loga os 401 das chamadas pendentes: esperado.
      if (revokedSelf && /status of 401/.test(message.text())) return;
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
    if (/\/assets\/.+\.js$/.test(path)) {
      lazyChunks.push({ name: basename(path), status: response.status() });
    }
    if (response.status() >= 400 && !(revokedSelf && response.status() === 401)) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await pairAppA();
  await stepWorkspaceInfo();
  await stepChanges();
  const worktree = await stepWorktree();
  await stepEndWorktree(worktree);
  await stepTerminal();
  await stepDevices();
  await startDaemonB();
  await stepMultiPc();
  await stepRevokeSelf();

  await checkStorageHasNoApi();
  assertLazyChunks();
  assert.deepEqual(failedRequests, [], 'sem requisição que falhou no navegador');
  assert.deepEqual(httpErrors, [], 'sem resposta de erro (4xx/5xx) fora do revogar');
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  log('fluxo da fase 5 OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  for (const entry of daemons) {
    console.error(`[e2e5] log do daemon ${entry.name} (fim):\n${tailLog(entry.logPath)}`);
  }
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  for (const entry of daemons) killTree(entry.child.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`temporários removidos: ${root}`);
}
process.exitCode = exitCode;
