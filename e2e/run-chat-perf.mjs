/*
 * Medição do chat do PWA numa sessão pesada, com CPU do navegador limitada (padrão 4x, como um iPhone).
 * Sobe um daemon numa pasta temporária, pareia pelo CLI, cria uma sessão do agente fake e dirige o PWA buildado
 * num Edge headless com viewport de iPhone 14 (390x844). O agente fake, no modo "flood", gera uma conversa grande
 * (ver packages/daemon/test/fixtures/fake-agent.ts): pensamento, plano, 40 passos com ~60 chunks de markdown,
 * tool calls com diff e saída longa, bloco de código largo e um final com ~600 chunks.
 *
 * Como rodar (a partir da raiz; usa o daemon e o PWA já buildados em dist/, o supervisor mantém os dois atualizados):
 *   npm run e2e:chatperf
 *
 * Variáveis opcionais:
 *   CHATPERF_LABEL   rótulo do resultado (padrão "depois"), usado no nome das capturas
 *   CHATPERF_SHOTS   pasta das capturas (padrão e2e/screenshots/chat)
 *   CHATPERF_CPU     limite de CPU do navegador (padrão 4; 1 = sem limite)
 *   E2E_BROWSER_CHANNEL  canal do navegador (padrão msedge)
 *
 * Mede: tempo até a conversa aparecer ao abrir (reload), FPS e long tasks durante o streaming, atraso da rolagem
 * em relação ao fim, se a posição do usuário é respeitada, se a posição volta ao voltar ao chat, rolagem dupla e
 * overflow horizontal. Imprime um bloco JSON com `[chatperf] RESULTADO`.
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
const shotsDir = process.env.CHATPERF_SHOTS ?? join(here, 'screenshots', 'chat');
const label = process.env.CHATPERF_LABEL ?? 'depois';
const cpuRate = Number(process.env.CHATPERF_CPU ?? 4);
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7800;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[chatperf] ${line}`);

const home = join(tmpdir(), `nanachi-chatperf-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let page = null;
let cdp = null;
const consoleErrors = [];
const cspViolations = [];
const result = { label, cpuRate };

// ---------- daemon ----------

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

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-chat-perf',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      fake: {
        label: 'Fake',
        command: process.execPath,
        args: ['--import', tsxEsm, fakeAgentTs],
        env: { FAKE_AGENT_PID_DIR: pidDir },
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

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${label}-${name}.png`) });
}

/** Espera até `check` ser verdadeiro (polling curto). Em falha, tira screenshot e lança erro. */
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
const round = (value) => Math.round(value * 10) / 10;

async function distanceToBottom() {
  return page.evaluate(() => {
    const el = document.querySelector('.chat-timeline');
    return el === null ? -1 : el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

async function timelineScrollTop() {
  return page.evaluate(() => document.querySelector('.chat-timeline')?.scrollTop ?? -1);
}

/** Rola a lista (e só ela) para `top` em px; simula o dedo do usuário subindo a conversa. */
async function scrollTimelineTo(top) {
  await page.evaluate((value) => {
    const el = document.querySelector('.chat-timeline');
    if (el !== null) el.scrollTop = value;
  }, top);
}

// ---------- pareamento e sessão ----------

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

async function goToWorkspaces() {
  for (let step = 0; step < 6; step += 1) {
    if (await hasCount(headerTitle('Workspaces'))) return;
    if (await hasCount(page.getByRole('button', { name: 'Voltar', exact: true }))) {
      await button('Voltar').click();
    } else if (await hasCount(page.getByRole('button', { name: 'Workspaces', exact: true }))) {
      await button('Workspaces').click();
    }
    await page.waitForTimeout(150);
  }
  await headerTitle('Workspaces').waitFor({ timeout: 10_000 });
}

async function newFakeSession() {
  await goToWorkspaces();
  await page.locator('.item-main', { hasText: 'proj' }).first().click();
  await button('+ Nova sessão').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await page.locator('.agent-choice', { hasText: 'Fake' }).click();
  await button('Criar sessão').click();
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
}

// ---------- monitor dentro da página ----------

async function startMonitor() {
  await page.evaluate(() => {
    const perf = { running: true, userUp: false, start: performance.now(), frames: [], longtasks: [], gaps: [] };
    window.__perf = perf;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) perf.longtasks.push(entry.duration);
      }).observe({ type: 'longtask' });
    } catch {
      /* navegador sem longtask */
    }
    let last = performance.now();
    const frame = (now) => {
      if (!perf.running) return;
      perf.frames.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Distância ao fim enquanto o usuário não rolou para cima: mede se a rolagem acompanha o conteúdo novo.
    setInterval(() => {
      const el = document.querySelector('.chat-timeline');
      if (!perf.running || el === null || perf.userUp) return;
      perf.gaps.push(el.scrollHeight - el.scrollTop - el.clientHeight);
    }, 200);
  });
}

