import * as nodeFs from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/common/i18n/index.js';
import { checkDataFolder, checkInstallTarget } from '../src/install/guards.js';
import { type InstallOptions, planInstall, runInstall } from '../src/install/install.js';
import { readPayload } from '../src/install/payload.js';
import { findRunningInDir, type ExecFileLike, type RunningProcess } from '../src/install/processes.js';
import { removeTree } from '../src/install/safe-remove.js';
import { planUninstall, runUninstall, type UninstallDeps, type UninstallOptions, type UninstallProgress } from '../src/install/uninstall.js';
import { makeInstallDeps, makeJunction, makePayload, makeSandbox, type Sandbox } from './install-support.js';

afterEach(() => setLanguage('pt-BR'));

interface PerLanguage<T = string> {
  'pt-BR': T;
  en: T;
  es: T;
}

async function inEach<T>(run: () => Promise<T> | T): Promise<PerLanguage<T>> {
  setLanguage('pt-BR');
  const ptBR = await run();
  setLanguage('en');
  const en = await run();
  setLanguage('es');
  const es = await run();
  return { 'pt-BR': ptBR, en, es };
}

const messageOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('it did not throw');
};

const labelsOf = (events: ReadonlyArray<{ label: string }>): string[] => [...new Set(events.map((event) => event.label))];

describe('install guards in every language', () => {
  const context = { profile: 'C:\\Users\\user', desktopHome: 'C:\\Users\\user\\.nanachi-desktop', exists: () => false };
  const reasonOf = (input: string): string => {
    const check = checkInstallTarget(input, context);
    if (check.ok) throw new Error(`accepted: ${input}`);
    return check.reason;
  };

  it('every reason a folder is refused as an install target', async () => {
    expect(await inEach(() => reasonOf(''))).toEqual({
      'pt-BR': 'Escolha uma pasta para instalar o Nanachi.',
      en: 'Choose a folder to install Nanachi.',
      es: 'Elige una carpeta para instalar Nanachi.',
    });
    expect(await inEach(() => reasonOf('relativa\\pasta'))).toEqual({
      'pt-BR': 'O caminho da pasta precisa ser completo (por exemplo C:\\Programas\\Nanachi).',
      en: 'The folder path must be a full path (for example C:\\Programs\\Nanachi).',
      es: 'La ruta de la carpeta debe ser completa (por ejemplo C:\\Programas\\Nanachi).',
    });
    expect(await inEach(() => reasonOf('C:\\'))).toEqual({
      'pt-BR': 'Escolha uma pasta dentro do disco, não a raiz dele.',
      en: 'Choose a folder inside the drive, not its root.',
      es: 'Elige una carpeta dentro del disco, no su raíz.',
    });
    expect(await inEach(() => reasonOf('C:\\Users\\user'))).toEqual({
      'pt-BR': 'Escolha uma subpasta; a pasta do usuário (ou uma que a contém) não pode receber o Nanachi.',
      en: 'Choose a subfolder; the user folder (or a folder that contains it) cannot receive Nanachi.',
      es: 'Elige una subcarpeta; la carpeta del usuario (o una que la contenga) no puede recibir Nanachi.',
    });
    expect(await inEach(() => reasonOf('C:\\Users\\user\\.nanachi-desktop'))).toEqual({
      'pt-BR': 'Essa pasta guarda ou contém os dados do Nanachi (.nanachi-desktop ou .nanachi-remote). Escolha outra.',
      en: 'That folder holds or contains Nanachi’s data (.nanachi-desktop or .nanachi-remote). Choose another one.',
      es: 'Esa carpeta guarda o contiene los datos de Nanachi (.nanachi-desktop o .nanachi-remote). Elige otra.',
    });
  });

  it('every reason a folder is refused as a data folder to delete', async () => {
    const base = { profile: 'C:\\Users\\user', installDir: 'C:\\Apps\\Nanachi', exists: () => false };
    const reason = (input: string, extra: Partial<Parameters<typeof checkDataFolder>[1]> = {}): string => {
      const check = checkDataFolder(input, { ...base, ...extra });
      if (check.ok) throw new Error(`accepted: ${input}`);
      return check.reason;
    };
    expect(await inEach(() => reason(''))).toEqual({
      'pt-BR': 'o caminho está vazio',
      en: 'the path is empty',
      es: 'la ruta está vacía',
    });
    expect(await inEach(() => reason('dados'))).toEqual({
      'pt-BR': 'o caminho não é completo (como C:\\Dados\\Nanachi)',
      en: 'the path is not a full path (like C:\\Data\\Nanachi)',
      es: 'la ruta no es completa (como C:\\Datos\\Nanachi)',
    });
    expect(await inEach(() => reason('C:\\'))).toEqual({ 'pt-BR': 'é a raiz de um disco', en: 'it is the root of a drive', es: 'es la raíz de un disco' });
    expect(await inEach(() => reason('C:\\Users\\user'))).toEqual({
      'pt-BR': 'é a pasta do usuário ou uma pasta que a contém',
      en: 'it is the user folder or a folder that contains it',
      es: 'es la carpeta del usuario o una carpeta que la contiene',
    });
    expect(await inEach(() => reason('C:\\Apps\\Nanachi\\dados'))).toEqual({
      'pt-BR': 'se mistura com a pasta do programa',
      en: 'it overlaps the program folder',
      es: 'se superpone con la carpeta del programa',
    });
    expect(await inEach(() => reason('C:\\Users\\user\\.nanachi-remote'))).toEqual({
      'pt-BR': 'é a pasta de dados do daemon avulso do Nanachi (.nanachi-remote ou NANACHI_HOME), que o Desktop nunca apaga',
      en: 'it is the data folder of the standalone Nanachi daemon (.nanachi-remote or NANACHI_HOME), which Desktop never deletes',
      es: 'es la carpeta de datos del daemon independiente de Nanachi (.nanachi-remote o NANACHI_HOME), que Desktop nunca elimina',
    });
    expect(await inEach(() => reason('C:\\Dados\\Um', { others: ['C:\\Dados'] }))).toEqual({
      'pt-BR': 'se mistura com outra pasta de dados do Nanachi',
      en: 'it overlaps another Nanachi data folder',
      es: 'se superpone con otra carpeta de datos de Nanachi',
    });
    expect(await inEach(() => reason('C:\\Dados\\Um', { requireAll: ['data.db'] }))).toEqual({
      'pt-BR': 'não tem data.db, então não parece uma pasta de dados do Nanachi',
      en: 'it has no data.db, so it does not look like a Nanachi data folder',
      es: 'no tiene data.db, así que no parece una carpeta de datos de Nanachi',
    });
    expect(await inEach(() => reason('C:\\Dados\\Um', { requireAny: ['machine.bin'] }))).toEqual({
      'pt-BR': 'não parece uma pasta de dados do Nanachi',
      en: 'it does not look like a Nanachi data folder',
      es: 'no parece una carpeta de datos de Nanachi',
    });
  });
});

