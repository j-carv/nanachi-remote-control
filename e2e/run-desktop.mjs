/*
 * Smoke do Nanachi Desktop (Electron em desenvolvimento, `electron packages/desktop`): o painel carrega a PWA do
 * daemon que o Desktop sobe, a seção "Desktop" aparece em Ajustes e o cartão "Tailscale embutido" mostra os eventos de
 * um sidecar FALSO (needs_login e depois running).
 *
 * Segurança: o sidecar real (nanachi-tsnet.exe) registraria um dispositivo na tailnet de quem fizer login, então este
 * script nunca o inicia. Ele compila `packages/desktop/test/fixtures/fake-tsnet` (só biblioteca padrão do Go, sem rede)
 * e aponta o Desktop para o executável falso com NANACHI_DESKTOP_TSNET_PATH. A pasta de build também é redirecionada
 * para uma pasta vazia, então mesmo sem o override o sidecar real não seria achado.
 *
 * O que confere:
 *   0. (config seeding) a fresh Desktop data folder gets config.json with { "port": 7780 } (the compiled function, no
 *      process started), and an existing config.json is never rewritten;
 *   1. o painel carrega a PWA do daemon (porta livre diferente de 7777 e 7780, NANACHI_DESKTOP_HOME e userData
 *      temporários, allowlist vazia); o config.json da pasta do Desktop continua com a porta escolhida pelo script, e um
 *      NANACHI_HOME de isca no ambiente (a pasta do daemon avulso) nunca é lido nem criado;
 *   2. Ajustes tem o grupo "Desktop" com daemon rodando, "Iniciar com o Windows", código de pareamento e versão;
 *   3. ligar "Tailscale embutido" sobe só o sidecar falso, com as flags do contrato e TS_NO_LOGS_NO_SUPPORT=true,
 *      e o cartão mostra needs_login (link) e depois running (endereço https);
 *   4. o código de pareamento aparece em uma folha;
 *   5. desligar fecha o stdin do sidecar (parada educada) e o processo some;
 *   6. sair do Desktop com o Tailscale ligado derruba o sidecar e o daemon que ele subiu;
 *   7. abrir de novo restaura o "Tailscale embutido" sozinho (tailscaleEnabled).
 *
 * Como rodar (da raiz, com o supervisor já tendo publicado o daemon e a PWA; compile o Desktop antes):
 *   npm run build:desktop -w @nanachi/desktop
 *   node e2e/run-desktop.mjs
 *
 * Pré-requisitos: Node 22+, Go no PATH (para o sidecar falso), Electron instalado (workspace desktop). Não usa a
 * porta 7777 nem mexe no daemon do supervisor. Screenshots em e2e/screenshots/desktop/.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const electronBinary = require('electron');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');
const shotsDir = join(here, 'screenshots', 'desktop');
const log = (line) => console.log(`[e2edesktop] ${line}`);
// A pasta temporária sai pelo mesmo removedor do app (nunca `rmSync` recursivo: ele segue junções no Node do Electron).
const { removeTree } = await import(pathToFileURL(join(desktopDir, 'dist', 'install', 'safe-remove.js')).href);

const root = join(tmpdir(), `nanachi-e2edesktop-${randomBytes(4).toString('hex')}`);
const home = join(root, 'home');
// Stands in for the standalone daemon's NANACHI_HOME, which Desktop must ignore: it never exists, and the run checks it stays that way.
const standaloneDecoy = join(root, 'standalone-nanachi-home');
const userData = join(root, 'userdata');
const buildDir = join(root, 'empty-build-dir');
const fakeExe = join(root, 'fake-tsnet.exe');
const record = join(root, 'fake-tsnet-record.json');
const recordLog = `${record}.log`;

let port = 0;
let origin = '';
let configText = '';
/** Cada processo que este script iniciou, para a limpeza no fim. */
const pids = new Set();
let app = null;

// ---------- infraestrutura ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function isAlive(pid) {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
  return out.includes(`"${pid}"`);
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: chosen } = server.address();
      server.close(() => resolvePort(chosen));
    });
  });
}

function setupFolders() {
  for (const dir of [home, userData, buildDir, shotsDir]) mkdirSync(dir, { recursive: true });
  // Desktop only creates config.json (port 7780) when it is missing. This script picks a free port and writes the file
  // first, so port 7780 (which may be taken) never comes into play.
  // Allowlist vazia: o painel local usa o daemon sem a "chave local" (que não faz parte desta entrega).
  const config = {
    port,
    host: '127.0.0.1',
    machineName: 'e2e-desktop',
    allowedRoots: [home],
    allowedTailscaleLogins: [],
    tailscaleAutoPair: false,
    corsOrigins: [],
    agents: {},
  };
  configText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(join(home, 'config.json'), configText);
}

