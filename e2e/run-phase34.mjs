/*
 * E2E das fases 3 e 4 do Nanachi Remote: anexos do celular, arquivos do PC (phone-send), terminal (PTY),
 * silenciar workspace e Ajustes. Sobe o daemon buildado numa pasta temporária, pareia pelo CLI e dirige o PWA
 * buildado num Edge headless com viewport de iPhone 14 (390x844). Nenhum agente real: o agente é o fake
 * (packages/daemon/test/fixtures/fake-agent.ts) e o terminal é o powershell.exe.
 *
 * Como rodar (a partir da raiz, depois de `npm run build`):
 *   npm run e2e:34
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, porta 7794 livre. Tudo fica em
 * $TEMP/nanachi-e2e34-<rand> (config.json, data.db, pids do fake, proj/) e é apagado no fim.
 * Screenshots: e2e/screenshots/phase34/. Variável opcional: E2E_BROWSER_CHANNEL (default msedge).
 *
 * Atenção: o passo de captura de tela (`phone-send --screenshot`) grava uma imagem da área de trabalho
 * real do PC; ela só existe em memória/no diretório temporário e é apagada com o resto.
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
const shotsDir = join(here, 'screenshots', 'phase34');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const phoneSendJs = join(repoRoot, 'packages', 'daemon', 'dist', 'phone-send.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7794;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2e34] ${line}`);

const home = join(tmpdir(), `nanachi-e2e34-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
let daemonToken = '';
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

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
  writeFileSync(join(projDir, 'relatorio.txt'), `Relatório do teste de fase 3.\n${'linha de teste\n'.repeat(60)}`);
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-fases-3-4',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
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

// ---------- API direta (token do próprio PWA) ----------

async function apiGet(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${daemonToken}` } });
  assert.equal(res.status, 200, `GET ${path} → ${res.status}`);
  return res.json();
}

async function workspaceId() {
  const { workspaces } = await apiGet('/api/workspaces');
  const found = workspaces.find((workspace) => workspace.path.endsWith('proj'));
  assert.ok(found, 'workspace proj existe');
  return found.id;
}

/** Sessão mais recente do agente `agent` no workspace do proj. */
async function latestSession(agent) {
  const { sessions } = await apiGet(`/api/workspaces/${await workspaceId()}/sessions`);
  const found = sessions.find((session) => session.agent === agent);
  assert.ok(found, `sessão do agente ${agent}`);
  return found;
}

