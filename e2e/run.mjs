/*
 * E2E do Nanachi Remote: dirige o PWA buildado num Edge/Chrome headless com viewport de iPhone.
 *
 * Como rodar (a partir da raiz, com o daemon já no ar e pareado):
 *   1. npm run build
 *   2. NANACHI_HOME=<dir> node packages/daemon/dist/main.js     (config.json com port 7790 e allowedRoots)
 *   3. NANACHI_HOME=<dir> npm run pair -w @nanachi/daemon        (anote o código de 6 dígitos)
 *   4. npm run e2e -- --pair-code 123456 --root-name <nome da raiz no seletor de pastas>
 *
 * Variáveis opcionais: E2E_BASE_URL (default http://127.0.0.1:7790), E2E_BROWSER_CHANNEL (msedge|chrome),
 * E2E_PROJECT_DIR (pasta da raiz usada no teste; se tiver a subpasta "exemplos", o teste navega até ela).
 * Screenshots vão para e2e/screenshots/.
 *
 * O prompt real ao omp usa a assinatura do usuário: o fluxo manda um prompt só.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = join(here, 'screenshots');
mkdirSync(shotsDir, { recursive: true });

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:7790';
const pairCode = arg('pair-code') ?? process.env.E2E_PAIR_CODE;
const rootName = arg('root-name') ?? process.env.E2E_ROOT_NAME;
const projectDir = process.env.E2E_PROJECT_DIR;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
if (!pairCode || !rootName) {
  console.error('uso: npm run e2e -- --pair-code <6 dígitos> --root-name <nome da raiz>');
  process.exit(2);
}

const log = (line) => console.log(`[e2e] ${line}`);
const consoleErrors = [];

const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext({
  ...devices['iPhone 14'],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleErrors.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
/** URLs /api/ guardadas em qualquer CacheStorage da origem (o SW deve usar NetworkOnly para elas). */
async function apiUrlsInCaches() {
  return page.evaluate(async () => {
    const found = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith('/api/')) found.push(request.url);
      }
    }
    return found;
  });
}

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

/** Espera até `check` devolver verdadeiro (polling curto). Em falha, tira screenshot. */
async function until(description, check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      await shot(`fail-${description.replace(/\W+/g, '-')}`);
      throw new Error(`tempo esgotado esperando: ${description}`);
    }
    await page.waitForTimeout(150);
  }
}

const button = (name) => page.getByRole('button', { name, exact: true });
const headerTitle = (text) => page.locator('.app-title', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`.pill-${status}`));

