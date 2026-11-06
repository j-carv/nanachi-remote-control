/*
 * E2E do workspace: troca de branch no cabeçalho, explorador de arquivos e editor (CodeMirror) no celular.
 * Sobe o daemon buildado numa pasta temporária, pareia pelo CLI, cria um workspace que é um repositório git de
 * verdade (git init, duas branches, arquivos) e dirige o PWA buildado num Edge headless com viewport de iPhone 14
 * (390x844). Cada ação confere o efeito no disco, não só na tela.
 * Confere: branches ordenadas pelo último commit, busca, troca, criar branch (create: true) e recusa com
 * alterações (lista de arquivos sujos); explorador com pastas primeiro, arquivo ignorado em cinza, navegação
 * por migalhas; abrir, editar e salvar um .ts (realce de sintaxe); conflito de etag (arquivo mudou no disco entre
 * abrir e salvar) com a folha de conflito e "Sobrescrever"; novo arquivo, renomear, excluir, pasta não vazia e
 * arquivo binário; realce por tipo (.ts, .rs, .py, .json, .md, .toml, .ps1): badge da linguagem, ícone no
 * explorador, tokens com classe e cor de palavra-chave diferente do texto, no claro e no escuro; CSP e console sem
 * erros.
 * Screenshots nos dois temas em e2e/screenshots/workspace/.
 *
 * Como rodar (a partir da raiz, depois do supervisor ter buildado daemon e pwa):
 *   npm run e2e:workspace
 *
 * Pré-requisitos: Node 22+, Microsoft Edge instalado, git no PATH, porta 7803 livre. Tudo fica em
 * $TEMP/nanachi-e2ews-<rand> e é apagado no fim.
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
const shotsDir = join(here, 'screenshots', 'workspace');
const daemonMain = join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const daemonCli = join(repoRoot, 'packages', 'daemon', 'dist', 'cli.js');

const PORT = 7803;
const baseUrl = `http://127.0.0.1:${PORT}`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'msedge';
const log = (line) => console.log(`[e2ews] ${line}`);

const home = join(tmpdir(), `nanachi-e2ews-${randomBytes(4).toString('hex')}`);
// O workspace é a própria pasta "proj": allowedRoots aponta para ela, e o seletor de pastas a mostra na raiz.
const projDir = join(home, 'proj');
const logPath = join(home, 'daemon.log');

const APP_TS = `export interface Greeting {
  name: string;
}

export function greet(user: Greeting): string {
  return \`Olá, \${user.name}!\`;
}
`;

/* Um arquivo de cada família do realce. O texto é sintético; a palavra-chave ou o trecho que o teste confere está
 * em HIGHLIGHT_CASES, mais abaixo. */
const LIB_RS = `use std::collections::HashMap;

/// Conta as palavras.
pub fn count(words: &[&str]) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    for word in words {
        *map.entry(word.to_string()).or_insert(0) += 1;
    }
    map
}
`;

const TOOL_PY = `# Exemplo de saudação
def greet(name: str, times: int = 2) -> str:
    return ("olá, " + name + "! ") * times
`;

const CARGO_TOML = `[package]
name = "proj"
version = "0.1.0"
edition = "2021"
`;

const PACKAGE_JSON = `{
  "name": "proj",
  "private": true,
  "scripts": { "test": "vitest run" }
}
`;

const SETUP_PS1 = `# Instala as dependências
$version = 22
Write-Output "Node $version"
`;

const README_MD = `# proj

Um \`exemplo\` com **negrito** e [um link](https://example.invalid).
`;

let daemon = null;
let browser = null;
let page;
const consoleErrors = [];
const cspViolations = [];

// ---------- processo do daemon e limpeza ----------

