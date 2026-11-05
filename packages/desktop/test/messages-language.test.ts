import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/common/i18n/index.js';
import type { SeedMachine } from '../src/common/types.js';
import { createDaemonApi, createTokenAccess } from '../src/main/daemon-api.js';
import type { DaemonRuntime } from '../src/main/daemon-runtime.js';
import { createDeviceAddRunner, createPairCliRunner } from '../src/main/pair-cli.js';
import { createPairing, parseDeviceOutput, parsePairOutput, PairingError, type TokenStore } from '../src/main/pairing.js';
import {
  createRootsStore,
  nodeRootsFs,
  prepareRoots,
  readAllowedRoots,
  RootsConfigError,
  writeAllowedRoots,
  type PathKind,
} from '../src/main/roots-config.js';
import { launchUninstaller, type LaunchSpawn } from '../src/main/uninstall-launch.js';
import { checkForUpdate } from '../src/main/updates.js';
import { removeDir } from './remove-dir.js';

afterEach(() => setLanguage('pt-BR'));

/** What each language says for one message; a test runs the same call under each and compares. */
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

describe('update check errors', () => {
  const error = async (fetchImpl: typeof fetch): Promise<string> => {
    const result = await checkForUpdate({ currentVersion: '1.0.0', fetchImpl });
    if (result.status !== 'error') throw new Error('not an error');
    return result.message;
  };

  it('GitHub cannot be reached', async () => {
    const texts = await inEach(() => error(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'))));
    expect(texts).toEqual({
      'pt-BR': 'Não foi possível consultar o GitHub: getaddrinfo ENOTFOUND api.github.com',
      en: 'Could not reach GitHub: getaddrinfo ENOTFOUND api.github.com',
      es: 'No se pudo consultar GitHub: getaddrinfo ENOTFOUND api.github.com',
    });
  });

  it('GitHub answers with an error status', async () => {
    const texts = await inEach(() => error(() => Promise.resolve(new Response('no', { status: 403 }))));
    expect(texts).toEqual({ 'pt-BR': 'O GitHub respondeu HTTP 403.', en: 'GitHub answered HTTP 403.', es: 'GitHub respondió HTTP 403.' });
  });

  it('the answer is not JSON', async () => {
    const texts = await inEach(() => error(() => Promise.resolve(new Response('<html>', { status: 200 }))));
    expect(texts).toEqual({
      'pt-BR': 'Resposta do GitHub ilegível.',
      en: 'The GitHub response could not be read.',
      es: 'No se pudo leer la respuesta de GitHub.',
    });
  });
});

describe('uninstaller launch errors', () => {
  function launch(trigger: (child: EventEmitter) => void): string {
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    const spawn: LaunchSpawn = () => child;
    let reported = '';
    launchUninstaller({ execPath: 'C:\\Nanachi\\Nanachi.exe', spawn, env: {}, onError: (text) => void (reported = text) });
    trigger(child);
    return reported;
  }

  it('a process that cannot start, a PowerShell that exits with a code, one that exits with none', async () => {
    expect(await inEach(() => launch((child) => child.emit('error', new Error('spawn powershell.exe ENOENT'))))).toEqual({
      'pt-BR': 'Não foi possível iniciar o desinstalador: spawn powershell.exe ENOENT',
      en: 'Could not start the uninstaller: spawn powershell.exe ENOENT',
      es: 'No se pudo iniciar el desinstalador: spawn powershell.exe ENOENT',
    });
    expect(await inEach(() => launch((child) => child.emit('exit', 1, null)))).toEqual({
      'pt-BR': 'Não foi possível iniciar o desinstalador: o PowerShell terminou com o código 1',
      en: 'Could not start the uninstaller: PowerShell exited with code 1',
      es: 'No se pudo iniciar el desinstalador: PowerShell terminó con el código 1',
    });
    expect(await inEach(() => launch((child) => child.emit('exit', null, null)))).toEqual({
      'pt-BR': 'Não foi possível iniciar o desinstalador: o PowerShell terminou com erro',
      en: 'Could not start the uninstaller: PowerShell exited with an error',
      es: 'No se pudo iniciar el desinstalador: PowerShell terminó con un error',
    });
  });
});

describe('pairing errors', () => {
  it('the daemon CLI printed nothing, noise, or something incomplete', async () => {
    expect(await inEach(() => messageOf(() => parsePairOutput('')))).toEqual({
      'pt-BR': 'o comando de pareamento não imprimiu nada',
      en: 'the pairing command printed nothing',
      es: 'el comando de emparejamiento no imprimió nada',
    });
    expect(await inEach(() => messageOf(() => parsePairOutput('ready')))).toEqual({
      'pt-BR': 'o comando de pareamento imprimiu algo que não é JSON',
      en: 'the pairing command printed something that is not JSON',
      es: 'el comando de emparejamiento imprimió algo que no es JSON',
    });
    expect(await inEach(() => messageOf(() => parsePairOutput('42')))).toEqual({
      'pt-BR': 'resposta do comando de pareamento inválida',
      en: 'invalid response from the pairing command',
      es: 'respuesta no válida del comando de emparejamiento',
    });
    expect(await inEach(() => messageOf(() => parsePairOutput('{"code":"12","expiresAt":1}')))).toEqual({
      'pt-BR': 'o código de pareamento não tem 6 dígitos',
      en: 'the pairing code does not have 6 digits',
      es: 'el código de emparejamiento no tiene 6 dígitos',
    });
    expect(await inEach(() => messageOf(() => parsePairOutput('{"code":"123456","expiresAt":-1}')))).toEqual({
      'pt-BR': 'a validade do código de pareamento é inválida',
      en: 'the pairing code’s expiry is invalid',
      es: 'la vigencia del código de emparejamiento no es válida',
    });
  });

  it('the device command printed nothing, noise, or too little', async () => {
    expect(await inEach(() => messageOf(() => parseDeviceOutput('')))).toEqual({
      'pt-BR': 'o comando de dispositivo não imprimiu nada',
      en: 'the device command printed nothing',
      es: 'el comando de dispositivo no imprimió nada',
    });
    expect(await inEach(() => messageOf(() => parseDeviceOutput('ready')))).toEqual({
      'pt-BR': 'o comando de dispositivo imprimiu algo que não é JSON',
      en: 'the device command printed something that is not JSON',
      es: 'el comando de dispositivo imprimió algo que no es JSON',
    });
    expect(await inEach(() => messageOf(() => parseDeviceOutput('null')))).toEqual({
      'pt-BR': 'resposta do comando de dispositivo inválida',
      en: 'invalid response from the device command',
      es: 'respuesta no válida del comando de dispositivo',
    });
    expect(await inEach(() => messageOf(() => parseDeviceOutput('{"deviceId":"d"}')))).toEqual({
      'pt-BR': 'o comando de dispositivo não devolveu deviceId e token',
      en: 'the device command did not return deviceId and token',
      es: 'el comando de dispositivo no devolvió deviceId ni token',
    });
  });

  it('is a PairingError, whose kind does not depend on the language', () => {
    setLanguage('es');
    expect(() => parsePairOutput('')).toThrow(PairingError);
    try {
      parsePairOutput('');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'bad_output' });
    }
  });

  it('the CLI runner: cannot start, takes too long, exits with a code', async () => {
    const runtime: DaemonRuntime = { nodePath: 'node', daemonMain: 'main.js', daemonCli: 'cli.js', cwd: 'C:\\x', packaged: false };
    const via = (run: Parameters<typeof createPairCliRunner>[3]) => createPairCliRunner(runtime, 'C:\\home', {}, run);
    expect(await inEach(() => messageOf(via(() => Promise.reject(new Error('spawn node ENOENT'))))))
      .toEqual({
        'pt-BR': 'não foi possível rodar o comando de pareamento: spawn node ENOENT',
        en: 'could not run the pairing command: spawn node ENOENT',
        es: 'no se pudo ejecutar el comando de emparejamiento: spawn node ENOENT',
      });
    expect(await inEach(() => messageOf(via(() => Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true }))))).toEqual({
      'pt-BR': 'o comando de pareamento demorou demais',
      en: 'the pairing command took too long',
      es: 'el comando de emparejamiento tardó demasiado',
    });
    expect(await inEach(() => messageOf(via(() => Promise.resolve({ exitCode: 3, stdout: '', stderr: '  ', timedOut: false }))))).toEqual({
      'pt-BR': 'o comando de pareamento saiu com código 3',
      en: 'the pairing command exited with code 3',
      es: 'el comando de emparejamiento terminó con el código 3',
    });
    // What the CLI wrote to stderr is its own text and is passed on as it is.
    setLanguage('en');
    expect(await messageOf(via(() => Promise.resolve({ exitCode: 3, stdout: '', stderr: 'config invalid\n', timedOut: false })))).toBe('config invalid');
    const add = createDeviceAddRunner(runtime, 'C:\\home', {}, () => Promise.resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false }));
    expect(await messageOf(() => add('PC'))).toBe('the pairing command exited with code 1');
  });

  it('pairing with the daemon: no answer, too many attempts, refused, unreadable', async () => {
    const store: TokenStore = { load: () => null, save: () => true, clear: () => undefined };
    const pair = (fetchImpl: typeof fetch) =>
      createPairing({
        runPairCli: () => Promise.resolve('{"code":"123456","expiresAt":1}'),
        runDeviceAddCli: () => Promise.resolve('{"deviceId":"d","token":"t"}'),
        fetchImpl,
        store,
        baseUrl: () => 'http://127.0.0.1:7811',
        deviceName: 'Nanachi Desktop (PC)',
      }).ensureMachine();
    expect(await inEach(() => messageOf(() => pair(() => Promise.reject(new Error('connect ECONNREFUSED')))))).toEqual({
      'pt-BR': 'o daemon não respondeu ao pareamento: connect ECONNREFUSED',
      en: 'the daemon did not answer the pairing request: connect ECONNREFUSED',
      es: 'el daemon no respondió a la solicitud de emparejamiento: connect ECONNREFUSED',
    });
    expect(await inEach(() => messageOf(() => pair(() => Promise.resolve(new Response('', { status: 429 })))))).toEqual({
      'pt-BR': 'muitas tentativas de pareamento; aguarde um pouco',
      en: 'too many pairing attempts; wait a moment',
      es: 'demasiados intentos de emparejamiento; espera un momento',
    });
    expect(await inEach(() => messageOf(() => pair(() => Promise.resolve(new Response('', { status: 500 })))))).toEqual({
      'pt-BR': 'o daemon recusou o novo dispositivo (HTTP 500)',
      en: 'the daemon refused the new device (HTTP 500)',
      es: 'el daemon rechazó el nuevo dispositivo (HTTP 500)',
    });
    expect(await inEach(() => messageOf(() => pair(() => Promise.resolve(new Response('{}', { status: 200 })))))).toEqual({
      'pt-BR': 'resposta de pareamento inválida',
      en: 'invalid pairing response',
      es: 'respuesta de emparejamiento no válida',
    });
  });
});

