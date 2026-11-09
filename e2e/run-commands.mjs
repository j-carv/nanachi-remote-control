/*
 * E2E dos comandos do agente (available_commands_update → menu no composer). Sobe o daemon buildado numa pasta
 * temporária, pareia pelo CLI e dirige o PWA buildado num Edge headless com viewport de iPhone 14 (390x844).
 * O agente é o fake (packages/daemon/test/fixtures/fake-agent.ts) com FAKE_AGENT_COMMANDS=1: anuncia /loop, /mcp,
 * /skill:brainstorming, /eco, /model (seletor nativo: a opção model da sessão) e /usage (dica com alternativas;
 * a resposta tem escapes ANSI); um segundo agente ("Sem comandos") não anuncia nada.
 * Menus nativos: /model abre o seletor (trocar não envia prompt; Enviar sem argumento abre o seletor; Esc fecha);
 * /mcp abre a folha de subcomandos ("reconnect" envia "/mcp reconnect"; "enable" só põe o texto no campo); /usage
 * mostra a resposta sem escapes ANSI.
 * Confere: "/" no começo do composer abre o menu acima do campo (sem cobrir o campo), a busca filtra, o toque
 * insere "/<nome> " e o campo mantém o foco; um comando também pode ser inserido antes de um rascunho; o comando
 * enviado vira prompt de texto e o fake responde ao /eco; a mensagem com comando aparece destacada; agente sem
 * comandos mostra "Este agente não anunciou comandos"; alvos de toque com 44px ou mais.
 * Screenshots nos dois temas (claro e escuro) em e2e/screenshots/commands/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:commands
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, porta 7802 livre. Tudo fica em
 * $TEMP/nanachi-e2ecmd-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'commands');
const redesignDir = join(here, 'screenshots', 'redesign');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');
const fakeAgentTs = join(repoRoot, 'packages', 'daemon', 'test', 'fixtures', 'fake-agent.ts');
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;

const PORT = 7802;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2ecmd] ${line}`);

const home = join(tmpdir(), `nanachi-e2ecmd-${randomBytes(4).toString('hex')}`);
const projDir = join(home, 'proj');
const pidDir = join(home, 'pids');
const logPath = join(home, 'daemon.log');

let daemon = null;
let browser = null;
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const fake = {
    command: process.execPath,
    args: ['--import', tsxEsm, fakeAgentTs],
    kind: 'acp',
  };
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-comandos',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {
      // Id "omp": the daemon maps the /usage command by agent id (agent-usage.ts), so the fake plays omp here.
      omp: {
        ...fake,
        label: 'Fake',
        env: { FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_COMMANDS: '1' },
      },
      mudo: {
        ...fake,
        label: 'Sem comandos',
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

let page;

async function shot(name) {
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  log(`screenshot ${name}`);
}

/** Screenshot into another folder (the redesign captures), created on first use. */
async function shotIn(dir, name) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
  log(`screenshot ${dir}/${name}`);
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
const composerValue = () => composer().inputValue();
const menu = () => page.locator('[data-slot="slash-menu"]');
const menuItems = () => page.locator('[data-slot="slash-item"]');

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

  await page.getByRole('button', { name: /^Workspaces (de|on|en) /u }).click();
  await headerTitle('Workspaces').waitFor();
  await button('Adicionar workspace').click();
  await headerTitle('Escolher pasta').waitFor();
  await page.locator('ul[aria-label="Pastas"] > li button', { hasText: 'proj' }).click();
  await page.locator('h1 + p', { hasText: 'proj' }).waitFor();
  await button('Usar esta pasta').click();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().waitFor();
}

/** Foco no campo: o teclado do iOS continua aberto depois de tocar um comando. */
const composerFocused = () => composer().evaluate((el) => document.activeElement === el);

/** A caixa do menu fica inteira acima do campo (não cobre o composer). */
async function menuAboveComposer() {
  const menuBox = await menu().boundingBox();
  const fieldBox = await composer().boundingBox();
  assert.ok(menuBox !== null && fieldBox !== null, 'menu e campo têm caixa');
  assert.ok(
    menuBox.y + menuBox.height <= fieldBox.y + 1,
    `menu acima do campo (${menuBox.y + menuBox.height} <= ${fieldBox.y})`,
  );
}

async function themeShots(theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
}

// ---------- fluxo ----------