describe('payload and process errors in every language', () => {
  it('a payload folder without the files', async () => {
    const texts = await inEach(() => messageOf(() => readPayload('C:\\nao-existe')));
    expect(texts['pt-BR']).toMatch(/^o instalador não encontrou os arquivos do Nanachi \(.*payload\.zip\)\. Baixe o instalador de novo\.$/);
    expect(texts.en).toMatch(/^the installer did not find the Nanachi files \(.*payload\.zip\)\. Download the installer again\.$/);
    expect(texts.es).toMatch(/^el instalador no encontró los archivos de Nanachi \(.*payload\.zip\)\. Descarga el instalador de nuevo\.$/);
  });

  it('a process scan that fails says what PowerShell said, or the error itself', async () => {
    const failing =
      (stderr: string): ExecFileLike =>
      (_file, _args, _options, callback) => {
        callback(new Error('exec failed'), '', stderr);
        return undefined;
      };
    expect(await inEach(() => messageOf(() => findRunningInDir('C:\\Apps\\Nanachi', 1, failing('Access denied\nmore'))))).toEqual({
      'pt-BR': 'não foi possível listar os processos (Access denied)',
      en: 'could not list the processes (Access denied)',
      es: 'no se pudieron listar los procesos (Access denied)',
    });
    setLanguage('en');
    expect(await messageOf(() => findRunningInDir('C:\\Apps\\Nanachi', 1, failing('')))).toBe('could not list the processes (exec failed)');
  });
});

