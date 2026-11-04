/*
 * E2E das imagens que o agente manda (ACP → arquivo da sessão → PWA). Sobe o daemon buildado numa pasta temporária,
 * pareia pelo CLI e dirige o PWA buildado num Edge headless com viewport de iPhone 14 (390x844). O agente é o fake
 * (packages/daemon/test/fixtures/fake-agent.ts): o prompt "img-inline img-arquivo" faz ele mandar:
 *  - uma imagem em mensagem (evento file) e a mesma imagem em tool call (ToolContent image, reenviada no update);
 *  - um arquivo local de imagem dentro do workspace (resource_link file://) e outro fora dele (ignorado).
 * Confere: miniaturas aparecem e carregam, toque abre o visualizador, o arquivo fora das raízes não aparece.
 * Screenshots nos dois temas (claro e escuro) em e2e/screenshots/images/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:images
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, porta 7796 livre. Tudo fica em
 * $TEMP/nanachi-e2eimg-<rand> e é apagado no fim.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(here, 'screenshots', 'images');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7796;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2eimg] ${line}`);

const home = join(tmpdir(), `nanachi-e2eimg-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const outsideFile = join(home, 'fora.png');
const inlineFile = join(home, 'inline.png');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let daemonToken = '';
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** PNG pequeno gerado em memória (gradiente). `tint` troca a cor de fundo para diferenciar os arquivos. */
function makePng(width, height, tint) {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = Math.round((x / width) * 255);
      raw[offset + 1] = Math.round((y / height) * 255);
      raw[offset + 2] = tint;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  // Dentro do workspace: vira resource_link file:// válido.
  writeFileSync(join(projDir, 'grafico.png'), makePng(120, 80, 200));
  // Fora das raízes (pasta pai do proj): o agente manda o caminho, o daemon ignora.
  writeFileSync(outsideFile, makePng(60, 40, 90));
  // Imagem que o agente manda inline (base64) em mensagem e em tool call.
  writeFileSync(inlineFile, makePng(160, 100, 130));
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-imagens',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      fake: {
        label: 'Fake',
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        env: {
          FAKE_AGENT_PID_DIR: pidDir,
          FAKE_AGENT_IMAGE_FILE: join(projDir, 'grafico.png'),
          FAKE_AGENT_IMAGE_OUTSIDE: outsideFile,
          FAKE_AGENT_INLINE_IMAGE: inlineFile,
        },
        kind: 'acp',
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
/** Imagem carregada (blob já virou <img> com tamanho). */
const loaded = (locator) => locator.evaluate((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0);

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
  daemonToken = await page.evaluate(() => {
    const machines = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]');
    return machines[0]?.token ?? '';
  });
  assert.ok(daemonToken.length > 0, 'token do dispositivo salvo no PWA');

  await button('Workspaces').click();
  await headerTitle('Workspaces').waitFor();
  await button('+ Workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('.item-title', { hasText: 'proj' }).click();
  await page.locator('.app-header .muted', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('.item-main', { hasText: 'proj' }).first().waitFor();
}

/** Abre o cartão de tool call cujo título começa com `title` (o n-ésimo, se houver mais de um). */
function toolCard(title, nth = 0) {
  return page.locator('.tool-card', { has: page.locator('.tool-title', { hasText: title }) }).nth(nth);
}

/** Tela cheia: abre pela miniatura, espera a imagem carregar, tira a foto e fecha. */
async function viewerRoundTrip(thumb, name, shotName) {
  await thumb.click();
  await page.locator('.viewer').waitFor();
  await until(`${name} carregou no visualizador`, () => loaded(page.locator('.viewer-image')));
  assert.equal(await page.locator('.viewer-name').innerText(), name, `visualizador mostra ${name}`);
  await shot(shotName);
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.locator('.viewer').waitFor({ state: 'detached' });
}

// ---------- fluxo ----------

async function stepImagesInChat() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);

  await page.locator('.chat-textarea').fill('img-inline img-arquivo');
  await button('Enviar').click();
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(400);

  // 1) Imagem em mensagem do agente: miniatura no fluxo do chat, carregada por blob.
  const messageThumb = page.locator('.chat-timeline .file-attachment .file-thumb');
  await until('miniatura da mensagem do agente', () => hasCount(messageThumb));
  await until('miniatura da mensagem carregou', () => loaded(messageThumb.locator('img')));

  // 2) Imagem em tool call (cartão em andamento, aberto): miniatura dentro do cartão.
  const toolThumb = toolCard('Ler teste.png').locator('.file-thumb');
  await until('miniatura dentro do tool call', () => hasCount(toolThumb));
  await until('miniatura do tool call carregou', () => loaded(toolThumb.locator('img')));

  // 3) Arquivo local dentro do workspace: cartão fechado; abre e a miniatura aparece.
  const linkCard = toolCard('Ler arquivo', 0);
  await linkCard.locator('summary').click();
  const linkThumb = linkCard.locator('.file-thumb');
  await until('miniatura do arquivo local', () => hasCount(linkThumb));
  await until('miniatura do arquivo local carregou', () => loaded(linkThumb.locator('img')));

  // 4) Arquivo fora das raízes: o cartão não tem miniatura nenhuma.
  const outsideCard = toolCard('Ler arquivo', 1);
  await outsideCard.locator('summary').click();
  await page.waitForTimeout(300);
  assert.equal(await outsideCard.locator('.file-thumb').count(), 0, 'arquivo fora das raízes não vira imagem');

  await shot('01-chat-imagens');

  // 5) Toque abre o visualizador em tela cheia, nos três casos. A imagem do tool call é a mesma da mensagem
  // (mesmo conteúdo): o daemon reaproveita o arquivo imagem-1 e o tool call mostra o nome genérico.
  await viewerRoundTrip(messageThumb.first(), 'imagem-1.png', '02-visualizador-mensagem');
  await viewerRoundTrip(toolThumb.first(), 'imagem.png', '03-visualizador-tool-call');
  // Arquivo local também chega como ToolContent image: mesmo nome genérico do tool call.
  await viewerRoundTrip(linkThumb.first(), 'imagem.png', '04-visualizador-arquivo-local');

  const alts = await page.locator('.file-thumb img').evaluateAll((imgs) => imgs.map((img) => img.alt));
  log(`miniaturas no chat: ${alts.join(' | ')}`);
  assert.deepEqual(alts, ['imagem-1.png', 'imagem.png', 'imagem.png'], 'três miniaturas: mensagem, tool call, arquivo local');
}

/** Fotos dos dois temas: topo da conversa e a parte com as miniaturas do tool call. */
async function themeShots(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
  await page.locator('.chat-timeline').evaluate((el) => {
    el.scrollTop = 0;
  });
  await shot(`05-chat-${theme}-topo`);
  await page.locator('.chat-timeline').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shot(`06-chat-${theme}-fim`);
  const sample = await page.locator('.file-thumb').first().evaluate((el) => getComputedStyle(el).borderRadius);
  log(`tema ${theme}: raio da miniatura ${sample}`);
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
  await stepImagesInChat();
  await themeShots('dark');
  await themeShots('light');
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  log('fluxo das imagens do agente OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2eimg] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