async function stepTypedMenu() {
  await newSession('Fake');
  await until('sessão fake ociosa', () => statusIs('idle'), 60_000);
  // Os comandos chegam logo depois do session/new: o menu já tem a lista quando o chat abre.
  await until('menu lista os 6 comandos ao digitar /', async () => {
    await composer().fill('');
    await composer().pressSequentially('/');
    return (await menuItems().count()) === 6;
  });
  assert.equal(await menuItems().first().locator('[data-slot="slash-name"]').innerText(), '/loop');
  assert.ok(await hasCount(page.locator('[data-slot="slash-hint"]', { hasText: '[intervalo] [prompt]' })), 'dica do argumento aparece');
  assert.ok(
    await hasCount(page.locator('[data-slot="slash-desc"]', { hasText: 'Repete um prompt em intervalo' })),
    'descrição aparece',
  );
  await menuAboveComposer();
  assert.ok(await composerFocused(), 'digitar / mantém o foco no campo');
  await shot('01-menu-barra-escuro');
  await themeShots('light');
  await shot('02-menu-barra-claro');
  await themeShots('dark');

  // Filtro: "/mc" mostra só o /mcp; "/bra" acha a skill pelo meio do nome; sem casamento, aviso.
  await composer().fill('');
  await composer().pressSequentially('/mc');
  assert.deepEqual(await menuItems().locator('[data-slot="slash-name"]').allInnerTexts(), ['/mcp']);
  await composer().fill('');
  await composer().pressSequentially('/bra');
  assert.deepEqual(await menuItems().locator('[data-slot="slash-name"]').allInnerTexts(), ['/skill:brainstorming']);
  await composer().fill('');
  await composer().pressSequentially('/zzz');
  await page.locator('[data-slot="slash-empty"]', { hasText: 'Nenhum comando combina' }).waitFor();
  log('filtro: /mc, /bra e sem resultado OK');

  // Toque insere "/<nome> ", fecha o menu e mantém o foco no campo.
  await composer().fill('');
  await composer().pressSequentially('/ec');
  await page.locator('[data-slot="slash-item"]', { hasText: '/eco' }).tap();
  await until('campo recebe "/eco "', async () => (await composerValue()) === '/eco ');
  assert.equal(await menu().count(), 0, 'menu fecha depois de inserir');
  assert.ok(await composerFocused(), 'toque no comando mantém o foco no campo');

  // Texto depois do comando: a busca some quando há espaço.
  await composer().pressSequentially('oi');
  assert.equal(await composerValue(), '/eco oi');
  assert.equal(await menu().count(), 0, 'com espaço depois do comando, o menu não abre');
  log('inserção por toque e texto depois do comando OK');

  // /loop no menu não vai para o texto: abre a folha do Modo Loop (PLAN.md, "modo Loop").
  await composer().fill('');
  await composer().pressSequentially('/lo');
  await page.locator('[data-slot="slash-item"]', { hasText: '/loop' }).tap();
  await page.getByRole('dialog', { name: 'Modo Loop' }).waitFor();
  assert.equal(await composerValue(), '', '/loop pelo menu não escreve no campo');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Modo Loop' }).waitFor({ state: 'hidden' });
  log('/loop pelo menu abre o Modo Loop OK');

  // Envio: o comando vai como texto. O /eco do fake responde só com o texto que vem depois.
  await composer().fill('');
  await composer().pressSequentially('/eco');
  await page.locator('[data-slot="slash-item"]', { hasText: '/eco' }).tap();
  await composer().pressSequentially('oi, tudo bem');
  await button('Enviar').click();
  await until('turno termina (volta a Pronta)', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(300);

  const highlighted = page.locator('[data-slot="chat-timeline"] [data-slot="bubble-user"] [data-slot="command-token"]');
  await until('comando destacado na mensagem enviada', () => hasCount(highlighted));
  assert.equal(await highlighted.first().innerText(), '/eco', 'o token destacado é o comando');
  const userText = await page.locator('[data-slot="chat-timeline"] [data-slot="bubble-user"]').first().innerText();
  assert.match(userText, /\/eco oi, tudo bem/, 'mensagem inteira no balão');
  await page.locator('[data-slot="chat-timeline"] [data-slot="agent-text"]', { hasText: 'oi, tudo bem' }).first().waitFor();
  assert.equal(
    await page.locator('[data-slot="chat-timeline"] [data-slot="agent-text"]', { hasText: 'Eco:' }).count(),
    0,
    '/eco responde só com o texto, sem o eco padrão',
  );
  log('envio do comando e resposta do /eco OK');
  await page.locator('[data-slot="chat-timeline"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shot('03-chat-comando-enviado-escuro');
  await themeShots('light');
  await shot('04-chat-comando-enviado-claro');
  await themeShots('dark');
}

async function stepCommandBeforeDraft() {
  await composer().fill('revisa o parser');
  await composer().press('Home');
  await composer().pressSequentially('/ec');
  assert.deepEqual(await menuItems().locator('[data-slot="slash-name"]').allInnerTexts(), ['/eco']);
  await page.locator('[data-slot="slash-item"]', { hasText: '/eco' }).tap();
  await until('the command is inserted before the draft', async () => (await composerValue()) === '/eco revisa o parser');
  assert.equal(await menu().count(), 0, 'the menu closes after picking a command');
  assert.ok(await composerFocused(), 'the composer keeps focus');
  await composer().fill('');
  log('typing / preserves the draft when picking a command');
}

async function stepTouchTargets() {
  await composer().fill('/');
  await menuItems().first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Comandos do agente', exact: true }).count(), 0);
  const send = button('Enviar');
  assert.equal(await send.innerText(), '');
  assert.equal(await send.locator('svg').count(), 1);
  const sizes = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-slot="slash-item"], [data-slot="attach-button"], [data-slot="chat-input"] button[type="submit"]')];
    return boxes.map((el) => {
      const rect = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') ?? el.className, h: rect.height, w: rect.width };
    });
  });
  for (const size of sizes) {
    assert.ok(size.h >= 44 && size.w >= 44, `alvo de toque ${size.name} com ${size.w}x${size.h}`);
  }
  log(`alvos de toque ≥ 44px: ${sizes.length}`);
  await composer().fill('');
  await menu().waitFor({ state: 'detached' });
}

