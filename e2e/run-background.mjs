/*
 * E2E do trabalho em segundo plano e dos subagentes no chat. Sobe um daemon numa pasta temporária, pareia pelo
 * CLI e dirige o PWA buildado num Edge headless com viewport de iPhone 14 (390x844). O agente é o fake
 * (packages/daemon/test/fixtures/fake-agent.ts): o prompt "/subagentes" manda um subagente Claude (Agent) com três
 * filhos (um deles é outro Agent com um neto), um Bash em segundo plano e uma task do omp com dois jobs, e espera
 * session/cancel.
 * Confere: durante o turno, o chip do cabeçalho mostra 3 itens ativos; o subagente abre e lista as ações internas
 * ("3 ações internas · última: Ler testes") e o filho que é Agent abre o neto; a gaveta "Segundo plano" agrupa
 * Subagentes, Comandos e Jobs, com o estado e o tempo de cada um e os jobs do omp; tocar numa linha abre o cartão
 * (inclusive dentro de um pai recolhido) e o destaca; depois do Parar, o turno acaba e o que ficou em execução
 * aparece como "Estado desconhecido", o chip cai para 2 e a gaveta mostra os jobs como desconhecidos.
 * Screenshots nos dois temas (claro e escuro) em e2e/screenshots/background/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:background
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, porta 7805 livre. Tudo fica em
 * $TEMP/nanachi-e2ebg-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'background');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7805;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2ebg] ${line}`);

const home = join(tmpdir(), `nanachi-e2ebg-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let page;
const consoleErrors = [];
const cspViolations = [];
/** 400 answers of the branches route for the non-repository workspace (see the response listener in main). */
let expectedNotRepo = 0;

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-segundo-plano',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      omp: {
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        kind: 'acp',
        label: 'Fake',
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

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

/** Two shots of the same state: dark first (the default here), then light, then back to dark. */
async function themeShots(name, element) {
  const take = async (suffix) => {
    if (element === undefined) {
      await shot(`${name}-${suffix}`);
    } else {
      await element().screenshot({ path: join(shotsDir, `${name}-${suffix}.png`) });
      log(`screenshot ${name}-${suffix}`);
    }
  };
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await take('escuro');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  await take('claro');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
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
const headerTitle = (text) => page.locator('h1', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`[data-status="${status}"]`));
const composer = () => page.locator('[data-slot="chat-textarea"]');
const chip = () => page.locator('[data-slot="background-chip"]');
const drawer = () => page.getByRole('dialog', { name: 'Segundo plano' });
const timeline = () => page.locator('[data-slot="chat-timeline"]');

/** Summary row of a chat item's card (top level, or nested in a parent card), by its item id. */
const summaryOf = (itemId) => page.locator(`[data-item-id="${itemId}"] > [data-slot="tool-card"] > [data-slot="tool-summary"]`);
const cardOf = (itemId) => page.locator(`[data-item-id="${itemId}"] > [data-slot="tool-card"]`);

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
  await until('status online na home', () =>
    hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })),
  );

  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await headerTitle('Workspaces').waitFor();
  await button('Adicionar workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('ul[aria-label="Pastas"] > li button', { hasText: 'proj' }).click();
  await page.locator('h1 + p', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().waitFor();
}

// ---------- fluxo ----------

async function stepRunningTurn() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  await composer().fill('/subagentes');
  await button('Enviar').click();
  await until('turno em andamento', () => statusIs('running'), 30_000);

  // Durante o turno: subagente, Bash em segundo plano e task do omp estão em execução.
  await until('chip mostra 3 itens ativos', async () => (await chip().innerText()).trim() === '3', 30_000);
  await until('cartão do subagente aparece', () => hasCount(summaryOf('tool-sub-agent')));
  assert.equal(await cardOf('tool-sub-agent').evaluate((el) => el.open), false, 'subagente começa recolhido');
  log('turno em andamento: chip com 3 itens ativos, subagente recolhido OK');
}