/** What Desktop does by itself in a fresh folder (the compiled function; no process, no port). */
async function checkConfigSeeding() {
  const { DEFAULT_PORT, ensureDesktopConfig, resolveHome } = await import(pathToFileURL(join(desktopDir, 'dist', 'main', 'daemon-runtime.js')).href);
  assert.equal(DEFAULT_PORT, 7780);
  const fresh = join(root, 'fresh-desktop-home');
  assert.equal(ensureDesktopConfig(fresh), 'created');
  const bytes = readFileSync(join(fresh, 'config.json'));
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { port: 7780 });
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'config.json has no BOM');
  assert.equal(ensureDesktopConfig(fresh), 'kept');
  assert.equal(ensureDesktopConfig(home), 'kept', 'an existing config.json is never rewritten');
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), configText);
  // NANACHI_HOME (the standalone daemon) does not count; only NANACHI_DESKTOP_HOME does.
  assert.equal(resolveHome({ NANACHI_HOME: standaloneDecoy, NANACHI_DESKTOP_HOME: home }), home);
  assert.notEqual(resolveHome({ NANACHI_HOME: standaloneDecoy }), standaloneDecoy);
  log('fresh Desktop home gets config.json with port 7780; an existing config.json is not rewritten');
}

/** After Desktop ran: config.json in Desktop's folder is what this script wrote (its chosen port), and the decoy never appeared. */
function checkHomeAfterRun() {
  const text = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal(JSON.parse(text).port, port, "Desktop's config.json holds the port this script chose");
  assert.equal(text, configText, 'Desktop does not rewrite an existing config.json');
  assert.ok(existsSync(join(home, 'data.db')), "the daemon Desktop started keeps its data in Desktop's folder (NANACHI_DESKTOP_HOME)");
  assert.equal(existsSync(standaloneDecoy), false, "Desktop never uses the environment's NANACHI_HOME (the standalone daemon's folder)");
  log("Desktop's own folder holds config.json (the chosen port) and data.db; the NANACHI_HOME decoy was never touched");
}