describe('the daemon API', () => {
  const machine: SeedMachine = { id: 'm', name: 'PC', baseUrl: 'http://127.0.0.1:7780', token: 't' };

  it('Desktop only pairs with the daemon it started, and not twice in a row', async () => {
    const pairing = { current: (): SeedMachine | null => null, ensureMachine: (): Promise<SeedMachine> => Promise.reject(new PairingError('cli_failed', 'x')) };
    const foreign = createTokenAccess(pairing, { baseUrl: () => 'http://127.0.0.1:7780', daemon: () => ({ owned: false, generation: 'g' }) });
    expect(await inEach(() => messageOf(() => foreign.token()))).toEqual({
      'pt-BR': 'o Nanachi Desktop só se pareia com o daemon que ele mesmo iniciou',
      en: 'Nanachi Desktop only pairs with the daemon it started itself',
      es: 'Nanachi Desktop solo se empareja con el daemon que él mismo inició',
    });

    let now = 0;
    const own = createTokenAccess(
      { current: () => null, ensureMachine: () => Promise.resolve(machine) },
      { baseUrl: () => machine.baseUrl, daemon: () => ({ owned: true, generation: 'g' }), now: () => now, repairCooldownMs: 30_000 },
    );
    now = 1;
    await own.refresh();
    now = 2;
    expect(await inEach(() => messageOf(() => own.refresh()))).toEqual({
      'pt-BR': 'o pareamento do Nanachi Desktop foi tentado há pouco; aguarde um instante',
      en: 'Nanachi Desktop’s pairing was attempted a moment ago; wait a moment',
      es: 'el emparejamiento de Nanachi Desktop se intentó hace poco; espera un momento',
    });
  });

  it('an agent without extra accounts gets a principal account named in the language', async () => {
    const api = createDaemonApi({
      baseUrl: () => machine.baseUrl,
      token: () => Promise.resolve('t'),
      refreshToken: () => Promise.resolve('t'),
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ accounts: [{ agentId: 'codex', label: 'Codex', supportsAccounts: false, status: 'logged_in', account: 'a@b.c' }] }), { status: 200 }),
        ),
    });
    const names = await inEach(async () => (await api.accounts())[0]?.accounts[0]?.name ?? '');
    expect(names).toEqual({ 'pt-BR': 'Conta principal', en: 'Main account', es: 'Cuenta principal' });
  });
});

