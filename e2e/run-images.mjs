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

/** Campo do composer do chat (o mesmo seletor dos outros E2E de chat). */
const composerField = () => page.locator('[data-slot="chat-textarea"]');

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
const headerTitle = (text) => page.locator('h1', { hasText: text });
const hasCount = (locator) => locator.count().then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`[data-status="${status}"]`));
/** Imagem carregada (blob já virou <img> com tamanho). */
const loaded = (locator) => locator.evaluate((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0);

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
  daemonToken = await page.evaluate(() => {
    const machines = JSON.parse(localStorage.getItem('nanachi.machines') ?? '[]');
    return machines[0]?.token ?? '';
  });
  assert.ok(daemonToken.length > 0, 'token do dispositivo salvo no PWA');

  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await headerTitle('Workspaces').waitFor();
  await button('Adicionar workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('ul[aria-label="Pastas"] > li button', { hasText: 'proj' }).click();
  await page.locator('h1 + p', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().waitFor();
}

/** Abre o cartão de tool call cujo título começa com `title` (o n-ésimo, se houver mais de um). */
function toolCard(title, nth = 0) {
  return page.locator('[data-slot="tool-card"]', { has: page.locator('[data-slot="tool-title"]', { hasText: title }) }).nth(nth);
}

/**
 * Tela cheia: abre pela miniatura, espera a imagem carregar, confere o botão Fechar (alvo de 44px, dentro da tela)
 * e a página travada, tira a foto e fecha: pelo X (`closeWith` = 'X') ou pelo voltar do navegador ('voltar').
 */
async function viewerRoundTrip(thumb, name, shotName, closeWith) {
  await thumb.click();
  await page.locator('[data-slot="file-viewer"]').waitFor();
  await until(`${name} carregou no visualizador`, () => loaded(page.locator('[data-slot="file-viewer-image"]')));
  assert.equal(await page.locator('[data-slot="file-viewer-name"]').innerText(), name, `visualizador mostra ${name}`);
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'página travada com o visualizador aberto');
  const close = page.getByRole('button', { name: 'Fechar', exact: true });
  const target = await close.boundingBox();
  const closeCount = await close.count();
  assert.ok(
    target !== null && target.width >= 44 && target.height >= 44,
    `botão Fechar com alvo de 44px (encontrados ${closeCount}, caixa ${JSON.stringify(target)})`,
  );
  assert.ok(target.y >= 0 && target.x >= 0 && target.x + target.width <= 390, 'botão Fechar inteiro na tela');
  await shot(shotName);
  if (closeWith === 'voltar') await page.goBack();
  else await close.click();
  await page.locator('[data-slot="file-viewer"]').waitFor({ state: 'detached' });
  await page.locator('[data-slot="chat-timeline"]').waitFor();
  assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'rolagem liberada ao fechar');
}

// ---------- fluxo ----------

async function stepImagesInChat() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);

  await page.locator('[data-slot="chat-textarea"]').fill('img-inline img-arquivo');
  await button('Enviar').click();
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(400);

  // 1) Imagem em mensagem do agente: miniatura no fluxo do chat, carregada por blob.
  const messageThumb = page.locator('[data-slot="chat-timeline"] [data-slot="file-attachment"] [data-slot="file-thumb"]');
  await until('miniatura da mensagem do agente', () => hasCount(messageThumb));
  await until('miniatura da mensagem carregou', () => loaded(messageThumb.locator('img')));

  // 2) Tool images remain available by expanding the activity and its individual row.
  for (const activity of await page.locator('[data-slot="tool-activity"]').all()) {
    if (!(await activity.evaluate((element) => element.open))) {
      await activity.locator(':scope > [data-slot="tool-activity-summary"]').click();
    }
  }
  const imageCard = toolCard('Ler teste.png');
  if (!(await imageCard.evaluate((element) => element.open))) {
    await imageCard.locator(':scope > summary').click();
  }
  const toolThumb = toolCard('Ler teste.png').locator('[data-slot="file-thumb"]');
  await until('miniatura dentro do tool call', () => hasCount(toolThumb));
  await until('miniatura do tool call carregou', () => loaded(toolThumb.locator('img')));

  // 3) Arquivo local dentro do workspace: cartão fechado; abre e a miniatura aparece.
  const linkCard = toolCard('Ler arquivo', 0);
  await linkCard.locator('summary').click();
  const linkThumb = linkCard.locator('[data-slot="file-thumb"]');
  await until('miniatura do arquivo local', () => hasCount(linkThumb));
  await until('miniatura do arquivo local carregou', () => loaded(linkThumb.locator('img')));

  // 4) Arquivo fora das raízes: o cartão não tem miniatura nenhuma.
  const outsideCard = toolCard('Ler arquivo', 1);
  await outsideCard.locator('summary').click();
  await page.waitForTimeout(300);
  assert.equal(await outsideCard.locator('[data-slot="file-thumb"]').count(), 0, 'arquivo fora das raízes não vira imagem');

  await shot('01-chat-imagens');

  // 5) Toque abre o visualizador em tela cheia, nos três casos. A imagem do tool call é a mesma da mensagem
  // (mesmo conteúdo): o daemon reaproveita o arquivo imagem-1 e o tool call mostra o nome genérico.
  // Fecha uma vez pelo X, outra pelo voltar do navegador (o chat continua aberto nos dois casos).
  await viewerRoundTrip(messageThumb.first(), 'imagem-1.png', '02-visualizador-mensagem', 'X');
  await viewerRoundTrip(toolThumb.first(), 'imagem.png', '03-visualizador-tool-call', 'voltar');
  // Arquivo local também chega como ToolContent image: mesmo nome genérico do tool call.
  await viewerRoundTrip(linkThumb.first(), 'imagem.png', '04-visualizador-arquivo-local', 'X');

  const alts = await page.locator('[data-slot="file-thumb"] img').evaluateAll((imgs) => imgs.map((img) => img.alt));
  log(`miniaturas no chat: ${alts.join(' | ')}`);
  assert.deepEqual(alts, ['imagem-1.png', 'imagem.png', 'imagem.png'], 'três miniaturas: mensagem, tool call, arquivo local');
}