function killTree(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function setupHome() {
  mkdirSync(projDir, { recursive: true });
  const config = {
    port: PORT,
    host: '127.0.0.1',
    machineName: 'e2e-workspace',
    allowedRoots: [projDir],
    allowedTailscaleLogins: [],
    corsOrigins: [],
    agents: {},
  };
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Git do repositório de teste: identidade e datas fixas, sem tocar na configuração global. */
function git(args, env = {}) {
  return execFileSync('git', args, {
    cwd: projDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Nanachi E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'Nanachi E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
      ...env,
    },
    encoding: 'utf8',
  }).trim();
}

const JAN = { GIT_AUTHOR_DATE: '2025-01-10T10:00:00Z', GIT_COMMITTER_DATE: '2025-01-10T10:00:00Z' };
const JUN = { GIT_AUTHOR_DATE: '2025-06-10T10:00:00Z', GIT_COMMITTER_DATE: '2025-06-10T10:00:00Z' };

/** Repositório com `main` e `feature/x` (commit mais novo). `ignored.log` fica de fora pelo .gitignore. */
function setupRepo() {
  mkdirSync(join(projDir, 'src'), { recursive: true });
  writeFileSync(join(projDir, 'src', 'app.ts'), APP_TS);
  writeFileSync(join(projDir, 'src', 'lib.rs'), LIB_RS);
  writeFileSync(join(projDir, 'tool.py'), TOOL_PY);
  writeFileSync(join(projDir, 'Cargo.toml'), CARGO_TOML);
  writeFileSync(join(projDir, 'package.json'), PACKAGE_JSON);
  writeFileSync(join(projDir, 'setup.ps1'), SETUP_PS1);
  writeFileSync(join(projDir, 'README.md'), README_MD);
  writeFileSync(join(projDir, '.gitignore'), 'ignored.log\n');
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-m', 'chore: start'], JAN);
  git(['switch', '-c', 'feature/x']);
  writeFileSync(join(projDir, 'src', 'feature.ts'), 'export const feature = true;\n');
  git(['add', '.']);
  git(['commit', '-m', 'feat: feature x'], JUN);
  git(['switch', 'main']);
  writeFileSync(join(projDir, 'ignored.log'), 'log\n');
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

/** Tira a mesma tela no claro e no escuro (o CSS segue o tema do sistema). Volta ao claro no fim. */
async function shotBothThemes(name) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot(`${name}-escuro`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  await shot(`${name}-claro`);
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
const chip = () => page.locator('button[aria-label^="Branch "]');
const branchSheet = () => page.getByRole('dialog', { name: 'Trocar de branch' });
const explorerList = (folder) => page.locator(`ul[aria-label="Conteúdo de ${folder}"] > li`);
const editorHost = (name) => page.locator(`[aria-label="Editor de ${name}"]`);
const conflictSheet = () => page.getByRole('dialog', { name: 'O arquivo mudou no PC' });

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

async function openWorkspace() {
  await goToWorkspaces();
  await page.locator('ul[aria-label="Workspaces"] > li', { hasText: 'proj' }).getByRole('button').first().click();
  await button('Nova sessão').waitFor();
  await until('chip da branch aparece', () => hasCount(chip()));
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

/** Nomes das branches na ordem da folha (sem a linha "Nova branch"). */
async function branchNames() {
  const rows = await branchSheet().locator('ul[aria-label="Branches locais"] > li > button').allInnerTexts();
  return rows.filter((text) => text.trim() !== 'Nova branch').map((text) => text.trim());
}

async function openBranchSheet() {
  await chip().click();
  await branchSheet().waitFor();
  await page.waitForTimeout(350);
}

async function closeSheetWithEscape(sheet) {
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
}

/** Abre "Mais ações de <nome>" e escolhe a opção com esse rótulo. */
async function entryAction(name, label) {
  await page.getByRole('button', { name: `Mais ações de ${name}`, exact: true }).click();
  await page.locator('[data-slot="action-sheet-item"]', { hasText: label }).click();
}

// ---------- fluxos ----------

async function stepBranches() {
  await until('chip mostra main', async () => (await chip().innerText()).includes('main'));
  assert.equal(await chip().innerText(), 'main', 'chip mostra a branch atual');
  await shotBothThemes('01-cabecalho-com-chip-de-branch');

  await openBranchSheet();
  await until('lista de branches carregada', async () => (await branchNames()).length === 2);
  assert.deepEqual(await branchNames(), ['feature/x', 'main'], 'mais recente primeiro (feature/x tem commit de junho)');
  assert.equal(
    await branchSheet().locator('button[aria-current="true"]').innerText(),
    'main',
    'a branch atual vem marcada',
  );

  await branchSheet().getByRole('searchbox', { name: 'Buscar branch' }).fill('FEAT');
  assert.deepEqual(await branchNames(), ['feature/x'], 'busca ignora maiúsculas');
  await branchSheet().getByRole('searchbox', { name: 'Buscar branch' }).fill('zzz');
  await branchSheet().getByText('Nenhuma branch com esse nome.').waitFor();
  await branchSheet().getByRole('searchbox', { name: 'Buscar branch' }).fill('');
  assert.deepEqual(await branchNames(), ['feature/x', 'main'], 'limpar a busca mostra tudo');

  await shotBothThemes('02-folha-de-branches');
  await closeSheetWithEscape(branchSheet());
  log('lista, ordenação, busca e marcação da branch atual OK');

  // Troca: o disco tem que mudar.
  await openBranchSheet();
  await branchSheet().locator('button', { hasText: 'feature/x' }).click();
  await branchSheet().waitFor({ state: 'detached' });
  await until('chip mostra feature/x', async () => (await chip().innerText()) === 'feature/x');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/x', 'o checkout foi para o disco');
  log('troca de branch OK');

  // Criar branch: "Nova branch" + nome, create: true.
  await openBranchSheet();
  await branchSheet().getByRole('button', { name: 'Nova branch', exact: true }).click();
  await branchSheet().getByRole('textbox', { name: 'Nome da nova branch' }).fill('feat/nova');
  await branchSheet().getByRole('button', { name: 'Criar', exact: true }).click();
  await branchSheet().waitFor({ state: 'detached' });
  await until('chip mostra feat/nova', async () => (await chip().innerText()) === 'feat/nova');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/nova', 'a branch nova existe e está ativa');
  log('criar branch (create: true) OK');

  // Recusa: alteração no disco impede a troca, e a folha lista o arquivo.
  const original = readFileSync(join(projDir, 'src', 'app.ts'), 'utf8');
  writeFileSync(join(projDir, 'src', 'app.ts'), `${original}// sujo\n`);
  await openBranchSheet();
  await branchSheet().locator('button', { hasText: 'feature/x' }).click();
  await branchSheet().getByRole('alert').waitFor();
  assert.match(await branchSheet().getByRole('alert').innerText(), /Há alterações não commitadas/, 'mensagem de sujo');
  const dirtyList = await branchSheet().locator('ul[aria-label="Arquivos com alterações"]').innerText();
  assert.match(dirtyList, /src\/app\.ts/, 'lista o arquivo sujo');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/nova', 'a troca foi recusada no disco');
  await shotBothThemes('03-folha-de-branches-recusa');
  await closeSheetWithEscape(branchSheet());
  writeFileSync(join(projDir, 'src', 'app.ts'), original);
  log('recusa com alterações (dirty_worktree) OK');
}

async function stepExplorer() {
  await button('Arquivos').click();
  await headerTitle('Arquivos').waitFor();
  await until('explorador lista a raiz', () => hasCount(explorerList('proj')));
  const names = await explorerList('proj').locator('button').first().innerText();
  assert.match(names, /src/, 'pastas primeiro: src vem antes dos arquivos');
  const rootNames = await page.locator('ul[aria-label="Conteúdo de proj"] > li').allInnerTexts();
  assert.equal(rootNames.findIndex((text) => text.startsWith('src')), 0, 'src é o primeiro item');
  const ignored = page.locator('ul[aria-label="Conteúdo de proj"] > li', { hasText: 'ignored.log' });
  assert.match(await ignored.innerText(), /ignorado pelo git/, 'arquivo ignorado vem marcado');
  assert.match(await page.locator('ul[aria-label="Conteúdo de proj"] > li', { hasText: 'src' }).innerText(), /Pasta/, 'pasta mostra "Pasta"');
  await shotBothThemes('04-explorador');
  log('explorador: pastas primeiro, ignorado marcado OK');

  await page.locator('ul[aria-label="Conteúdo de proj"] > li button', { hasText: 'src' }).first().click();
  await until('dentro de src', () => hasCount(explorerList('src')));
  assert.ok(await hasCount(page.locator('nav[aria-label="Caminho da pasta"] [aria-current="page"]', { hasText: 'src' })), 'migalha atual é src');
  await explorerList('src').locator('button', { hasText: 'app.ts' }).click();
  log('navegação por pasta OK');
}

async function stepEditor() {
  await until('editor do app.ts carregado', () => hasCount(editorHost('app.ts').locator('.cm-content')), 30_000);
  // Realce de sintaxe: o parser carrega depois do editor; o CodeMirror então divide o texto em tokens com classe.
  await until('realce de TypeScript aplicado', async () => (await highlightTokens('app.ts')) > 5);
  await assertKeywordColored('app.ts', 'export');
  assert.equal(await button('Salvar').isDisabled(), true, 'Salvar desabilitado com o arquivo limpo');
  await shotBothThemes('05-editor-typescript');
  log(`editor abre com realce (${await highlightTokens('app.ts')} tokens) e Salvar desabilitado OK`);

  // Editar e salvar: o disco tem que receber o texto.
  await editorHost('app.ts').locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// editado no celular');
  await until('Salvar habilitado depois de editar', async () => !(await button('Salvar').isDisabled()));
  await page.getByRole('status').filter({ hasText: 'Não salvo' }).waitFor();
  await button('Salvar').click();
  await until('Salvar volta a desabilitado', async () => button('Salvar').isDisabled());
  assert.match(readFileSync(join(projDir, 'src', 'app.ts'), 'utf8'), /\/\/ editado no celular/, 'salvo no disco');
  log('editar e salvar (PUT com baseEtag) OK');

  // Conflito: o arquivo muda no disco entre abrir e salvar.
  await editorHost('app.ts').locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// conflito');
  writeFileSync(join(projDir, 'src', 'app.ts'), 'export const remoto = 1;\n');
  await button('Salvar').click();
  await conflictSheet().waitFor();
  await page.waitForTimeout(350);
  assert.equal(
    await conflictSheet().getByRole('button', { name: /Recarregar do PC/ }).count(),
    1,
    'opção de recarregar',
  );
  await shotBothThemes('06-conflito');
  await conflictSheet().getByRole('button', { name: 'Sobrescrever mesmo assim', exact: true }).click();
  await conflictSheet().waitFor({ state: 'detached' });
  assert.match(readFileSync(join(projDir, 'src', 'app.ts'), 'utf8'), /\/\/ conflito/, 'sobrescrever gravou a edição');
  log('conflito de etag: folha aparece e Sobrescrever grava OK');

  // Sair com alterações pede confirmação: o botão Voltar com o campo sujo não sai sem perguntar.
  await editorHost('app.ts').locator('.cm-content').click();
  await page.keyboard.type('x');
  let asked = null;
  page.once('dialog', async (dialog) => {
    asked = dialog.message();
    await dialog.dismiss();
  });
  await button('Voltar').click();
  await until('confirmação do Voltar', async () => asked !== null);
  assert.match(asked, /alterações não salvas/, 'pergunta antes de descartar');
  assert.ok(await hasCount(editorHost('app.ts')), 'cancelar fica no editor');
  await page.keyboard.press('Control+z');
  await until('desfazer volta ao limpo', async () => button('Salvar').isDisabled());
  log('aviso ao sair com alterações OK');
}

async function stepFiles() {
  // Volta do editor e vai para a raiz pela migalha.
  await button('Voltar').click();
  await until('volta para dentro de src', () => hasCount(explorerList('src')));
  await page.locator('nav[aria-label="Caminho da pasta"] button', { hasText: 'proj' }).click();
  await until('raiz de volta', () => hasCount(explorerList('proj')));

  // Novo arquivo: PUT com baseEtag null e abre no editor.
  await button('Novo arquivo').click();
  await page.getByRole('dialog', { name: 'Novo arquivo' }).waitFor();
  await page.locator('#entry-name').fill('novo.ts');
  await page.getByRole('dialog', { name: 'Novo arquivo' }).getByRole('button', { name: 'Criar', exact: true }).click();
  await until('editor de novo.ts abre', () => hasCount(editorHost('novo.ts')));
  assert.equal(readFileSync(join(projDir, 'novo.ts'), 'utf8'), '', 'arquivo criado vazio no disco');
  await button('Voltar').click();
  await until('novo.ts aparece na raiz', () => hasCount(explorerList('proj').filter({ hasText: 'novo.ts' })));
  log('novo arquivo OK');

  // Renomear.
  await entryAction('novo.ts', 'Renomear');
  const renameSheet = page.getByRole('dialog', { name: 'Renomear' });
  await renameSheet.waitFor();
  await renameSheet.locator('#entry-name').fill('renomeado.ts');
  await renameSheet.getByRole('button', { name: 'Renomear', exact: true }).click();
  await renameSheet.waitFor({ state: 'detached' });
  await until('lista mostra renomeado.ts', () => hasCount(explorerList('proj').filter({ hasText: 'renomeado.ts' })));
  assert.ok(existsSync(join(projDir, 'renomeado.ts')) && !existsSync(join(projDir, 'novo.ts')), 'renomeado no disco');
  log('renomear OK');

  // Excluir pasta não vazia: recusa com a mensagem; arquivo vazio: apaga.
  await entryAction('src', 'Excluir');
  const deleteSrc = page.getByRole('dialog', { name: 'Excluir src?' });
  await deleteSrc.waitFor();
  await deleteSrc.getByRole('button', { name: 'Excluir', exact: true }).click();
  await deleteSrc.getByRole('alert').waitFor();
  assert.match(await deleteSrc.getByRole('alert').innerText(), /não está vazia/, 'mensagem de pasta não vazia');
  assert.ok(existsSync(join(projDir, 'src', 'app.ts')), 'a pasta com conteúdo ficou no disco');
  await page.keyboard.press('Escape');
  await deleteSrc.waitFor({ state: 'detached' });

  await entryAction('renomeado.ts', 'Excluir');
  const deleteFile = page.getByRole('dialog', { name: 'Excluir renomeado.ts?' });
  await deleteFile.waitFor();
  await deleteFile.getByRole('button', { name: 'Excluir', exact: true }).click();
  await deleteFile.waitFor({ state: 'detached' });
  await until('renomeado.ts sumiu da lista', async () => !(await hasCount(explorerList('proj').filter({ hasText: 'renomeado.ts' }))));
  assert.equal(existsSync(join(projDir, 'renomeado.ts')), false, 'excluído do disco');
  log('excluir arquivo e recusar pasta não vazia OK');

  // Copiar caminho: a linha confirma o que foi copiado.
  await entryAction('README.md', 'Copiar caminho');
  await page.getByText('Caminho copiado: README.md').waitFor();

  // Arquivo binário: mensagem, sem editor.
  writeFileSync(join(projDir, 'imagem.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
  await button('Atualizar').click();
  await until('imagem.png aparece', () => hasCount(explorerList('proj').filter({ hasText: 'imagem.png' })));
  await explorerList('proj').filter({ hasText: 'imagem.png' }).locator('button').first().click();
  await page.getByText('Arquivo binário: não dá para editar aqui.').waitFor();
  assert.equal(await hasCount(page.locator('.cm-content')), false, 'binário não abre o editor');
  await button('Voltar').click();
  await until('volta à raiz', () => hasCount(explorerList('proj')));
  log('arquivo binário mostra a mensagem OK');
}

// ---------- realce por tipo de arquivo ----------

/** Um caso por família do realce: pasta ('' = raiz), arquivo, rótulo do badge, ícone do explorador e um token. */
const HIGHLIGHT_CASES = [
  { folder: 'src', name: 'app.ts', label: 'TypeScript', icon: 'code', token: 'export' },
  { folder: 'src', name: 'lib.rs', label: 'Rust', icon: 'code', token: 'fn' },
  { folder: '', name: 'tool.py', label: 'Python', icon: 'code', token: 'def' },
  { folder: '', name: 'package.json', label: 'JSON', icon: 'data', token: '"name"' },
  { folder: '', name: 'README.md', label: 'Markdown', icon: 'text', token: 'proj' },
  { folder: '', name: 'Cargo.toml', label: 'TOML', icon: 'config', token: 'name' },
  { folder: '', name: 'setup.ps1', label: 'PowerShell', icon: 'terminal', token: '# Instala as dependências' },
];

/** Quantos tokens com classe de realce o editor tem agora (zero enquanto o parser não carregou). */
const highlightTokens = (name) => editorHost(name).locator('.cm-line span[class]').count();

/** Cor do texto do editor e a do primeiro token com esse texto exato, no tema atual. */
function colorsOf(name, token) {
  return editorHost(name).evaluate((host, text) => {
    const content = host.querySelector('.cm-content');
    const span = [...host.querySelectorAll('.cm-line span')].find((el) => el.textContent?.trim() === text);
    if (content === null || span === undefined) return null;
    return { base: getComputedStyle(content).color, token: getComputedStyle(span).color };
  }, token);
}

/** O token é um span de realce e a cor dele difere do texto comum. Devolve as duas cores. */
async function assertKeywordColored(name, token) {
  const colors = await colorsOf(name, token);
  assert.ok(colors !== null, `${name}: "${token}" é um token com classe de realce`);
  assert.notEqual(colors.token, colors.base, `${name}: "${token}" tem cor diferente do texto comum`);
  return colors;
}

/** Mostra a pasta do explorador: a raiz pela migalha, uma subpasta pela linha. */
async function showFolder(folder) {
  const label = folder === '' ? 'proj' : folder;
  if (await hasCount(explorerList(label))) return;
  if (folder === '') {
    await page.locator('nav[aria-label="Caminho da pasta"] button', { hasText: 'proj' }).click();
  } else {
    await page.locator('ul[aria-label="Conteúdo de proj"] > li button', { hasText: folder }).first().click();
  }
  await until(`pasta ${label} aberta`, () => hasCount(explorerList(label)));
}

/** Confere o ícone do explorador de um arquivo pelo slot que a tela marca (`data-icon`). */
async function assertIcon(folder, name, icon) {
  const row = explorerList(folder === '' ? 'proj' : folder).filter({ hasText: name });
  const slot = await row.locator('svg').first().getAttribute('data-icon');
  assert.equal(slot, icon, `ícone de ${name} no explorador`);
}

async function stepHighlight() {
  await showFolder('');
  for (const c of HIGHLIGHT_CASES) {
    await showFolder(c.folder);
    await assertIcon(c.folder, c.name, c.icon);
    await explorerList(c.folder === '' ? 'proj' : c.folder).locator('button', { hasText: c.name }).click();
    await until(`editor de ${c.name} abre`, () => hasCount(editorHost(c.name).locator('.cm-content')));

    const badge = await page.locator('[data-slot="badge"]').innerText();
    assert.equal(badge, c.label, `badge de ${c.name} mostra ${c.label}`);
    await until(`realce de ${c.name} aplicado`, async () => (await highlightTokens(c.name)) > 3);

    const slug = c.name.toLowerCase().replace(/\W+/g, '-');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    const dark = await assertKeywordColored(c.name, c.token);
    await shot(`highlight-${slug}-escuro`);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    const light = await assertKeywordColored(c.name, c.token);
    await shot(`highlight-${slug}-claro`);
    assert.notEqual(dark.token, light.token, `${c.name}: a cor do token muda entre claro e escuro`);

    log(`realce de ${c.name} (${c.label}): ${await highlightTokens(c.name)} tokens, "${c.token}" colorido OK`);
    await button('Voltar').click();
    await until(`volta à pasta de ${c.name}`, () => hasCount(explorerList(c.folder === '' ? 'proj' : c.folder)));
  }
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  for (const file of readdirSync(shotsDir)) rmSync(join(shotsDir, file), { force: true });
  setupHome();
  setupRepo();
  await startDaemon();
  log(`daemon no ar em ${baseUrl} (home ${home})`);

  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({
    ...devices['iPhone 14'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
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
  await openWorkspace();
  await stepBranches();
  await stepExplorer();
  await stepEditor();
  await stepFiles();
  await stepHighlight();

  assert.deepEqual(cspViolations, [], 'sem violação de CSP');
  // O navegador registra cada resposta HTTP de erro como "Failed to load resource". Estas são as que o fluxo provoca
  // de propósito (409: conflito, pasta não vazia, branch suja; 415: binário). Qualquer outra conta como erro.
  const httpErrors = consoleErrors.filter((line) => /Failed to load resource: the server responded with a status of/.test(line));
  const countOf = (status) => httpErrors.filter((line) => line.includes(`status of ${status} `)).length;
  assert.equal(countOf(409), 3, 'três 409 provocados: conflito, pasta não vazia e branch suja');
  assert.equal(countOf(415), 1, 'um 415 provocado: arquivo binário');
  assert.deepEqual(
    consoleErrors.filter((line) => !httpErrors.includes(line)),
    [],
    'console do navegador sem erros',
  );
  log('fluxo do workspace OK');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error(`[e2ews] log do daemon (fim):\n${tailLog()}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (daemon !== null && daemon.pid !== undefined) killTree(daemon.pid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  log(`home temporário removido: ${home}`);
}
process.exitCode = exitCode;