describe('config.json and folder list errors', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanachi-messages-'));
  });
  afterEach(() => removeDir(dir));
  const fileWith = (text: string): string => {
    const file = join(dir, 'config.json');
    writeFileSync(file, text, 'utf8');
    return file;
  };

  it('a file that cannot be read, is not JSON, or is not an object', async () => {
    const missing = join(dir, 'ausente', 'config.json');
    const unreadable = await inEach(() => messageOf(() => readAllowedRoots(missing)));
    expect(unreadable['pt-BR']).toMatch(/^Não foi possível ler o config\.json \(.*config\.json\): ENOENT/);
    expect(unreadable.en).toMatch(/^Could not read config\.json \(.*config\.json\): ENOENT/);
    expect(unreadable.es).toMatch(/^No se pudo leer config\.json \(.*config\.json\): ENOENT/);

    const notJson = fileWith('{oops');
    const invalid = await inEach(() => messageOf(() => readAllowedRoots(notJson)));
    expect(invalid['pt-BR']).toContain(`O config.json (${notJson}) não é um JSON válido: `);
    expect(invalid.en).toContain(`config.json (${notJson}) is not valid JSON: `);
    expect(invalid.es).toContain(`config.json (${notJson}) no es un JSON válido: `);

    const array = fileWith('[]');
    expect(await inEach(() => messageOf(() => readAllowedRoots(array)))).toEqual({
      'pt-BR': `O config.json (${array}) precisa ser um objeto JSON.`,
      en: `config.json (${array}) must be a JSON object.`,
      es: `config.json (${array}) debe ser un objeto JSON.`,
    });
  });

  it('a file that cannot be written', async () => {
    const file = fileWith('{"port":7780}');
    const full = {
      ...nodeRootsFs,
      writeFileSync: () => {
        throw new Error('ENOSPC');
      },
    };
    expect(await inEach(() => messageOf(() => writeAllowedRoots(file, ['C:\A'], full)))).toEqual({
      'pt-BR': `Não foi possível gravar o config.json (${file}): ENOSPC`,
      en: `Could not write config.json (${file}): ENOSPC`,
      es: `No se pudo guardar config.json (${file}): ENOSPC`,
    });
  });

  it('the store cannot prepare its config.json', async () => {
    const store = createRootsStore({
      home: 'C:\home',
      ensureConfig: () => {
        throw new Error('EPERM');
      },
    });
    expect(await inEach(() => messageOf(() => store.read()))).toEqual({
      'pt-BR': 'Não foi possível preparar o config.json em C:\home: EPERM',
      en: 'Could not prepare config.json in C:\home: EPERM',
      es: 'No se pudo preparar config.json en C:\home: EPERM',
    });
  });

  it('a folder list with every kind of problem reports all of them, in the language, with the code of an invalid input', async () => {
    const kinds: Record<string, PathKind> = { 'C:\\Arquivo.txt': 'file', 'C:\\Ausente': 'missing', 'D:\\Rede': 'timeout', 'C:\\Boa': 'dir' };
    const probe = (path: string): Promise<PathKind> => Promise.resolve(kinds[path] ?? 'missing');
    const input = ['C:\\Arquivo.txt', 'C:\\Ausente', 'D:\\Rede', 'C:\\Boa', 'relativa', 'C:\\' + 'x'.repeat(1100)];
    const texts = await inEach(() => messageOf(() => prepareRoots(input, [], probe)));
    expect(texts.en).toBe(
      [
        '"relativa" is not an absolute Windows path (for example, C:\\Projects).',
        // The path is shortened to its first 77 characters, the drive included.
        `The path "C:\\${'x'.repeat(74)}..." is too long.`,
        '"C:\\Arquivo.txt" is not a folder.',
        'The folder "C:\\Ausente" does not exist.',
        'The folder "D:\\Rede" did not answer in time. If it is on a network or on a disconnected drive, try again when it is available.',
      ].join(' '),
    );
    expect(texts.es).toContain('"relativa" no es una ruta absoluta de Windows (por ejemplo, C:\\Proyectos).');
    expect(texts.es).toContain('La carpeta "C:\\Ausente" no existe.');
    expect(texts['pt-BR']).toContain('"relativa" não é um caminho absoluto do Windows (por exemplo, C:\\Projetos).');
    setLanguage('es');
    await expect(prepareRoots(input, [], probe)).rejects.toBeInstanceOf(RootsConfigError);
    await expect(prepareRoots(input, [], probe)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('a list that is not a list, and one with too many folders', async () => {
    const probe = (): Promise<PathKind> => Promise.resolve('dir');
    expect(await inEach(() => messageOf(() => prepareRoots('C:\\A' as unknown as string[], [], probe)))).toEqual({
      'pt-BR': 'A lista de pastas é inválida.',
      en: 'The folder list is invalid.',
      es: 'La lista de carpetas no es válida.',
    });
    const many = Array.from({ length: 300 }, (_, index) => `C:\\F${index}`);
    expect(await inEach(() => messageOf(() => prepareRoots(many, [], probe)))).toEqual({
      'pt-BR': 'Muitas pastas: o máximo é 256.',
      en: 'Too many folders: the maximum is 256.',
      es: 'Demasiadas carpetas: el máximo es 256.',
    });
  });
});