describe('the install, in every language', () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  const options = (overrides: Partial<InstallOptions> = {}): InstallOptions => ({
    target: sandbox.target,
    desktopShortcut: true,
    startWithWindows: true,
    noShortcuts: false,
    noRegistry: false,
    ...overrides,
  });

  const STEP_LABELS: PerLanguage<string[]> = {
    'pt-BR': [
      'Verificando se o Nanachi está aberto',
      'Copiando os arquivos',
      'Criando atalhos',
      'Configurando o início com o Windows',
      'Registrando o Nanachi no Windows',
    ],
    en: ['Checking whether Nanachi is open', 'Copying files', 'Creating shortcuts', 'Setting up start with Windows', 'Registering Nanachi with Windows'],
    es: [
      'Comprobando si Nanachi está abierto',
      'Copiando los archivos',
      'Creando accesos directos',
      'Configurando el inicio con Windows',
      'Registrando Nanachi en Windows',
    ],
  };

  it('the plan names its steps in the language, and says why one is skipped', async () => {
    expect(await inEach(() => planInstall(options()).map((step) => step.label))).toEqual(STEP_LABELS);
    const skipped = await inEach(() => {
      const byId = Object.fromEntries(planInstall(options({ noShortcuts: true, startWithWindows: false })).map((step) => [step.id, step.skipped]));
      return [byId.shortcuts ?? '', byId.startup ?? ''];
    });
    expect(skipped).toEqual({
      'pt-BR': ['modo de teste', 'desligado nas opções'],
      en: ['test mode', 'turned off in the options'],
      es: ['modo de prueba', 'desactivado en las opciones'],
    });
  });

  it('the progress events carry the label of the language, for every step of a whole install', async () => {
    const payload = await makePayload(join(sandbox.root, 'payload'));
    const labels = await inEach(async () => {
      const { deps, recorder } = makeInstallDeps(sandbox, payload);
      await runInstall(options(), deps);
      return labelsOf(recorder.events);
    });
    expect(labels).toEqual(STEP_LABELS);
  });

  it('the install is refused, with a message in the language, when ...', async () => {
    const payload = await makePayload(join(sandbox.root, 'payload'));
    const run = (overrides: Parameters<typeof makeInstallDeps>[2], opts: Partial<InstallOptions> = {}): Promise<string> =>
      messageOf(() => runInstall(options({ noShortcuts: true, noRegistry: true, ...opts }), makeInstallDeps(sandbox, payload, overrides).deps));
    const process: RunningProcess = { pid: 77, name: 'Nanachi.exe' };

    // ... the user does not want Nanachi closed
    expect(await inEach(() => run({ findRunning: () => Promise.resolve([process]), confirmClose: () => Promise.resolve(false) }))).toEqual({
      'pt-BR': 'Instalação cancelada: o Nanachi continua aberto.',
      en: 'Installation cancelled: Nanachi is still open.',
      es: 'Instalación cancelada: Nanachi sigue abierto.',
    });
    // ... it will not close
    expect(await inEach(() => run({ findRunning: () => Promise.resolve([process]) }))).toEqual({
      'pt-BR': 'Não foi possível fechar o Nanachi. Feche-o pela bandeja do Windows e tente de novo.',
      en: 'Could not close Nanachi. Close it from the Windows tray and try again.',
      es: 'No se pudo cerrar Nanachi. Ciérralo desde la bandeja de Windows e inténtalo de nuevo.',
    });
    // ... it cannot even be looked for
    expect(await inEach(() => run({ findRunning: () => Promise.reject(new Error('boom')) }))).toEqual({
      'pt-BR': 'Não foi possível verificar se o Nanachi está aberto: boom',
      en: 'Could not check whether Nanachi is open: boom',
      es: 'No se pudo comprobar si Nanachi está abierto: boom',
    });
    // ... a shortcut cannot be written
    const shortcut = await inEach(() => run({ writeShortcut: () => false }, { noShortcuts: false }));
    expect(shortcut['pt-BR']).toMatch(/^Não foi possível criar o atalho .*Nanachi\.lnk\.$/);
    expect(shortcut.en).toMatch(/^Could not create the shortcut .*Nanachi\.lnk\.$/);
    expect(shortcut.es).toMatch(/^No se pudo crear el acceso directo .*Nanachi\.lnk\.$/);
    // ... reg.exe fails
    expect(await inEach(() => run({ runReg: () => Promise.resolve(1) }, { noRegistry: false }))).toEqual({
      'pt-BR': 'Não foi possível registrar o Nanachi no Windows (reg.exe falhou).',
      en: 'Could not register Nanachi with Windows (reg.exe failed).',
      es: 'No se pudo registrar Nanachi en Windows (falló reg.exe).',
    });
  });

  it('the target folder is refused when it is a file, or has somebody else\'s things in it', async () => {
    const payload = await makePayload(join(sandbox.root, 'payload'));
    const run = (): Promise<string> => messageOf(() => runInstall(options({ noShortcuts: true, noRegistry: true }), makeInstallDeps(sandbox, payload).deps));

    mkdirSync(join(sandbox.target, '..'), { recursive: true });
    writeFileSync(sandbox.target, 'a file, not a folder');
    expect(await inEach(run)).toEqual({
      'pt-BR': 'Já existe um arquivo com esse nome. Escolha outra pasta.',
      en: 'A file with that name already exists. Choose another folder.',
      es: 'Ya existe un archivo con ese nombre. Elige otra carpeta.',
    });

    removeTree(sandbox.target, nodeFs);
    mkdirSync(sandbox.target, { recursive: true });
    writeFileSync(join(sandbox.target, 'minhas-coisas.txt'), 'keep me');
    expect(await inEach(run)).toEqual({
      'pt-BR': 'A pasta não está vazia e não parece uma instalação do Nanachi. Escolha uma pasta vazia.',
      en: 'The folder is not empty and does not look like a Nanachi installation. Choose an empty folder.',
      es: 'La carpeta no está vacía y no parece una instalación de Nanachi. Elige una carpeta vacía.',
    });
  });

  it('a payload that lacks the program is reported with the name of the exe', async () => {
    const payload = await makePayload(join(sandbox.root, 'payload'), { 'resources/readme.txt': 'no exe here' });
    const run = (): Promise<string> => messageOf(() => runInstall(options({ noShortcuts: true, noRegistry: true }), makeInstallDeps(sandbox, payload).deps));
    expect(await inEach(run)).toEqual({
      'pt-BR': 'A instalação terminou sem Nanachi.exe. Baixe o instalador de novo.',
      en: 'The installation finished without Nanachi.exe. Download the installer again.',
      es: 'La instalación terminó sin Nanachi.exe. Descarga el instalador de nuevo.',
    });
  });

  it('an invalid target is refused with the reason of the language before anything runs', async () => {
    const payload = await makePayload(join(sandbox.root, 'payload'));
    const run = (): Promise<string> => messageOf(() => runInstall(options({ target: 'C:\\' }), makeInstallDeps(sandbox, payload).deps));
    expect(await inEach(run)).toEqual({
      'pt-BR': 'Escolha uma pasta dentro do disco, não a raiz dele.',
      en: 'Choose a folder inside the drive, not its root.',
      es: 'Elige una carpeta dentro del disco, no su raíz.',
    });
  });
});