async function stopMonitor() {
  return page.evaluate(() => {
    const perf = window.__perf;
    perf.running = false;
    const frames = perf.frames.slice(1);
    const sorted = [...frames].sort((a, b) => a - b);
    const quantile = (q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
    const elapsedS = (performance.now() - perf.start) / 1000;
    const gaps = perf.gaps;
    return {
      fpsMedio: frames.length / elapsedS,
      quadroP95Ms: quantile(0.95),
      quadrosAcimaDe100ms: frames.filter((ms) => ms > 100).length,
      longtasks: perf.longtasks.length,
      longtaskMaxMs: Math.max(0, ...perf.longtasks),
      longtaskTotalMs: perf.longtasks.reduce((sum, ms) => sum + ms, 0),
      atrasoMaxPx: gaps.length === 0 ? 0 : Math.max(...gaps),
      atrasoMedioPx: gaps.length === 0 ? 0 : gaps.reduce((sum, px) => sum + px, 0) / gaps.length,
    };
  });
}

function rounded(stats) {
  return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, round(value)]));
}

// ---------- cenários ----------

/** Um turno "flood" com a conversa aberta. `scrollUp`: o usuário sobe a conversa durante o streaming. */
async function streamTurn({ scrollUp }) {
  await startMonitor();
  const started = Date.now();
  await page.locator('.chat-textarea').fill('flood');
  await button('Enviar').click();
  await until('turno começa (running)', () => statusIs('running'), 30_000);

  let userScrollTop = null;
  if (scrollUp) {
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      if (window.__perf) window.__perf.userUp = true;
    });
    const current = await timelineScrollTop();
    userScrollTop = Math.max(0, current - 700);
    await scrollTimelineTo(userScrollTop);
  }

  await until('turno termina (idle)', () => statusIs('idle'), 600_000);
  const tempoMs = Date.now() - started;
  await page.waitForTimeout(500);
  const stats = await stopMonitor();
  const afterTop = await timelineScrollTop();
  const out = {
    tempoTurnoS: round(tempoMs / 1000),
    ...rounded(stats),
    distanciaFimAposTurnoPx: round(await distanceToBottom()),
  };
  if (userScrollTop !== null) {
    out.posicaoRespeitadaDuranteStreaming = Math.abs(afterTop - userScrollTop) < 60;
    out.posicaoAposStreaming = round(afterTop);
    out.posicaoPedida = round(userScrollTop);
  }
  return out;
}

/** Recarrega (abre a conversa do zero) e mede até o último texto do agente aparecer. */
async function coldOpen() {
  const started = Date.now();
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.agent-text')].some((el) => el.textContent?.includes('FIM-DO-FLOOD')),
    null,
    { timeout: 180_000, polling: 100 },
  );
  const abrirMs = Date.now() - started;
  await page.waitForTimeout(400);
  return { abrirAteFimMs: abrirMs, distanciaFimPx: round(await distanceToBottom()) };
}