function buildFakeSidecar() {
  const result = spawnSync('go', ['build', '-o', fakeExe, '.'], {
    cwd: join(desktopDir, 'test', 'fixtures', 'fake-tsnet'),
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  if (result.status !== 0) throw new Error(`go build do sidecar falso falhou:\n${result.stderr}${result.stdout}`);
  log(`sidecar falso compilado: ${fakeExe}`);
}

function readRecord() {
  return existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
}

function recordEvents() {
  return existsSync(recordLog) ? readFileSync(recordLog, 'utf8').split('\n').filter(Boolean) : [];
}

async function until(description, check, timeout = 30_000, page = null) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      if (page !== null) await page.screenshot({ path: join(shotsDir, `falha-${description.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
      throw new Error(`tempo esgotado esperando: ${description}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

async function launch() {
  const instance = await electron.launch({
    executablePath: electronBinary,
    args: [desktopDir],
    cwd: repoRoot,
    env: {
      ...process.env,
      // A pasta de dados do Desktop. O NANACHI_HOME de isca (o do daemon avulso) tem que ser ignorado.
      NANACHI_DESKTOP_HOME: home,
      NANACHI_HOME: standaloneDecoy,
      NANACHI_DESKTOP_USER_DATA: userData,
      // Nunca o sidecar real: o falso, e uma pasta de build vazia como segunda barreira.
      NANACHI_DESKTOP_TSNET_PATH: fakeExe,
      NANACHI_DESKTOP_BUILD_DIR: buildDir,
      FAKE_TSNET_RECORD: record,
      FAKE_TSNET_RUNNING_AFTER_MS: '5000',
    },
  });
  const pid = instance.process().pid;
  if (pid !== undefined) pids.add(pid);
  return instance;
}

/** A janela do painel, já com a PWA do daemon carregada. */
async function panelPage(instance) {
  const page = await instance.firstWindow();
  await until('a PWA carregar no painel', () => page.url().startsWith(`${origin}/`), 60_000, page);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function daemonPid(page) {
  return page.evaluate(async () => (await window.nanachiDesktop.status()).pid);
}

async function openSettings(page) {
  const settings = page.getByRole('button', { name: 'Ajustes', exact: true });
  await settings.waitFor({ state: 'visible', timeout: 30_000 });
  await settings.click();
  await page.getByRole('heading', { name: 'Desktop', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
}

async function shotBothThemes(page, locator, name) {
  for (const [scheme, label] of [['dark', 'escuro'], ['light', 'claro']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await locator.screenshot({ path: join(shotsDir, `${name}-${label}.png`) });
    log(`screenshot ${name} (${scheme})`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const tailscaleSwitch = (page) => page.locator('[data-slot=desktop-tailscale] [role=switch]');

// ---------- o roteiro ----------

async function run() {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  assert.notEqual(port, 7777, 'a porta 7777 é do supervisor');
  assert.notEqual(port, 7780, "7780 is Desktop's default port; this script uses any other free port");
  setupFolders();
  buildFakeSidecar();
  assert.ok(existsSync(join(desktopDir, 'dist', 'main', 'index.js')), 'compile o Desktop antes: npm run build:desktop -w @nanachi/desktop');
  log(`home ${home}, porta ${port}`);
  await checkConfigSeeding();

  // O código que uma pessoa estaria digitando no celular enquanto o Desktop se pareia pela primeira vez.
  // `pair --json` derrubaria um código que ainda vale; o Desktop usa `device add`, então ele tem que continuar valendo.
  const typing = spawnSync(process.execPath, [join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js'), 'pair', '--json'], {
    env: { ...process.env, NANACHI_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(typing.status, 0, `pair --json falhou: ${typing.stderr}`);
  const typingCode = JSON.parse(typing.stdout.trim().split('\n').at(-1)).code;

  // ----- 1. primeira abertura -----
  app = await launch();
  let page = await panelPage(app);
  log(`painel carregado: ${page.url()}`);
  const phonePair = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: typingCode, deviceName: 'e2e-phone' }),
  });
  assert.equal(phonePair.status, 200, 'o pareamento do Desktop não pode derrubar um código que ainda vale');
  log('o código que estava valendo antes de o Desktop se parear continua valendo (device add, não pair)');

  const daemon = await daemonPid(page);
  assert.ok(Number.isInteger(daemon), 'o Desktop deveria ter subido o daemon (pid)');
  pids.add(daemon);

  await openSettings(page);
  const section = page.locator('[data-slot=desktop-section]');
  await section.scrollIntoViewIfNeeded();
  await until('o daemon aparecer como rodando', async () => (await page.locator('[data-slot=desktop-daemon]').getAttribute('data-state')) === 'running', 30_000, page);
  for (const text of ['Iniciar com o Windows', 'Gerar código de pareamento', 'Procurar atualização', 'Tailscale embutido']) {
    await section.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 });
  }
  assert.equal(await page.locator('[data-slot=desktop-daemon-title]').textContent(), 'Rodando');
  assert.match((await page.locator('[data-slot=desktop-daemon]').textContent()) ?? '', new RegExp(`Porta ${port}`));
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'false', 'o Tailscale começa desligado');
  assert.equal(readRecord(), null, 'nenhum sidecar deveria ter sido iniciado antes de o usuário ligar');
  checkHomeAfterRun();
  await shotBothThemes(page, section, 'desktop-ajustes');

  // ----- 2. versão e atualização (consulta anônima ao GitHub; qualquer resposta serve) -----
  await page.locator('[data-slot=desktop-update]').click();
  await until('o resultado da busca de atualização', async () => {
    const text = (await page.locator('[data-slot=desktop-update-summary]').textContent()) ?? '';
    return text !== 'Procurando…' && /Versão /.test(text);
  }, 20_000, page);
  log(`atualização: ${await page.locator('[data-slot=desktop-update-summary]').textContent()}`);

  // ----- 3. código de pareamento -----
  await page.locator('[data-slot=desktop-pairing]').click();
  const codeValue = page.locator('[data-slot=pairing-code-value]');
  await codeValue.waitFor({ state: 'visible', timeout: 20_000 });
  assert.match((await codeValue.textContent()) ?? '', /^\d{3} \d{3}$/);
  assert.match((await page.locator('[data-slot=pairing-code-countdown]').textContent()) ?? '', /^Expira em \d:\d{2}$/);
  await shotBothThemes(page, page.locator('[data-slot=drawer-content]'), 'desktop-codigo-pareamento');
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await codeValue.waitFor({ state: 'detached', timeout: 5_000 });

  // ----- 4. Tailscale embutido: só o sidecar FALSO -----
  await tailscaleSwitch(page).scrollIntoViewIfNeeded();
  await tailscaleSwitch(page).click();
  const login = page.locator('[data-slot=desktop-tailscale-login]');
  await login.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await login.getAttribute('href'), 'https://login.tailscale.com/a/fake-smoke-login');
  assert.equal(await login.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('[data-slot=desktop-tailscale-status]').getAttribute('data-state'), 'needs_login');
  await shotBothThemes(page, page.locator('[data-slot=desktop-tailscale]').locator('xpath=ancestor::ul[1]'), 'tailscale-needs-login');

  const launched = readRecord();
  assert.ok(launched !== null, 'o sidecar falso deveria ter registrado a chamada');
  pids.add(launched.pid);
  assert.deepEqual(launched.args.filter((_, index) => index % 2 === 0), ['--state-dir', '--hostname', '--target']);
  assert.equal(launched.args[1], join(home, 'tsnet'));
  assert.match(launched.args[3], /^nanachi-[a-z0-9-]+$/);
  assert.equal(launched.args[5], origin);
  assert.equal(launched.env.TS_NO_LOGS_NO_SUPPORT, 'true');
  log(`sidecar falso iniciado com ${launched.args.join(' ')}`);

  const address = page.locator('[data-slot=desktop-tailscale-address]');
  await address.waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await address.textContent(), 'https://nanachi-smoke.tail-fake.ts.net');
  assert.equal(await page.locator('[data-slot=desktop-tailscale-status]').getAttribute('data-state'), 'running');
  assert.equal(await login.count(), 0, 'o link de login some quando o nó está rodando');
  await page.locator('[data-slot=desktop-tailscale-steps]').getByText('Adicionar à Tela de Início').waitFor({ state: 'visible' });
  await shotBothThemes(page, page.locator('[data-slot=desktop-tailscale]').locator('xpath=ancestor::ul[1]'), 'tailscale-running');
  assert.ok(isAlive(launched.pid), 'o sidecar falso deveria estar vivo com o stdin aberto');
  assert.equal(recordEvents().includes('stdin-eof'), false, 'o stdin do sidecar tem que ficar aberto');

  // ----- 5. desligar: parada educada (stdin fechado) -----
  await tailscaleSwitch(page).click();
  await until('o sidecar falso terminar após fechar o stdin', () => recordEvents().includes('stdin-eof') && !isAlive(launched.pid), 15_000, page);
  await page.locator('[data-slot=desktop-tailscale-status]').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'false');
  log('desligar fechou o stdin e o sidecar falso saiu');

  // ----- 6. sair com o Tailscale ligado: nada fica para trás -----
  await tailscaleSwitch(page).click();
  await page.locator('[data-slot=desktop-tailscale-login]').waitFor({ state: 'visible', timeout: 15_000 });
  const second = readRecord();
  pids.add(second.pid);
  assert.notEqual(second.pid, launched.pid);
  const electronPid = app.process().pid;
  await app.close();
  app = null;
  await until('Electron, daemon e sidecar falso terminarem ao sair', () => !isAlive(electronPid) && !isAlive(daemon) && !isAlive(second.pid), 20_000);
  log('sair derrubou o Electron, o daemon que ele subiu e o sidecar falso');

  // ----- 7. abrir de novo: o Tailscale embutido volta sozinho -----
  const startsBefore = recordEvents().filter((event) => event === 'start').length;
  app = await launch();
  page = await panelPage(app);
  await until('o Desktop reiniciar o sidecar falso sozinho', () => recordEvents().filter((event) => event === 'start').length === startsBefore + 1, 30_000, page);
  const third = readRecord();
  pids.add(third.pid);
  pids.add(await daemonPid(page));
  await openSettings(page);
  await page.locator('[data-slot=desktop-tailscale-status]').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await tailscaleSwitch(page).getAttribute('aria-checked'), 'true', 'tailscaleEnabled foi restaurado');
  log('tailscaleEnabled restaurado: o sidecar falso subiu sozinho');

  // Deixa o ajuste desligado e fecha.
  await tailscaleSwitch(page).click();
  await until('o sidecar falso terminar', () => !isAlive(third.pid), 15_000, page);
  const finalElectron = app.process().pid;
  const finalDaemon = await daemonPid(page);
  await app.close();
  app = null;
  await until('tudo terminar no fim', () => !isAlive(finalElectron) && !isAlive(finalDaemon), 20_000);

  log('OK');
}

let failed = false;
try {
  await run();
} catch (error) {
  failed = true;
  console.error(`[e2edesktop] FALHOU: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (app !== null) await app.close().catch(() => undefined);
  for (const pid of pids) if (isAlive(pid)) killTree(pid);
  // A pasta temporária (home, userData, sidecar falso) sai junto. Os screenshots ficam em e2e/screenshots/desktop.
  removeTree(root);
  const leftovers = [...pids].filter((pid) => isAlive(pid));
  if (leftovers.length > 0) console.error(`[e2edesktop] processos que sobraram: ${leftovers.join(', ')}`);
}
process.exit(failed ? 1 : 0);