/** Lê os rótulos de uma folha de ações, na ordem em que aparecem. */
const sheetLabels = (sheet) => sheet.locator('[data-slot="action-sheet-label"]').allInnerTexts();
/** Valor do modelo: o seletor mora na folha "Configurar sessão", então ela abre, lê e fecha. */
async function modelValue() {
  await button('Configurar sessão').click();
  const value = await page.locator('[data-slot="config-select"][data-option="model"] select').inputValue();
  await page.keyboard.press('Escape');
  await page.locator('[data-slot="drawer-content"]').waitFor({ state: 'detached' });
  return value;
}
const userBubbles = () => page.locator('[data-slot="chat-timeline"] [data-slot="bubble-user"]').count();

async function stepNativePicker() {
  // Composer vazio (o passo anterior fechou o menu). "/mo" abre o menu; escolher /model abre o seletor nativo.
  await composer().fill('');
  await composer().pressSequentially('/mo');
  await page.locator('[data-slot="slash-item"]', { hasText: '/model' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Opções de /model' });
  await sheet.waitFor();
  assert.equal(await menu().count(), 0, 'menu fecha ao abrir a folha');
  assert.ok(await hasCount(page.locator('[data-slot="action-sheet-title"]', { hasText: '/model' })), 'título é /model');
  assert.deepEqual(
    await sheetLabels(sheet),
    ['Rápido', 'Potente', 'Enviar /model ao agente'],
    'opções do modelo e a linha de texto',
  );
  assert.equal(
    await sheet.locator('[aria-current="true"] [data-slot="action-sheet-label"]').innerText(),
    'Rápido',
    'o modelo atual vem marcado',
  );
  // The sheet enters with a 220ms animation (translateY + fade): wait for it before the screenshot.
  await page.waitForTimeout(350);
  await shot('09-sheet-modelo-escuro');
  await themeShots('light');
  await shot('10-sheet-modelo-claro');
  await themeShots('dark');

  // Trocar o modelo usa o mesmo caminho do seletor do topo: nenhum prompt é enviado.
  const bubbles = await userBubbles();
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'Potente' }).tap();
  await until('modelo virou slow-model pelo seletor', async () => (await modelValue()) === 'slow-model');
  await sheet.waitFor({ state: 'detached' });
  assert.equal(await userBubbles(), bubbles, 'trocar o modelo não envia mensagem');
  assert.equal(await composerValue(), '', 'o campo fica vazio depois da escolha');
  log('seletor nativo de /model troca o modelo sem prompt OK');

  // /model + Enviar (sem argumento) abre o seletor e não manda texto. Esc fecha e o campo fica vazio.
  await composer().fill('/model');
  await button('Enviar').click();
  await sheet.waitFor();
  assert.equal(await userBubbles(), bubbles, '/model enviado sem argumento não vira mensagem');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  assert.equal(await composerValue(), '', 'Esc fecha a folha e o campo continua vazio');

  // Linha "Enviar /model ao agente": o texto vai para o agente como prompt.
  await composer().pressSequentially('/mo');
  await page.locator('[data-slot="slash-item"]', { hasText: '/model' }).tap();
  await sheet.waitFor();
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'Enviar /model ao agente' }).tap();
  await until('/model enviado como texto', async () => (await userBubbles()) === bubbles + 1);
  const sent = page.locator('[data-slot="chat-timeline"] [data-slot="bubble-user"]').last();
  assert.equal(await sent.locator('[data-slot="command-token"]').innerText(), '/model', 'o texto enviado é /model');
  await until('turno termina depois de /model', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(300);
  log('/model + Enviar abre o seletor, Esc fecha, linha de texto envia OK');
}