/** Sobe a conversa, sai para a lista de sessões e volta: a posição deve ser a mesma em que o usuário deixou. */
async function backAndReturn() {
  await scrollTimelineTo(Math.floor((await page.evaluate(() => document.querySelector('.chat-timeline')?.scrollHeight ?? 0)) * 0.4));
  await page.waitForTimeout(200);
  const saved = await timelineScrollTop();
  await button('Voltar').click();
  await page.locator('.item-main').first().waitFor({ timeout: 10_000 });
  await page.locator('.item-main').first().click();
  await until('conversa de volta', () => hasCount(page.locator('.chat-timeline')), 10_000);
  await page.waitForTimeout(400);
  const restored = await timelineScrollTop();
  return { posicaoSalva: round(saved), posicaoAoVoltar: round(restored), posicaoRestaurada: Math.abs(restored - saved) < 60 };
}

/** Capturas e checagens de layout. Roda nos dois temas. */
async function visualChecks() {
  const checks = {};
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    const tag = `${theme}`;

    await scrollTimelineTo(0);
    await page.waitForTimeout(200);
    await shot(`${tag}-01-topo`);

    const tool = page.locator('.tool-card').nth(3);
    await tool.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(`${tag}-02-tool-recolhido`);
    await tool.locator('summary').click();
    await page.waitForTimeout(300);
    await shot(`${tag}-03-tool-expandido`);

    const diff = tool.locator('.diff').first();
    if ((await diff.count()) > 0) {
      await diff.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(`${tag}-04-diff`);
    }

    const code = page.locator('.markdown pre', { hasText: 'configuracaoDoAgente' }).first();
    if ((await code.count()) > 0) {
      await code.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(`${tag}-05-codigo-largo`);
    }

    await page.evaluate(() => {
      const el = document.querySelector('.chat-timeline');
      if (el !== null) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await shot(`${tag}-06-fim`);

    await scrollTimelineTo(Math.floor((await page.evaluate(() => document.querySelector('.chat-timeline')?.scrollHeight ?? 0)) * 0.5));
    await page.waitForTimeout(300);
    await shot(`${tag}-07-rolado-para-cima`);
    checks.botaoIrParaFim = await hasCount(page.getByRole('button', { name: /Ir para o fim/ }));
  }
  await page.emulateMedia({ colorScheme: 'light' });

  checks.scrollDuplo = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2);
  checks.overflowHorizontal = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  checks.dom = await page.evaluate(() => ({
    nos: document.getElementsByTagName('*').length,
    itensNaLista: document.querySelector('.chat-timeline')?.children.length ?? 0,
  }));

  // Teclado do iOS aproximado: a área visível encolhe. O composer tem de continuar dentro dela.
  await scrollTimelineTo(0);
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(600);
  await page.locator('.chat-textarea').focus();
  await page.waitForTimeout(400);
  await shot('light-08-teclado');
  checks.composerVisivelComTeclado = await page.evaluate(() => {
    const textarea = document.querySelector('.chat-textarea');
    const vv = window.visualViewport;
    const bottom = vv ? vv.height + vv.offsetTop : innerHeight;
    return textarea !== null && textarea.getBoundingClientRect().bottom <= bottom + 1;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  return checks;
}

/**
 * Geometria no fim (medida com getBoundingClientRect): composer encostado na base, lista acima dele, cartão de
 * permissão inteiro e clicável, e rolagem com a roda levando às mensagens novas. Usa um pedido de permissão real
 * do agente fake (prompt "permission").
 */
async function layoutChecks() {
  const geo = await page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const composer = document.querySelector('.chat-input');
    return {
      alturaJanela: innerHeight,
      alturaVisivel: window.visualViewport ? window.visualViewport.height : null,
      composer: box('.chat-input'),
      timeline: box('.chat-timeline'),
      jumpBottom: box('.jump-bottom'),
      paddingBottomComposer: composer === null ? null : getComputedStyle(composer).paddingBottom,
      rolagemDaPagina: document.documentElement.scrollHeight - innerHeight,
    };
  });
  assert.ok(geo.composer !== null && geo.timeline !== null, 'composer e lista existem');
  const out = {
    composerFolgaInferiorPx: round(geo.alturaJanela - geo.composer.bottom),
    paddingInferiorComposer: geo.paddingBottomComposer,
    listaTerminaAcimaDoComposer: geo.timeline.bottom <= geo.composer.top + 0.5,
    rolagemDaPaginaPx: round(geo.rolagemDaPagina),
  };

  await page.locator('.chat-textarea').fill('permission');
  await button('Enviar').click();
  await until('cartão de permissão', () => hasCount(page.locator('.permission-card')), 60_000);
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => {
    const cardEl = document.querySelector('.permission-card');
    const timeline = document.querySelector('.chat-timeline').getBoundingClientRect();
    const composer = document.querySelector('.chat-input').getBoundingClientRect();
    const r = cardEl.getBoundingClientRect();
    const buttons = [...cardEl.querySelectorAll('.permission-actions .button')].map((b) => {
      const br = b.getBoundingClientRect();
      const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      return {
        texto: b.textContent,
        dentroDaLista: br.top >= timeline.top - 1 && br.bottom <= timeline.bottom + 1,
        clicavel: hit !== null && (hit === b || b.contains(hit)),
      };
    });
    return {
      cardInteiroNaLista: r.top >= timeline.top - 1 && r.bottom <= timeline.bottom + 1,
      cardSobrepoeComposer: r.bottom > composer.top + 0.5,
      botoes: buttons,
    };
  });
  out.cartaoPermissao = card;
  out.distanciaFimComPermissaoPx = round(await distanceToBottom());
  await shot('light-09-permissao');

  await page.locator('.permission-allow').first().click();
  await until('permissão respondida', async () => !(await hasCount(page.locator('.permission-card'))), 30_000);
  await until('turno termina após permissão', () => statusIs('idle'), 60_000);

  // Roda do mouse (ou dedo) para cima e depois para baixo: tem de levar às mensagens mais novas.
  await scrollTimelineTo(0);
  await page.waitForTimeout(200);
  const top = await timelineScrollTop();
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 1800);
  await page.waitForTimeout(800);
  const afterDown = await timelineScrollTop();
  out.rolagemParaBaixoAvanca = afterDown > top + 200;
  out.distanciaFimAposRolarPx = round(await distanceToBottom());
  out.ultimaMensagemVisivel = await page.evaluate(() => {
    const feed = document.querySelector('.chat-feed');
    const last = feed?.lastElementChild;
    const timeline = document.querySelector('.chat-timeline').getBoundingClientRect();
    if (!last) return false;
    const r = last.getBoundingClientRect();
    return r.bottom <= timeline.bottom + 1 && r.bottom > timeline.top;
  });
  log(`layout: ${JSON.stringify(out)}`);
  return { layout: out };
}