async function runFlow() {
  // 1. Pareamento
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844 }, 'viewport precisa ser 390x844');
  await page.fill('input[placeholder="000000"]', pairCode);
  await button('Parear').click();
  await until('status online na home', () => hasCount(page.locator('.status-card.status-online')));
  await shot('01-home-online');

  // 2. Workspaces
  await button('Workspaces').click();
  await headerTitle('Workspaces').waitFor();
  await shot('02-workspaces-vazio');

  // 3. Navegador de pastas
  await button('+ Workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('.item-title', { hasText: rootName }).click();
  await page.locator('.app-header .muted', { hasText: rootName }).waitFor();
  await shot('03-pastas-raiz');
  const subfolder = 'exemplos';
  if (projectDir !== undefined && (await hasCount(page.locator('.item-title', { hasText: subfolder })))) {
    await page.locator('.item-title', { hasText: subfolder }).click();
    await page.locator('.app-header .muted', { hasText: subfolder }).waitFor();
    await shot('04-pasta-subpasta');
    await button('↑ Pasta acima').click();
    await page.locator('.app-header .muted', { hasText: rootName }).waitFor();
  }
  await button('Usar esta pasta').click();
  await headerTitle('Workspaces').waitFor();
  const workspaceName = projectDir !== undefined ? projectDir.split(/[\\/]/).pop() : rootName;
  const workspaceRow = page.locator('.item-main', { hasText: workspaceName }).first();
  await workspaceRow.waitFor();
  await shot('05-workspaces-com-proj');

  // 4. Sessões do workspace e folha de nova sessão
  await workspaceRow.click();
  await button('+ Nova sessão').click();
  await page.getByRole('dialog', { name: 'Nova sessão' }).waitFor();
  await shot('06-folha-nova-sessao');
  await page.locator('.agent-choice', { hasText: 'Oh My Pi' }).click();
  await button('Criar sessão').click();

  // 5. Chat: prompt real ao omp
  await until('sessão ociosa (Pronta)', () => statusIs('idle'), 90_000);
  await shot('07-chat-pronto');
  await page.locator('.chat-textarea').fill('Create a file named hello.txt containing exactly: hi');
  await button('Enviar').click();
  await until('cartão de tool call aparece', () => hasCount(page.locator('.tool-card')), 120_000);
  await shot('08-chat-streaming-tool');
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 180_000);
  await page.waitForTimeout(500);
  await shot('09-chat-fim-turno');

  const onDisk = readFileSync(join(projectDir ?? '', 'hello.txt'), 'utf8').trim();
  assert.equal(onDisk, 'hi', 'hello.txt no disco');
  log('hello.txt conferido no disco');

  // 6. Seletores de Acesso / Modelo / Effort refletem a troca
  for (const label of ['Acesso', 'Modelo', 'Effort']) {
    const select = page.locator('.config-select', { hasText: label }).locator('select');
    const current = await select.inputValue();
    const values = await select.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
    const next = values.find((value) => value !== current);
    if (next === undefined) {
      log(`${label}: só uma opção (${current}), sem troca`);
      continue;
    }
    await select.selectOption(next);
    await until(`${label} refletido como ${next}`, async () => (await select.inputValue()) === next, 10_000);
    log(`${label}: ${current} -> ${next}`);
  }
  await shot('10-chat-seletores-trocados');

  // 7. Recarregar: a página volta à home (estado de navegação é em memória) e o histórico reaparece sem duplicar.
  await page.reload({ waitUntil: 'networkidle' });
  await until('home online após reload', () => hasCount(page.locator('.status-card.status-online')));
  await button('Workspaces').click();
  await workspaceRow.click();
  await page.locator('.item-main', { hasText: 'Create a file named' }).first().click();
  await until('histórico recarregado', () => hasCount(page.locator('.bubble-user')));
  await page.waitForTimeout(800);
  const userBubbles = await page.locator('.bubble-user').count();
  const toolCards = await page.locator('.tool-card').count();
  assert.equal(userBubbles, 1, 'mensagem do usuário não pode duplicar após reload');
  assert.equal(toolCards, 1, 'cartão de tool call não pode duplicar após reload');
  const selectedEffort = await page.locator('.config-select', { hasText: 'Effort' }).locator('select').inputValue();
  log(`após reload: ${userBubbles} mensagem, ${toolCards} tool call, Effort=${selectedEffort}`);
  await shot('11-chat-apos-reload');

  // 8. Voltar com history.back: chat -> sessões -> workspaces.
  await page.goBack({ waitUntil: 'commit' });
  await until('voltou para a lista de sessões', () => hasCount(page.locator('button', { hasText: '+ Nova sessão' })));
  await shot('12-voltar-para-sessoes');
  await page.goBack({ waitUntil: 'commit' });
  await headerTitle('Workspaces').waitFor();
  log('history.back: chat -> sessões -> workspaces OK');

  // 9. Permissão com o agente falso: cartão aparece, aprovar, cartão some e o turno termina.
  await page.locator('.item-main', { hasText: workspaceName }).first().click();
  await button('+ Nova sessão').click();
  await page.locator('.agent-choice', { hasText: 'Fake' }).click();
  await button('Criar sessão').click();
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  await page.locator('.chat-textarea').fill('please ask permission now');
  await button('Enviar').click();
  await until('cartão de permissão aparece', () => hasCount(page.locator('.permission-card')), 30_000);
  await until('status aguardando permissão', () => statusIs('awaiting_permission'), 10_000);
  await shot('13-permissao-pendente');
  await page.locator('.permission-card').getByRole('button', { name: 'Permitir', exact: true }).click();
  await until('cartão de permissão some', async () => !(await hasCount(page.locator('.permission-card'))), 10_000);
  await until('turno termina após permissão', () => statusIs('idle'), 30_000);
  await page.waitForTimeout(300);
  await shot('14-permissao-aprovada');
  await page.locator('.agent-text', { hasText: 'Escolhida: allow' }).waitFor();
  log('permissão: cartão apareceu, foi aprovado, sumiu e o turno terminou');

  // 10. Nenhuma resposta /api pode estar guardada em CacheStorage (SW com NetworkOnly).
  const cached = await apiUrlsInCaches();
  assert.deepEqual(cached, [], '/api não pode estar em CacheStorage');
}

try {
  await runFlow();
} finally {
  await browser.close();
}
assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
log('fluxo OK');