describe('the uninstall, in every language', () => {
  let sandbox: Sandbox;
  let desktopData: string;
  beforeEach(async () => {
    sandbox = makeSandbox();
    desktopData = join(sandbox.profile, 'AppData', 'Roaming', 'Nanachi');
    const payload = await makePayload(join(sandbox.root, 'payload'));
    await runInstall(
      { target: sandbox.target, desktopShortcut: true, startWithWindows: true, noShortcuts: true, noRegistry: true },
      makeInstallDeps(sandbox, payload).deps,
    );
    mkdirSync(sandbox.desktopHome, { recursive: true });
    writeFileSync(join(sandbox.desktopHome, 'config.json'), '{"port":7780}');
    writeFileSync(join(sandbox.desktopHome, 'data.db'), 'sqlite');
    mkdirSync(desktopData, { recursive: true });
    writeFileSync(join(desktopData, 'machine.bin'), 'token');
  });
  afterEach(() => sandbox.cleanup());

  const options = (overrides: Partial<UninstallOptions> = {}): UninstallOptions => ({
    installDir: sandbox.target,
    deleteData: false,
    noShortcuts: false,
    noRegistry: false,
    ...overrides,
  });

  function depsWith(overrides: Partial<UninstallDeps> = {}, events: UninstallProgress[] = []): UninstallDeps {
    return {
      profile: sandbox.profile,
      desktopHome: sandbox.desktopHome,
      desktopDataDir: desktopData,
      startMenuDir: sandbox.startMenuDir,
      desktopDir: sandbox.desktopDir,
      selfPid: 1,
      findRunning: () => Promise.resolve([]),
      stopProcesses: () => Promise.resolve(),
      readShortcutTarget: () => null,
      readStartupCommand: () => Promise.resolve(null),
      removeStartup: () => undefined,
      readInstallLocation: () => Promise.resolve(null),
      runReg: () => Promise.resolve(0),
      homeInUse: () => Promise.resolve(false),
      scheduleRemoval: () => undefined,
      emit: (progress) => void events.push(progress),
      sleep: () => Promise.resolve(),
      removeOptions: { sleep: () => undefined },
      ...overrides,
    };
  }

  /** A fresh install of the sample payload in the sandbox. */
  async function reinstall(): Promise<void> {
    const payload = await makePayload(join(sandbox.root, `payload-${Math.random().toString(36).slice(2)}`));
    await runInstall(
      { target: sandbox.target, desktopShortcut: false, startWithWindows: false, noShortcuts: true, noRegistry: true },
      makeInstallDeps(sandbox, payload).deps,
    );
  }

  /** Every uninstall removes the install folder, so the next run starts from a new one. */
  async function reinstallIfGone(): Promise<void> {
    if (!nodeFs.existsSync(sandbox.target)) await reinstall();
  }

  /** What the uninstall warned about, in each language, rebuilding the install in between. */
  async function warningsInEach(
    opts: Partial<UninstallOptions>,
    overrides: () => Partial<UninstallDeps>,
    prepare: () => void = () => undefined,
  ): Promise<PerLanguage<string[]>> {
    return inEach(async () => {
      await reinstallIfGone();
      prepare();
      return (await runUninstall(options(opts), depsWith(overrides()))).warnings;
    });
  }

  const STEP_LABELS: PerLanguage<string[]> = {
    'pt-BR': [
      'Fechando o Nanachi',
      'Removendo atalhos',
      'Desligando o início com o Windows',
      'Removendo os arquivos do programa',
      'Apagando os dados do Nanachi',
      'Removendo o Nanachi da lista de aplicativos',
    ],
    en: ['Closing Nanachi', 'Removing shortcuts', 'Turning off start with Windows', 'Removing the program files', 'Deleting Nanachi’s data', 'Removing Nanachi from the apps list'],
    es: [
      'Cerrando Nanachi',
      'Quitando accesos directos',
      'Desactivando el inicio con Windows',
      'Quitando los archivos del programa',
      'Eliminando los datos de Nanachi',
      'Quitando Nanachi de la lista de aplicaciones',
    ],
  };

  it('the plan and the progress events carry the label of the language', async () => {
    expect(await inEach(() => planUninstall(options()).map((step) => step.label))).toEqual(STEP_LABELS);
    const skipped = await inEach(() => planUninstall(options({ noShortcuts: true })).map((step) => step.skipped ?? ''));
    expect(skipped['pt-BR']).toEqual(['', 'modo de teste', '', '', 'os dados ficam guardados', '']);
    expect(skipped.en).toEqual(['', 'test mode', '', '', 'the data is kept', '']);
    expect(skipped.es).toEqual(['', 'modo de prueba', '', '', 'los datos se conservan', '']);

    const labels = await inEach(async () => {
      await reinstallIfGone();
      const events: UninstallProgress[] = [];
      await runUninstall(options({ deleteData: true }), depsWith({}, events));
      return labelsOf(events);
    });
    expect(labels).toEqual(STEP_LABELS);
  });

  it('a folder that is not an install says so', async () => {
    const run = (): Promise<string> => messageOf(() => runUninstall(options({ installDir: join(sandbox.root, 'ghost') }), depsWith()));
    expect(await inEach(run)).toEqual({
      'pt-BR': 'Esta pasta não parece uma instalação do Nanachi; nada foi removido.',
      en: 'This folder does not look like a Nanachi installation; nothing was removed.',
      es: 'Esta carpeta no parece una instalación de Nanachi; no se quitó nada.',
    });
  });

  it('processes that would not close, and a login item or an apps entry that could not be read', async () => {
    expect(await warningsInEach({}, () => ({ findRunning: () => Promise.resolve([{ pid: 50, name: 'Nanachi.exe' }]) }))).toEqual({
      'pt-BR': ['Alguns processos do Nanachi não fecharam; alguns arquivos podem ficar para trás.'],
      en: ['Some Nanachi processes did not close; some files may be left behind.'],
      es: ['Algunos procesos de Nanachi no se cerraron; es posible que queden algunos archivos.'],
    });
    expect(await warningsInEach({}, () => ({ findRunning: () => Promise.reject(new Error('scan failed')) }))).toEqual({
      'pt-BR': ['Não foi possível verificar se o Nanachi está aberto: scan failed'],
      en: ['Could not check whether Nanachi is open: scan failed'],
      es: ['No se pudo comprobar si Nanachi está abierto: scan failed'],
    });
    expect(await warningsInEach({}, () => ({ readStartupCommand: () => Promise.reject(new Error('reg failed')) }))).toEqual({
      'pt-BR': ['Não foi possível ver se o Nanachi inicia com o Windows (reg failed); o item de início foi mantido.'],
      en: ['Could not tell whether Nanachi starts with Windows (reg failed); the startup entry was kept.'],
      es: ['No se pudo saber si Nanachi inicia con Windows (reg failed); se mantuvo el elemento de inicio.'],
    });
    expect(await warningsInEach({}, () => ({ readInstallLocation: () => Promise.reject(new Error('reg failed')) }))).toEqual({
      'pt-BR': ['Não foi possível ler a entrada do Nanachi na lista de aplicativos (reg failed); ela foi mantida.'],
      en: ['Could not read Nanachi’s entry in the apps list (reg failed); it was kept.'],
      es: ['No se pudo leer la entrada de Nanachi en la lista de aplicaciones (reg failed); se mantuvo.'],
    });
    expect(await warningsInEach({}, () => ({ readInstallLocation: () => Promise.resolve(join(sandbox.root, 'other-install')) }))).toEqual({
      'pt-BR': ['A entrada do Nanachi na lista de aplicativos aponta para outra instalação; ela foi mantida.'],
      en: ['Nanachi’s entry in the apps list points to another installation; it was kept.'],
      es: ['La entrada de Nanachi en la lista de aplicaciones apunta a otra instalación; se mantuvo.'],
    });
    expect(await warningsInEach({}, () => ({ readInstallLocation: () => Promise.resolve(sandbox.target), runReg: () => Promise.resolve(5) }))).toEqual({
      'pt-BR': ['Não foi possível remover o Nanachi da lista de aplicativos do Windows.'],
      en: ['Could not remove Nanachi from the Windows apps list.'],
      es: ['No se pudo quitar Nanachi de la lista de aplicaciones de Windows.'],
    });
  });

  it('the data that stays, and why', async () => {
    expect(await warningsInEach({ deleteData: true, noShortcuts: true, noRegistry: true }, () => ({ homeInUse: () => Promise.resolve(true) }))).toEqual({
      'pt-BR': ['Os dados do Nanachi não foram apagados: um daemon do Nanachi está usando essa pasta.'],
      en: ['Nanachi’s data was not deleted: a Nanachi daemon is using that folder.'],
      es: ['No se eliminaron los datos de Nanachi: un daemon de Nanachi está usando esa carpeta.'],
    });

    const notData = join(sandbox.root, 'some-other-folder');
    mkdirSync(notData, { recursive: true });
    writeFileSync(join(notData, 'important.txt'), 'x');
    const other = () => ({ desktopHome: notData, desktopDataDir: join(sandbox.root, 'nothing-here') });
    expect(await warningsInEach({ deleteData: true, noShortcuts: true, noRegistry: true }, other)).toEqual({
      'pt-BR': [`Os dados em ${notData} não foram apagados: não tem config.json, então não parece uma pasta de dados do Nanachi.`],
      en: [`The data in ${notData} was not deleted: it has no config.json, so it does not look like a Nanachi data folder.`],
      es: [`No se eliminaron los datos de ${notData}: no tiene config.json, así que no parece una carpeta de datos de Nanachi.`],
    });
  });

  it('a data folder that is a junction: only the link goes', async () => {
    const real = join(sandbox.root, 'moved-data');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'config.json'), '{}');
    writeFileSync(join(real, 'data.db'), 'sqlite');
    removeTree(sandbox.desktopHome, nodeFs);
    makeJunction(real, sandbox.desktopHome);

    // The link is removed by each uninstall, so it is made again before the next language.
    const texts = await warningsInEach({ deleteData: true, noShortcuts: true, noRegistry: true }, () => ({}), () => {
      if (!nodeFs.existsSync(sandbox.desktopHome)) makeJunction(real, sandbox.desktopHome);
    });
    expect(texts['pt-BR']).toEqual([`${sandbox.desktopHome} é um atalho (junção) para outra pasta: só o atalho foi removido, o conteúdo da pasta de destino ficou.`]);
    expect(texts.en).toEqual([`${sandbox.desktopHome} is a junction (a link to another folder): only the link was removed, the contents of the target folder were kept.`]);
    expect(texts.es).toEqual([`${sandbox.desktopHome} es un vínculo (unión) a otra carpeta: solo se quitó el vínculo, el contenido de la carpeta de destino se conservó.`]);
  });
});