// ---------- processo ----------

async function main() {
  mkdirSync(shotsDir, { recursive: true });
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
  cdp = await context.newCDPSession(page);
  if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await pairAndWorkspace();
  await newFakeSession();
  log('sessão criada; primeiro turno (conversa vazia no início)');

  result.streamVazio = await streamTurn({ scrollUp: false });
  log(`streaming (conversa crescendo): ${JSON.stringify(result.streamVazio)}`);

  result.streamPesado = await streamTurn({ scrollUp: true });
  log(`streaming com a conversa longa e o usuário subindo: ${JSON.stringify(result.streamPesado)}`);

  result.abrirConversa = await coldOpen();
  log(`abrir a conversa longa: ${JSON.stringify(result.abrirConversa)}`);

  result.voltarAoChat = await backAndReturn();
  log(`voltar ao chat: ${JSON.stringify(result.voltarAoChat)}`);

  Object.assign(result, await visualChecks());
  Object.assign(result, await layoutChecks());
  log(`checagens visuais: ${JSON.stringify({ botaoIrParaFim: result.botaoIrParaFim, scrollDuplo: result.scrollDuplo, overflowHorizontal: result.overflowHorizontal, composerVisivelComTeclado: result.composerVisivelComTeclado })}`);

  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  console.log(`[chatperf] RESULTADO ${JSON.stringify(result, null, 2)}`);
  log('medição do chat OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[chatperf] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