/** Fotos dos dois temas: topo da conversa e a parte com as miniaturas do tool call. */
async function themeShots(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
  await page.locator('[data-slot="chat-timeline"]').evaluate((el) => {
    el.scrollTop = 0;
  });
  await shot(`05-chat-${theme}-topo`);
  await page.locator('[data-slot="chat-timeline"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shot(`06-chat-${theme}-fim`);
  const sample = await page.locator('[data-slot="file-thumb"]').first().evaluate((el) => getComputedStyle(el).borderRadius);
  log(`tema ${theme}: raio da miniatura ${sample}`);
}

/**
 * Aviso de atualização flutuando acima do composer. O hook de atualização só escuta `controllerchange` com a página
 * já controlada pelo service worker, por isso recarrega antes. Não há versão nova publicada no teste: o evento é
 * simulado. Se a página não ficar controlada (navegador sem service worker ativo), o passo é pulado com aviso,
 * porque o evento não teria efeito e o teste ficaria instável.
 */
async function stepUpdatePill(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.reload({ waitUntil: 'networkidle' });
  const field = composerField();
  await field.waitFor({ timeout: 20_000 });
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  if (!controlled) {
    log(`aviso de atualização (${theme}): PULADO. A página não está controlada por um service worker neste navegador.`);
    return;
  }
  await field.fill('texto ainda não enviado');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  const pill = page.locator('[role="status"]', { hasText: 'Nova versão do Nanachi' });
  await pill.waitFor({ timeout: 5_000 });
  const pillBox = await pill.boundingBox();
  const fieldBox = await field.boundingBox();
  assert.ok(pillBox !== null && fieldBox !== null, 'aviso e campo têm caixa');
  assert.ok(pillBox.y + pillBox.height <= fieldBox.y, 'aviso fica acima do composer, sem cobrir o campo');
  const back = await page.getByRole('button', { name: 'Voltar', exact: true }).boundingBox();
  assert.ok(back === null || pillBox.y > back.y + back.height, 'aviso não cobre o botão Voltar');
  await redesignShot('aviso-atualizacao', theme);
  await field.fill('');
}

// ---------- redesign: histórico do composer, zoom do visualizador, recorte e anexo ----------

const REDESIGN_DIR = join(here, 'screenshots', 'redesign');

/** Foto da redesign: o tema vai no nome. A pasta não é apagada a cada execução. */
async function redesignShot(name, theme) {
  mkdirSync(REDESIGN_DIR, { recursive: true });
  await page.screenshot({ path: join(REDESIGN_DIR, `${name}-${theme}.png`) });
  log(`screenshot redesign ${name}-${theme}`);
}

/** Escala do visualizador (1 = tamanho de repouso), lida do transform do elemento de zoom da biblioteca. */
async function viewerScale() {
  return page.locator('[data-slot="file-viewer"] .react-transform-component').evaluate((element) => {
    const match = /scale\(([\d.]+)\)/.exec(element.style.transform);
    return match === null ? 1 : Number(match[1]);
  });
}

async function openViewer(thumb) {
  await thumb.click();
  await page.locator('[data-slot="file-viewer"]').waitFor();
  await until('imagem do visualizador carregou', () => loaded(page.locator('[data-slot="file-viewer-image"]')));
}

/** Arrasto com o mouse (gera eventos de ponteiro): desce `dy` px a partir do centro da imagem. */
async function dragImage(dy) {
  const box = await page.locator('[data-slot="file-viewer-image"]').boundingBox();
  assert.ok(box !== null, 'imagem com caixa para arrastar');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 12 });
  await page.mouse.up();
}