async function stepSubcommandSheet() {
  // "/mc" no menu, toque em /mcp: a folha lista os subcomandos de [reconnect|enable|disable [<server>|all]].
  await composer().fill('');
  await composer().pressSequentially('/mc');
  await page.locator('[data-slot="slash-item"]', { hasText: '/mcp' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Subcomandos de /mcp' });
  await sheet.waitFor();
  assert.deepEqual(
    await sheetLabels(sheet),
    ['Sem argumento', 'reconnect', 'enable', 'disable', 'Digitar argumentos…'],
    'subcomandos, "Sem argumento" (o hint é opcional) e digitar',
  );
  assert.equal(await sheet.locator('[data-slot="action-sheet-item"][data-mono="true"]').count(), 3, 'escolhas em mono');
  const choiceBox = await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'reconnect' }).boundingBox();
  assert.ok(choiceBox !== null && choiceBox.height >= 44, `linha de escolha com 44px ou mais (${choiceBox?.height})`);
  // The sheet enters with a 220ms animation (translateY + fade): wait for it before the screenshot.
  await page.waitForTimeout(350);
  await shot('11-sheet-mcp-subcomandos-escuro');
  await themeShots('light');
  await shot('12-sheet-mcp-subcomandos-claro');
  await themeShots('dark');

  // "reconnect" não pede argumento: vai como mensagem `/mcp reconnect`.
  const bubbles = await userBubbles();
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'reconnect' }).tap();
  await until('mensagem /mcp reconnect enviada', async () => (await userBubbles()) === bubbles + 1);
  const sent = page.locator('[data-slot="chat-timeline"] [data-slot="bubble-user"]').last();
  assert.equal(await sent.locator('[data-slot="command-token"]').innerText(), '/mcp', 'comando destacado');
  assert.match(await sent.innerText(), /\/mcp reconnect/, 'mensagem é /mcp reconnect');
  await until('turno termina depois de /mcp reconnect', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(300);
  log('subcomando sem argumento envia /mcp reconnect OK');

  // "enable" pede argumento: só põe "/mcp enable " no campo, com foco, e não envia.
  const afterSend = await userBubbles();
  await composer().pressSequentially('/mc');
  await page.locator('[data-slot="slash-item"]', { hasText: '/mcp' }).tap();
  await sheet.waitFor();
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'enable' }).tap();
  await until('campo recebe "/mcp enable "', async () => (await composerValue()) === '/mcp enable ');
  assert.ok(await composerFocused(), 'escolha com argumento deixa o foco no campo');
  assert.equal(await userBubbles(), afterSend, 'escolha com argumento não envia');
  await composer().fill('');

  // "Digitar argumentos…" põe "/mcp " no campo.
  await composer().pressSequentially('/mc');
  await page.locator('[data-slot="slash-item"]', { hasText: '/mcp' }).tap();
  await sheet.waitFor();
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'Digitar argumentos…' }).tap();
  await until('campo recebe "/mcp "', async () => (await composerValue()) === '/mcp ');
  await composer().fill('');
  log('subcomando com argumento e "Digitar argumentos…" OK');
}