async function stepNesting() {
  await summaryOf('tool-sub-agent').tap();
  await until('contagem de ações internas aparece', () =>
    hasCount(page.locator('[data-item-id="tool-sub-agent"] [data-slot="tool-inner-count"]', {
      hasText: '3 ações internas · última: Ler testes',
    })),
  );
  const inner = page.locator('[data-item-id="tool-sub-agent"] [data-slot="tool-inner"]').first().locator(':scope > li');
  assert.equal(await inner.count(), 3, 'os três filhos são linhas diretas do cartão do subagente');
  assert.equal(await page.locator('[data-item-id="tool-sub-agent"] [data-slot="tool-title"]', { hasText: 'Ler parser.ts' }).count(), 1);

  // O filho que é Agent abre o próprio cartão e lista o neto (cadeia de aninhamento).
  await summaryOf('tool-sub-nested').tap();
  await until('neto aparece dentro do filho', () => hasCount(page.locator('[data-item-id="tool-sub-nested-read"]')));
  assert.ok(await page.locator('[data-item-id="tool-sub-nested-read"]').isVisible(), 'neto visível depois de abrir o filho');
  assert.equal(await page.locator('[data-item-id="tool-sub-nested"] [data-slot="tool-inner-count"]').innerText(), '1 ação interna · última: Ler types.ts');
  log('aninhamento: pai com 3 filhos, filho com neto, contagem e última ação OK');

  await page.locator('[data-item-id="tool-sub-agent"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await themeShots('01-chat-subagente-expandido');
}

async function stepHeaderChip() {
  assert.equal(await chip().innerText().then((text) => text.trim()), '3', 'chip com 3 itens ativos');
  await themeShots('02-cabecalho-chip', () => page.locator('header').first());
  log('chip do cabeçalho com a contagem de itens ativos OK');
}

async function stepDrawer() {
  await chip().tap();
  await drawer().waitFor();
  await page.waitForTimeout(400);
  for (const heading of ['Subagentes', 'Comandos', 'Jobs']) {
    assert.ok(await hasCount(drawer().getByText(heading, { exact: true })), `grupo ${heading} na gaveta`);
  }
  // Quatro itens em segundo plano: o subagente, o filho que é Agent, o Bash e a task do omp.
  assert.equal(await drawer().locator('[data-slot="background-row"]').count(), 4, 'quatro linhas na gaveta');
  assert.ok(await hasCount(drawer().locator('[data-slot="background-row"]', { hasText: 'Revisar o parser' })), 'linha do subagente');
  assert.ok(await hasCount(drawer().locator('[data-slot="background-row"]', { hasText: 'Testes em segundo plano' })), 'linha do Bash');
  assert.ok(await hasCount(drawer().locator('[data-slot="background-row"]', { hasText: 'Compilar e testar' })), 'linha da task');
  assert.ok(await hasCount(drawer().getByText('Explore')), 'tipo do agente aparece');
  assert.ok(await hasCount(drawer().getByText(/Iniciado há/)), 'tempo desde o início aparece');
  assert.equal(await drawer().locator('[data-job-state="running"]').count(), 1, 'um job ainda em andamento');
  assert.equal(await drawer().locator('[data-job-state="completed"]').count(), 1, 'um job concluído');
  log('gaveta Segundo plano: grupos, linhas, tipo, tempo e jobs com o estado de cada um OK');
  await themeShots('03-gaveta-segundo-plano');
}

async function stepReveal() {
  // A linha do filho (dentro do pai recolhido) abre o pai, rola até o cartão e o destaca.
  await drawer().locator('[data-slot="background-row"]', { hasText: 'Conferir os tipos' }).tap();
  await until('cartão do filho destacado', async () =>
    (await timeline().locator('[data-item-id="tool-sub-nested"]').getAttribute('data-highlighted')) === 'true',
  );
  assert.equal(await cardOf('tool-sub-agent').evaluate((el) => el.open), true, 'o pai abre para mostrar o filho');
  await until('cartão do filho dentro da área visível', async () => {
    const box = await timeline().boundingBox();
    const target = await timeline().locator('[data-item-id="tool-sub-nested"]').boundingBox();
    return box !== null && target !== null && target.y >= box.y - 1 && target.y + target.height <= box.y + box.height + 1;
  });
  log('linha do filho revela o cartão e o destaca OK');

  await chip().tap();
  await drawer().waitFor();
  await drawer().locator('[data-slot="background-row"]', { hasText: 'Testes em segundo plano' }).tap();
  await until('cartão do Bash destacado', async () =>
    (await timeline().locator('[data-item-id="tool-bash-bg"]').getAttribute('data-highlighted')) === 'true',
  );
  log('linha do Bash revela o cartão e o destaca OK');
}

async function stepTurnEnds() {
  await button('Parar').tap();
  await until('turno termina (Parar)', () => statusIs('idle'), 30_000);
  await page.waitForTimeout(300);

  // Depois do fim do turno o que ficou em execução vira "Estado desconhecido"; o subagente terminou.
  assert.equal(await page.locator('[data-slot="chat-timeline"] [data-state="running"]').count(), 0, 'nada mais em andamento');
  await until('Bash mostra estado desconhecido', () =>
    hasCount(summaryOf('tool-bash-bg').locator('[data-state="unknown"]', { hasText: 'Estado desconhecido' })),
  );
  assert.ok(await hasCount(summaryOf('tool-omp-task').locator('[data-state="unknown"]')), 'task do omp mostra estado desconhecido');
  assert.ok(await hasCount(summaryOf('tool-sub-agent').locator('[data-state="completed"]')), 'subagente concluído');
  assert.equal((await chip().innerText()).trim(), '2', 'chip cai para os 2 itens desconhecidos do último turno');
  log('depois do turno: Bash e task viram "Estado desconhecido", chip com 2 OK');

  await chip().tap();
  await drawer().waitFor();
  await page.waitForTimeout(400);
  assert.ok(await hasCount(drawer().getByText('Estado desconhecido')), 'gaveta mostra o estado desconhecido');
  assert.equal(await drawer().locator('[data-job-state="unknown"]').count(), 1, 'job que ainda dizia running vira desconhecido');
  assert.equal(await drawer().locator('[data-job-state="completed"]').count(), 1, 'job concluído continua concluído');
  await page.keyboard.press('Escape');
  await drawer().waitFor({ state: 'hidden' });
  log('gaveta depois do turno: jobs e itens desconhecidos OK');
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
    colorScheme: 'dark',
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
  page.on('response', (response) => {
    if (response.status() === 400 && response.url().includes('/git/branches')) {
      // The workspace list asks each workspace for its branches; the temp "proj" folder is not a repository, so the
      // daemon answers 400 not_a_git_repo by design. The browser logs that as a console error: allowed below, once per call.
      expectedNotRepo += 1;
    } else if (response.status() >= 400) {
      log(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await pairAndWorkspace();
  await stepRunningTurn();
  await stepNesting();
  await stepHeaderChip();
  await stepDrawer();
  await stepReveal();
  await stepTurnEnds();
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  // Exactly the expected not_a_git_repo answers are allowed; any other console error fails the run.
  const unexpected = [...consoleErrors];
  for (let count = 0; count < expectedNotRepo; count += 1) {
    const index = unexpected.indexOf('error: Failed to load resource: the server responded with a status of 400 (Bad Request)');
    if (index !== -1) unexpected.splice(index, 1);
  }
  assert.deepEqual(unexpected, [], 'console do navegador sem erros');
  log(`fluxo do segundo plano OK (respostas 400 not_a_git_repo esperadas: ${expectedNotRepo})`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2ebg] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