function readPrompts(sessionId) {
  const file = join(pidDir, `${sessionId}.prompts.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function readAgentEnv(sessionId) {
  return JSON.parse(readFileSync(join(pidDir, `${sessionId}.env.json`), 'utf8'));
}

// ---------- PNG pequeno gerado em memória (gradiente) ----------

function makePng(width, height) {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = Math.round((x / width) * 255);
      raw[offset + 1] = Math.round((y / height) * 255);
      raw[offset + 2] = 180;
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
  ihdr[8] = 8; // profundidade de bits
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- helpers de página ----------

let page;

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
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
const headerTitle = (text) => page.locator('h1', { hasText: text });
const countOf = (locator) => locator.count();
const hasCount = (locator) => countOf(locator).then((n) => n > 0);
const statusIs = (status) => hasCount(page.locator(`[data-status="${status}"]`));
const terminalText = () => page.locator('[data-slot="terminal-view"]').innerText().catch(() => '');
const occurrences = (text, needle) => text.split(needle).length - 1;

/** Volta pelo botão "Voltar" até a lista de workspaces (ou usa "Workspaces" da home). */
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

/** Volta pelo "Voltar" até a home da máquina (cartão de status). */
async function goHome() {
  for (let step = 0; step < 6; step += 1) {
    if (await hasCount(page.getByRole('region', { name: 'Estado da máquina' }))) return;
    if (await hasCount(page.getByRole('button', { name: 'Voltar', exact: true }))) {
      await button('Voltar').click();
    }
    await page.waitForTimeout(150);
  }
  await until('home', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' })));
}

/** Abre a sessões do workspace proj a partir da lista de workspaces. */
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

// ---------- fluxo ----------

async function pairAndWorkspace() {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: 390, h: 844}, 'viewport precisa ser 390x844');
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
  await shot('00-workspace-proj');
}

/** Passo 1: anexo do celular (imagem) na prévia, envio e prompt com bloco image para o fake. */
async function stepAttachment() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  await shot('01-chat-fake-pronto');

  const png = join(home, 'anexo-teste.png');
  writeFileSync(png, makePng(96, 64));
  await page.locator('input[type="file"]').setInputFiles(png);
  await until('miniatura na prévia', () => hasCount(page.locator('[data-slot="draft-list"] [data-slot="draft-thumb"]')));
  await until('miniatura carregou', () =>
    page.locator('[data-slot="draft-thumb"]').evaluate((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0),
  );
  await shot('02-anexo-na-previa');

  await page.locator('[data-slot="chat-textarea"]').fill('Veja a imagem anexada');
  await button('Enviar').click();
  await until('prévia limpa após envio', async () => !(await hasCount(page.locator('[data-slot="draft-list"] [data-slot="draft-thumb"]'))));
  await until('mensagem do usuário com anexo', () => hasCount(page.locator('[data-slot="bubble-user"] [data-slot="file-thumb"] img')), 20_000);
  await until('miniatura da mensagem carregou', () =>
    page.locator('[data-slot="bubble-user"] [data-slot="file-thumb"] img').evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(300);
  await shot('03-mensagem-com-anexo');

  const bubble = await page.locator('[data-slot="bubble-user"]').first().innerText();
  assert.ok(bubble.includes('Veja a imagem anexada'), 'texto da mensagem aparece na bolha');

  const session = await latestSession('fake');
  const prompts = readPrompts(session.id);
  assert.equal(prompts.length, 1, 'o fake recebeu um prompt');
  const blocks = prompts[0];
  const image = blocks.find((block) => block.type === 'image');
  assert.ok(image, 'o prompt traz um bloco image');
  assert.equal(image.mimeType, 'image/png', 'bloco image com mimeType image/png');
  assert.ok(image.data.length > 100, 'bloco image com dados base64');
  const text = blocks.find((block) => block.type === 'text');
  assert.ok(text && text.text === 'Veja a imagem anexada', 'texto do prompt sem caminho de anexo');
  log(`anexo: prompt com bloco image (${image.data.length} chars base64) e texto limpo`);
}

/** Passo 2: phone-send de arquivo de texto e de captura de tela, a partir do env real da sessão. */
async function stepPhoneSend() {
  const session = await latestSession('fake');
  const env = readAgentEnv(session.id);
  const agentEnv = {
    ...process.env,
    AGENT_SESSION_ID: env.AGENT_SESSION_ID,
    NANACHI_URL: env.NANACHI_URL,
    NANACHI_AGENT_TOKEN: env.NANACHI_AGENT_TOKEN,
  };

  const textOut = execFileSync(process.execPath, [phoneSendJs, 'relatorio.txt', '--caption', 'Resultado do teste'], {
    cwd: projDir,
    env: agentEnv,
    encoding: 'utf8',
  });
  assert.match(textOut, /enviado: relatorio\.txt/);
  const shotOut = execFileSync(process.execPath, [phoneSendJs, '--screenshot', '--caption', 'Print da tela'], {
    cwd: projDir,
    env: agentEnv,
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.match(shotOut, /enviado: captura-.*\.png/);
  log(`phone-send: ${textOut.trim()} | ${shotOut.trim()}`);

  await until('cartão do arquivo de texto', () => hasCount(page.locator('[data-slot="file-card"]')), 20_000);
  // A captura é a figura com a legenda "Print da tela" (o anexo do passo 1 também é um [data-slot="file-attachment"]).
  const capture = page.locator('figure[data-slot="file-attachment"]', { hasText: 'Print da tela' });
  await until('miniatura da captura', () => hasCount(capture.locator('[data-slot="file-thumb"] img')), 20_000);
  await until('captura carregou (blob)', () =>
    capture.locator('[data-slot="file-thumb"] img').evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  const src = await capture.locator('[data-slot="file-thumb"] img').getAttribute('src');
  assert.ok(src?.startsWith('blob:'), 'miniatura vem de um blob: (fetch com Bearer)');

  const card = page.locator('[data-slot="file-card"]').first();
  assert.equal(await card.locator('[data-slot="file-name"]').innerText(), 'relatorio.txt');
  const sizeText = await card.locator('[data-slot="file-size"]').innerText();
  log(`cartão do arquivo: relatorio.txt, ${sizeText}`);
  assert.ok(/KB|B$/.test(sizeText), 'tamanho do arquivo aparece no cartão');
  assert.equal(await page.locator('[data-slot="file-caption"]', { hasText: 'Resultado do teste' }).count(), 1, 'legenda do arquivo');
  assert.equal(await capture.locator('[data-slot="file-caption"]', { hasText: 'Print da tela' }).count(), 1, 'legenda da captura');
  await shot('04-arquivos-do-pc-no-chat');

  await capture.locator('[data-slot="file-thumb"]').click();
  await page.locator('[data-slot="file-viewer"]').waitFor();
  await until('imagem em tela cheia carregou', () =>
    page.locator('[data-slot="file-viewer-image"]').evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await shot('05-captura-tela-cheia');
  // Fecha pelo voltar do navegador: só o visualizador sai, o chat continua na tela.
  await page.goBack();
  await page.locator('[data-slot="file-viewer"]').waitFor({ state: 'detached' });
  await page.locator('[data-slot="chat-timeline"]').waitFor();
}

/** Passo 3: terminal PTY (powershell.exe). Entrada, Ctrl+C, exit, reload sem duplicar. */
async function stepTerminal() {
  await newSession('Shell');
  await page.locator('[data-slot="terminal-view"] .xterm').waitFor({ timeout: 20_000 });
  await until('terminal pronto (running)', () => statusIs('running'), 20_000);
  await until('shell mostra prompt', async () => (await terminalText()).includes('PS '), 30_000);
  await shot('06-terminal-aberto');

  const line = page.locator('[data-slot="terminal-line"]');
  await line.fill('echo nanachi-ok');
  await button('Enviar').click();
  await until('saída do echo', async () => occurrences(await terminalText(), 'nanachi-ok') >= 2, 20_000);
  await shot('07-terminal-echo');

  await line.fill('Start-Sleep -Seconds 60');
  await button('Enviar').click();
  await page.waitForTimeout(1500);
  const promptsBefore = occurrences(await terminalText(), 'PS ');
  // The phone has no Ctrl key on screen now, so the interrupt goes from a physical keyboard through xterm.
  await page.locator('[data-slot="terminal-view"]').click();
  await page.keyboard.press('Control+c');
  // Espera o prompt voltar: digitar antes disso perde a linha (o PowerShell descarta a entrada ao interromper).
  await until('prompt volta após Ctrl+C', async () => occurrences(await terminalText(), 'PS ') > promptsBefore, 20_000);
  await line.fill('echo depois-ctrlc');
  await button('Enviar').click();
  await until('shell volta após Ctrl+C', async () => occurrences(await terminalText(), 'depois-ctrlc') >= 2, 20_000);
  await shot('09-terminal-ctrl-c');

  await line.fill('exit');
  await button('Enviar').click();
  await page.locator('[data-slot="terminal-closed"]').waitFor({ timeout: 20_000 });
  const exitLine = await page.locator('[data-slot="terminal-closed"]').innerText();
  assert.match(exitLine, /Terminal encerrado/);
  await until('pill de status encerrada', () => statusIs('stopped'), 10_000);
  assert.equal(await line.isDisabled(), true, 'linha de texto desabilitada após o exit');
  await shot('10-terminal-encerrado');
  const before = await terminalText();
  const countBefore = occurrences(before, 'nanachi-ok');
  log(`terminal antes do reload: nanachi-ok x${countBefore}; "${exitLine}"`);

  await page.reload({ waitUntil: 'networkidle' });
  // O app restaura a última rota (a sessão de terminal) ou volta para a home; os dois caminhos valem.
  await until('terminal ou home após reload', async () =>
    (await hasCount(page.locator('[data-slot="terminal-view"] .xterm'))) || (await hasCount(page.getByRole('region', { name: 'Estado da máquina' }))),
  );
  if (!(await hasCount(page.locator('[data-slot="terminal-view"] .xterm')))) {
    await until('home online após reload', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })));
    await openProjSessions();
    await page.locator('ul[aria-label="Sessões"] > li', { hasText: 'Nova sessão' }).getByRole('button').first().click();
  }
  await page.locator('[data-slot="terminal-view"] .xterm').waitFor({ timeout: 20_000 });
  await until('replay do terminal', async () => occurrences(await terminalText(), 'nanachi-ok') >= countBefore, 20_000);
  await page.waitForTimeout(800);
  const after = await terminalText();
  const countAfter = occurrences(after, 'nanachi-ok');
  assert.equal(countAfter, countBefore, 'saída não duplica após reload');
  assert.equal(await page.locator('[data-slot="terminal-notice"]').count(), 0, 'reload do terminal encerrado não mostra aviso de erro');
  // A faixa é um <p> irmão do terminal (não está no innerText do xterm).
  assert.equal(await page.locator('[data-slot="terminal-closed"]').count(), 1, 'faixa de encerramento aparece uma vez');
  assert.match(await page.locator('[data-slot="terminal-closed"]').innerText(), /Terminal encerrado/);
  await shot('11-terminal-apos-reload');
  log(`terminal após reload: nanachi-ok x${countAfter} (igual), faixa de encerramento OK`);
}

/**
 * The notifications row of the workspace's "..." menu, opened. Its text names the state ("Ligadas" or "Silenciadas"),
 * and a pick on it mutes or unmutes the workspace and closes the menu.
 */
async function openNotificationsRow() {
  await page.getByRole('button', { name: 'Mais ações de proj', exact: true }).click();
  const row = page.locator('[data-slot="action-sheet-item"]', { hasText: 'Notificações' });
  await row.waitFor();
  return row;
}

/** Whether the workspace is muted, read from the menu row. The menu is closed again. */
async function workspaceMuted() {
  const row = await openNotificationsRow();
  const muted = (await row.innerText()).includes('Silenciadas');
  await page.keyboard.press('Escape');
  return muted;
}

/** Passo 4: silenciar workspace persiste após reload; Ajustes renderiza o estado das notificações. */
async function stepMuteAndSettings() {
  await openProjSessions();
  assert.equal(await workspaceMuted(), false, 'workspace começa sem silenciar');
  await (await openNotificationsRow()).click();
  await until('silenciar confirmado pela API', async () => {
    const { workspaces } = await apiGet('/api/workspaces');
    return workspaces.find((workspace) => workspace.path.endsWith('proj'))?.muted === true;
  });
  await shot('12-silenciado');

  await page.reload({ waitUntil: 'networkidle' });
  await until('app recarregado', async () =>
    (await hasCount(page.getByRole('region', { name: 'Estado da máquina' }))) || (await hasCount(page.locator('h1'))),
  );
  await openProjSessions();
  await until('menu mantém silenciado após reload', () => workspaceMuted());
  log('silenciar: persiste após reload (UI e API)');

  await (await openNotificationsRow()).click();
  await until('desmutar confirmado pela API', async () => {
    const { workspaces } = await apiGet('/api/workspaces');
    return workspaces.find((workspace) => workspace.path.endsWith('proj'))?.muted === false;
  });
  await page.reload({ waitUntil: 'networkidle' });
  await openProjSessions();
  assert.equal(await workspaceMuted(), false, 'desmutar persiste');
  await shot('13-workspace-sem-silencio');

  await goHome();
  await until('home online para Ajustes', () => hasCount(page.getByRole('region', { name: 'Estado da máquina' }).getByText('Online', { exact: true })));
  await button('Ajustes').click();
  await headerTitle('Ajustes').waitFor();
  const notes = page.getByRole('region', { name: 'Notificações' });
  await notes.waitFor();
  await until('estado de notificações renderizado', async () =>
    (await notes.innerText()).match(/Desativadas|Ativas|não estão disponíveis/) !== null,
  );
  log(`Ajustes: ${(await notes.innerText()).split('\n').slice(0, 3).join(' | ')}`);
  await shot('14-ajustes-notificacoes');
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
  await stepAttachment();
  await stepPhoneSend();
  await stepTerminal();
  await stepMuteAndSettings();
  await checkStorageHasNoApi();
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  log('fluxo das fases 3 e 4 OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2e34] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