async function stepUsageAnsi() {
  // /usage tem dica [show|reset ...]: a folha abre; "show" envia "/usage show". A resposta traz escapes ANSI.
  await composer().fill('');
  await composer().pressSequentially('/us');
  await page.locator('[data-slot="slash-item"]', { hasText: '/usage' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Subcomandos de /usage' });
  await sheet.waitFor();
  assert.deepEqual(await sheetLabels(sheet), ['Sem argumento', 'show', 'reset', 'Digitar argumentos…'], 'subcomandos de /usage');
  await sheet.locator('[data-slot="action-sheet-item"]', { hasText: 'show' }).tap();
  await until('resposta do /usage aparece', () =>
    hasCount(page.locator('[data-slot="chat-timeline"] [data-slot="agent-text"]', { hasText: '62%' })),
  );
  await until('turno termina depois de /usage show', () => statusIs('idle'), 60_000);
  await page.waitForTimeout(300);

  const shown = await page.locator('[data-slot="chat-timeline"]').innerText();
  assert.ok(!/\u001b|\[38;2|\[39m|\[0m/.test(shown), `sem escapes ANSI visíveis: ${JSON.stringify(shown.slice(0, 200))}`);
  assert.match(shown, /\[█+░+\] 62%/, 'a barra aparece sem as cores');
  log('resposta do /usage sem escapes ANSI OK');
  await page.locator('[data-slot="chat-timeline"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shot('13-ansi-usage-escuro');
  await themeShots('light');
  await shot('14-ansi-usage-claro');
  await themeShots('dark');
}

/**
 * Usage drawer from the chat header ("Uso do agente", ACP sessions only, so no PTY variant is needed here).
 * The drawer shows the agent's /usage reply without ANSI escapes, the "Atualizado" footer, and closes with
 * Escape; the chat header buttons still work afterwards.
 */
async function stepUsageDrawer() {
  // Telas estreitas: "Uso do agente" sai do cabeçalho e fica no menu "Mais ações da sessão" (ChatScreen).
  if ((await button('Uso do agente').count()) === 0) {
    await page.getByRole('button', { name: 'Mais ações da sessão', exact: true }).tap();
    await button('Uso do agente').tap();
  } else {
    await button('Uso do agente').tap();
  }
  const drawer = page.getByRole('dialog', { name: 'Uso do Fake' });
  await drawer.waitFor();
  await until('resposta do uso aparece na folha', () => hasCount(drawer.getByText('62%')), 30_000);

  const drawerText = await drawer.innerText();
  assert.ok(!/\u001b|\[38;2|\[39m|\[0m/.test(drawerText), `sem escapes ANSI na folha: ${JSON.stringify(drawerText.slice(0, 200))}`);
  // The reply is shown as cards: one per window (number, progress bar, reset text), the "em uso" badge, the account line.
  assert.equal(await drawer.getByRole('progressbar', { name: 'Uso: 5 horas' }).getAttribute('aria-valuenow'), '62', 'barra de 5 horas em 62%');
  assert.equal(await drawer.getByRole('progressbar', { name: 'Uso: 7 dias' }).getAttribute('aria-valuenow'), '21', 'barra de 7 dias em 21%');
  assert.ok(await hasCount(drawer.getByText('em uso')), 'cartão com o selo "em uso"');
  assert.ok(await hasCount(drawer.getByText('Renova em 2h')), 'texto de renovação do cartão');
  assert.ok(await hasCount(drawer.getByText('Openai Codex plus · fake@example.com')), 'linha da conta no cabeçalho');
  await drawer.getByText(/^Atualizado /).waitFor();
  log('folha Uso do Fake: cartões com barras, selo em uso e linha Atualizado visíveis');
  await shot('15-usage-drawer-escuro');
  await themeShots('light');
  await shot('16-usage-drawer-claro');
  await themeShots('dark');
  await shotIn(redesignDir, 'usage-pretty-dark');
  await themeShots('light');
  await shotIn(redesignDir, 'usage-pretty-light');
  await themeShots('dark');

  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await button('Configurar sessão').tap();
  const config = page.getByRole('dialog', { name: 'Configurar sessão' });
  await config.waitFor();
  await page.keyboard.press('Escape');
  await config.waitFor({ state: 'hidden' });
  const headerHasUsage = (await button('Uso do agente').count()) > 0 || (await button('Mais ações da sessão').count()) > 0;
  assert.ok(headerHasUsage, 'cabeçalho continua com o botão de uso ou o menu de ações');
  log('folha de uso fecha e o cabeçalho segue funcionando');
}

async function stepNoCommands() {
  await newSession('Sem comandos');
  await until('sessão sem comandos ociosa', () => statusIs('idle'), 60_000);
  await composer().fill('/');
  await page.locator('[data-slot="slash-empty"]', { hasText: 'Este agente não anunciou comandos.' }).waitFor();
  await shot('07-sem-comandos-escuro');
  await themeShots('light');
  await shot('08-sem-comandos-claro');
  await themeShots('dark');
  await composer().fill('');
  assert.equal(await menu().count(), 0, 'fecha o menu sem comandos');
  log('agente sem comandos OK');
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
  await stepTypedMenu();
  await stepCommandBeforeDraft();
  await stepTouchTargets();
  await stepNativePicker();
  await stepSubcommandSheet();
  await stepUsageAnsi();
  await stepUsageDrawer();
  await stepNoCommands();
  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  assert.deepEqual(consoleErrors, [], 'console do navegador sem erros');
  log('fluxo dos comandos do agente OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2ecmd] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