/**
 * Um tema inteiro: setas do histórico (teclado e botões), zoom por toque duplo com arrasto que pana ou fecha
 * conforme a escala, recorte com "Anexar ao chat" e recorte de um anexo da prévia. Cada passo tira uma foto.
 */
async function redesignFlow(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
  const field = page.locator('[data-slot="chat-textarea"]');

  // Histórico: com o cursor no início, ↑ recupera a mensagem enviada; com o cursor no fim, ↓ volta ao rascunho.
  await field.fill('rascunho');
  await field.press('Home');
  await field.press('ArrowUp');
  assert.equal(await field.inputValue(), 'img-inline img-arquivo', 'seta para cima recupera a mensagem enviada');
  await redesignShot('composer-historico', theme);
  await field.press('ArrowDown');
  assert.equal(await field.inputValue(), 'rascunho', 'seta para baixo passa da mais nova e volta ao rascunho');

  // Botões pelo toque: o foco continua no campo (o teclado do iPhone não fecha).
  await button('Mensagem anterior').click();
  assert.equal(await field.inputValue(), 'img-inline img-arquivo', 'botão Mensagem anterior recupera');
  assert.equal(await field.evaluate((element) => element === document.activeElement), true, 'toque no botão mantém o foco no campo');
  await button('Próxima mensagem').click();
  assert.equal(await field.inputValue(), 'rascunho', 'botão Próxima mensagem restaura o rascunho');
  await field.fill('');

  // Zoom: toque duplo amplia; arrastar ampliada faz pan (não fecha); outro toque duplo volta à escala 1.
  const messageThumb = page.locator('[data-slot="chat-timeline"] [data-slot="file-attachment"] [data-slot="file-thumb"]').first();
  await openViewer(messageThumb);
  assert.equal(await viewerScale(), 1, 'visualizador abre na escala 1');
  // A biblioteca de zoom desliga o ponteiro da imagem: o toque duplo vai no palco, onde a foto está no centro.
  await page.locator('[data-slot="file-viewer-stage"]').dblclick();
  await until('toque duplo amplia', async () => (await viewerScale()) > 1.5);
  await redesignShot('visualizador-zoom', theme);
  await dragImage(160);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-slot="file-viewer"]').count(), 1, 'arrastar ampliada não fecha o visualizador');
  // A biblioteca de zoom desliga o ponteiro da imagem: o toque duplo vai no palco, onde a foto está no centro.
  await page.locator('[data-slot="file-viewer-stage"]').dblclick();
  await until('segundo toque duplo volta à escala 1', async () => (await viewerScale()) === 1);

  // Na escala 1, arrastar para baixo fecha.
  await dragImage(160);
  await page.locator('[data-slot="file-viewer"]').waitFor({ state: 'detached' });

  // Recorte e "Anexar ao chat": a imagem recortada entra como anexo da prévia.
  await openViewer(messageThumb);
  await button('Recortar').click();
  await page.locator('[data-slot="image-cropper"]').waitFor();
  await redesignShot('recorte', theme);
  await button('Ver recorte').click();
  await page.locator('[data-slot="file-viewer-result"]').waitFor();
  await until('resultado do recorte carregou', () => loaded(page.locator('[data-slot="file-viewer-result"]')));
  await button('Anexar ao chat').click();
  await page.locator('[data-slot="file-viewer"]').waitFor({ state: 'detached' });
  const chip = page.locator('[data-slot="draft-list"] [data-slot="draft-thumb"]');
  await until('recorte entrou como anexo', () => hasCount(chip));
  assert.equal(await chip.getAttribute('alt'), 'imagem-1-recorte.png', 'anexo recebe o nome do recorte');

  // Recorte de um anexo da prévia: o resultado troca o anexo.
  await page.getByRole('button', { name: 'Recortar imagem-1-recorte.png', exact: true }).click();
  await page.getByRole('dialog', { name: 'Recortar imagem' }).waitFor();
  await button('Usar recorte').click();
  await page.getByRole('dialog', { name: 'Recortar imagem' }).waitFor({ state: 'detached' });
  await until('anexo trocado pelo recorte', async () => (await chip.getAttribute('alt')) === 'imagem-1-recorte-recorte.png');
  await redesignShot('composer-anexo-recortado', theme);

  await page.getByRole('button', { name: 'Remover imagem-1-recorte-recorte.png', exact: true }).click();
  await until('prévia limpa', async () => !(await hasCount(chip)));
  log(`fluxo da redesign (${theme}) OK`);
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
  await redesignFlow('dark');
  await redesignFlow('light');
  await stepUpdatePill('dark');
  await stepUpdatePill('light');
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
