import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SeedMachine } from '../src/common/types.js';
import {
  createPairing,
  createTokenStore,
  desktopDeviceName,
  PairingError,
  parseDeviceOutput,
  parsePairOutput,
  type SafeStorageLike,
  type TokenStore,
} from '../src/main/pairing.js';
import { removeDir } from './remove-dir.js';

describe('parsePairOutput', () => {
  it('reads the exact line the daemon CLI prints', () => {
    expect(parsePairOutput('{"code":"123456","expiresAt":1793854103853}\n')).toEqual({
      code: '123456',
      expiresAt: 1793854103853,
    });
  });

  it('keeps leading zeros and accepts CRLF and earlier noise lines', () => {
    expect(parsePairOutput('warming up\r\n{"code":"004217","expiresAt":5}\r\n')).toEqual({ code: '004217', expiresAt: 5 });
  });

  it.each([
    ['empty output', ''],
    ['only whitespace', '  \n\n'],
    ['text, not JSON', 'Código de pareamento: 123456 (uso único, válido por 5 min)'],
    ['an array', '[1,2]'],
    ['a short code', '{"code":"12345","expiresAt":5}'],
    ['a code with letters', '{"code":"12345a","expiresAt":5}'],
    ['a numeric code', '{"code":123456,"expiresAt":5}'],
    ['a string expiry', '{"code":"123456","expiresAt":"5"}'],
    ['a zero expiry', '{"code":"123456","expiresAt":0}'],
    ['no expiry', '{"code":"123456"}'],
  ])('rejects %s', (_label, output) => {
    expect(() => parsePairOutput(output)).toThrowError(PairingError);
  });
});

describe('parseDeviceOutput', () => {
  it('reads the exact line `device add --json` prints', () => {
    expect(parseDeviceOutput('{"deviceId":"d-1","token":"abc"}\n')).toEqual({ deviceId: 'd-1', token: 'abc' });
  });

  it('accepts CRLF and earlier noise lines (the last one wins)', () => {
    expect(parseDeviceOutput('warming up\r\n{"deviceId":"d-1","token":"abc"}\r\n')).toEqual({ deviceId: 'd-1', token: 'abc' });
  });

  it.each([
    ['empty output', ''],
    ['text, not JSON', 'Dispositivo d-1 criado. Token: abc'],
    ['an array', '[1,2]'],
    ['no token', '{"deviceId":"d-1"}'],
    ['an empty token', '{"deviceId":"d-1","token":""}'],
    ['a numeric token', '{"deviceId":"d-1","token":5}'],
    ['no device id', '{"token":"abc"}'],
  ])('rejects %s', (_label, output) => {
    expect(() => parseDeviceOutput(output)).toThrowError(PairingError);
  });
});

describe('desktopDeviceName', () => {
  it('names the device after the PC, within the 64 characters the daemon accepts', () => {
    expect(desktopDeviceName('OFFICE-PC')).toBe('Nanachi Desktop (OFFICE-PC)');
    expect(desktopDeviceName('')).toBe('Nanachi Desktop (PC)');
    const long = desktopDeviceName('x'.repeat(200));
    expect(long.length).toBe(64);
    expect(long.endsWith(')')).toBe(true);
  });
});

/** Reversible stand-in for DPAPI. */
const fakeSafe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
});

const MACHINE: SeedMachine = { id: 'm-1', name: 'PC', baseUrl: 'http://127.0.0.1:7811', token: 'tok-old' };

describe('token store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanachi-desktop-token-'));
  });
  afterEach(() => {
    removeDir(dir);
  });

  it('round-trips the machine and never writes the token in clear text', () => {
    const file = join(dir, 'sub', 'machine.bin');
    const store = createTokenStore(file, fakeSafe());
    expect(store.save(MACHINE)).toBe(true);
    expect(readFileSync(file).toString('latin1')).not.toContain('tok-old');
    expect(createTokenStore(file, fakeSafe()).load()).toEqual(MACHINE);
  });

  it('writes nothing when the OS cannot encrypt', () => {
    const file = join(dir, 'machine.bin');
    const store = createTokenStore(file, fakeSafe(false));
    expect(store.save(MACHINE)).toBe(false);
    expect(store.load()).toBeNull();
    expect(() => readFileSync(file)).toThrow();
  });

  it('treats a corrupt or foreign file as no machine', () => {
    const file = join(dir, 'machine.bin');
    writeFileSync(file, 'garbage');
    expect(createTokenStore(file, fakeSafe()).load()).toBeNull();

    writeFileSync(file, Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').reverse());
    expect(createTokenStore(file, fakeSafe()).load()).toBeNull();
  });

  it('clear removes the file and is fine when there is none', () => {
    const file = join(dir, 'machine.bin');
    const store = createTokenStore(file, fakeSafe());
    store.clear();
    store.save(MACHINE);
    store.clear();
    expect(store.load()).toBeNull();
  });
});

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function memoryStore(initial: SeedMachine | null): TokenStore & { saved: SeedMachine[]; cleared: number } {
  let value = initial;
  const store = {
    saved: [] as SeedMachine[],
    cleared: 0,
    load: () => value,
    save(machine: SeedMachine) {
      value = machine;
      store.saved.push(machine);
      return true;
    },
    clear() {
      value = null;
      store.cleared += 1;
    },
  };
  return store;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `GET /api/me` of the daemon: who the token belongs to. */
const ME = { deviceId: 'd-2', deviceName: 'Nanachi Desktop (OFFICE-PC)', machineId: 'm-1', machineName: 'PC' };

/** The bearer token of a fake request. */
function bearer(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.authorization?.replace('Bearer ', '');
}

interface Setup {
  pairing: ReturnType<typeof createPairing>;
  store: ReturnType<typeof memoryStore>;
  calls: FetchCall[];
  /** How many times `pair --json` ran (a code for a phone). Desktop's own pairing must never use it. */
  pairRuns: () => number;
  /** The names `device add` was asked for. */
  deviceNames: string[];
  setNow(value: number): void;
}

function setup(
  stored: SeedMachine | null,
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  options: { pairOutput?: string; deviceOutput?: string | (() => Promise<string>) } = {},
): Setup {
  const calls: FetchCall[] = [];
  const store = memoryStore(stored);
  const deviceNames: string[] = [];
  let pairRuns = 0;
  let now = 1_000_000;
  const pairing = createPairing({
    runPairCli: () => {
      pairRuns += 1;
      return Promise.resolve(options.pairOutput ?? '{"code":"123456","expiresAt":999}');
    },
    runDeviceAddCli: (name) => {
      deviceNames.push(name);
      const output = options.deviceOutput ?? '{"deviceId":"d-2","token":"tok-new"}';
      return typeof output === 'string' ? Promise.resolve(output) : output();
    },
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return Promise.resolve(respond(url, init));
    }) as typeof fetch,
    store,
    baseUrl: () => 'http://127.0.0.1:7811',
    deviceName: 'Nanachi Desktop (OFFICE-PC)',
    now: () => now,
  });
  return { pairing, store, calls, pairRuns: () => pairRuns, deviceNames, setNow: (value) => (now = value) };
}

/** A daemon that accepts only the tokens in `valid` (a revoked token is a 401). */
function daemonAccepting(valid: () => string[]): (url: string, init: RequestInit | undefined) => Response {
  return (url, init) => {
    if (url.endsWith('/api/me')) {
      const token = bearer(init);
      return token !== undefined && valid().includes(token) ? json(200, ME) : json(401, { error: 'unauthorized' });
    }
    return json(500, {});
  };
}

describe('first pairing', () => {
  it('adds its own device through the CLI (no pairing code) and asks the daemon whom the new token belongs to', async () => {
    const s = setup(null, () => json(200, ME));
    const machine = await s.pairing.ensureMachine();

    expect(machine).toEqual({ id: 'm-1', name: 'PC', baseUrl: 'http://127.0.0.1:7811', token: 'tok-new' });
    expect(s.deviceNames).toEqual(['Nanachi Desktop (OFFICE-PC)']);
    // `pair --json` would make the daemon drop the code a person is typing on the phone.
    expect(s.pairRuns()).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe('http://127.0.0.1:7811/api/me');
    expect(bearer(s.calls[0]?.init)).toBe('tok-new');
    expect(s.calls.some((call) => call.url.endsWith('/api/pair'))).toBe(false);
    expect(s.store.saved).toEqual([machine]);
    expect(s.pairing.current()).toEqual(machine);
  });

  it('shares one pairing between concurrent callers', async () => {
    const s = setup(null, () => json(200, ME));
    const [a, b] = await Promise.all([s.pairing.ensureMachine(), s.pairing.ensureMachine()]);
    expect(a).toBe(b);
    expect(s.deviceNames).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
  });

  it.each([
    [401, 'rejected'],
    [429, 'rate_limited'],
    [500, 'rejected'],
  ])('HTTP %i from /api/me is a PairingError (%s) and nothing is stored', async (status, kind) => {
    const s = setup(null, () => json(status, { error: 'x' }));
    await expect(s.pairing.ensureMachine()).rejects.toMatchObject({ name: 'PairingError', kind });
    expect(s.store.saved).toEqual([]);
    expect(s.pairing.current()).toBeNull();
  });

  it('rejects an answer without the machine', async () => {
    const s = setup(null, () => json(200, { deviceId: 'd-2', deviceName: 'x' }));
    await expect(s.pairing.ensureMachine()).rejects.toMatchObject({ kind: 'bad_response' });
    expect(s.store.saved).toEqual([]);
  });

  it('reports a daemon that is not answering', async () => {
    const s = setup(null, () => Promise.reject(new Error('connect ECONNREFUSED')));
    await expect(s.pairing.ensureMachine()).rejects.toMatchObject({ kind: 'network' });
  });

  it('reports a rejection that is not an Error with its own text, never "undefined"', async () => {
    const s = setup(null, () => Promise.reject('connection reset' as unknown as Error));
    await expect(s.pairing.ensureMachine()).rejects.toThrow(/connection reset/);
  });

  it('surfaces a failing or garbled device command and never calls the daemon', async () => {
    const failing = setup(null, () => json(200, ME), { deviceOutput: () => Promise.reject(new PairingError('cli_failed', 'sem banco')) });
    await expect(failing.pairing.ensureMachine()).rejects.toMatchObject({ kind: 'cli_failed' });
    expect(failing.calls).toHaveLength(0);

    const garbled = setup(null, () => json(200, ME), { deviceOutput: 'Dispositivo criado' });
    await expect(garbled.pairing.ensureMachine()).rejects.toMatchObject({ kind: 'bad_output' });
    expect(garbled.calls).toHaveLength(0);
  });

  it('the new token is never sent anywhere but this daemon', async () => {
    const s = setup(null, () => json(200, ME));
    await s.pairing.ensureMachine();
    expect(s.calls.every((call) => call.url.startsWith('http://127.0.0.1:7811/'))).toBe(true);
  });
});

describe('stored token', () => {
  it('is reused when the daemon accepts it: no CLI, no new device', async () => {
    const s = setup(MACHINE, daemonAccepting(() => ['tok-old']));
    expect(await s.pairing.ensureMachine()).toEqual(MACHINE);
    expect(s.deviceNames).toEqual([]);
    expect(s.pairRuns()).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe('http://127.0.0.1:7811/api/me');
    expect(bearer(s.calls[0]?.init)).toBe('tok-old');
  });

  it('adds a new device exactly once when the daemon says 401 (device revoked)', async () => {
    const s = setup(MACHINE, daemonAccepting(() => ['tok-new']));
    const machine = await s.pairing.ensureMachine();

    expect(machine.token).toBe('tok-new');
    expect(s.deviceNames).toHaveLength(1);
    expect(s.pairRuns()).toBe(0);
    expect(s.calls.map((call) => `${call.url} ${bearer(call.init)}`)).toEqual([
      'http://127.0.0.1:7811/api/me tok-old',
      'http://127.0.0.1:7811/api/me tok-new',
    ]);
    expect(s.store.cleared).toBe(1);
    expect(s.store.saved).toEqual([machine]);
  });

  it('does not loop: if the second pairing fails the error surfaces and the old token is gone', async () => {
    const s = setup(MACHINE, daemonAccepting(() => []));
    await expect(s.pairing.ensureMachine()).rejects.toMatchObject({ kind: 'rejected' });
    expect(s.deviceNames).toHaveLength(1);
    expect(s.store.load()).toBeNull();
  });

  it('keeps the token when the daemon is unreachable or answers 5xx (it may just be down)', async () => {
    const down = setup(MACHINE, () => Promise.reject(new Error('ECONNREFUSED')));
    expect(await down.pairing.ensureMachine()).toEqual(MACHINE);
    expect(down.deviceNames).toEqual([]);

    const broken = setup(MACHINE, () => json(503, {}));
    expect(await broken.pairing.ensureMachine()).toEqual(MACHINE);
    expect(broken.deviceNames).toEqual([]);
  });

  it('pairs again when the stored machine belongs to another address', async () => {
    const other: SeedMachine = { ...MACHINE, baseUrl: 'http://127.0.0.1:7777' };
    const s = setup(other, () => json(200, ME));
    const machine = await s.pairing.ensureMachine();
    expect(machine.baseUrl).toBe('http://127.0.0.1:7811');
    // The old token was never sent to the new address.
    expect(s.calls.map((call) => `${call.url} ${bearer(call.init)}`)).toEqual(['http://127.0.0.1:7811/api/me tok-new']);
  });
});

describe('recoverFromUnauthorized (a 401 seen in the panel)', () => {
  it('does nothing before the first pairing', async () => {
    const s = setup(null, () => json(200, ME));
    expect(await s.pairing.recoverFromUnauthorized()).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it('keeps the token when the daemon still accepts it (the 401 was something else)', async () => {
    let valid = ['tok-old', 'tok-new'];
    const s = setup(MACHINE, daemonAccepting(() => valid));
    await s.pairing.ensureMachine();
    s.setNow(5_000_000);
    expect(await s.pairing.recoverFromUnauthorized()).toBeNull();
    expect(s.deviceNames).toEqual([]);

    valid = ['tok-new'];
    const repaired = await s.pairing.recoverFromUnauthorized();
    expect(repaired?.token).toBe('tok-new');
    expect(s.deviceNames).toHaveLength(1);
  });

  it('is rate limited so a revoked device cannot trigger a pairing storm', async () => {
    let valid = ['tok-old', 'tok-new'];
    const s = setup(MACHINE, daemonAccepting(() => valid));
    await s.pairing.ensureMachine();
    s.setNow(5_000_000);
    valid = ['tok-new'];
    expect((await s.pairing.recoverFromUnauthorized())?.token).toBe('tok-new');

    // Revoked again right after: inside the cooldown nothing happens.
    valid = [];
    s.setNow(5_010_000);
    expect(await s.pairing.recoverFromUnauthorized()).toBeNull();
    expect(s.deviceNames).toHaveLength(1);

    // After the cooldown a repair is allowed again (and fails here: this daemon accepts nothing).
    s.setNow(5_100_000);
    await expect(s.pairing.recoverFromUnauthorized()).rejects.toMatchObject({ kind: 'rejected' });
    expect(s.deviceNames).toHaveLength(2);
  });
});

describe('generateCode', () => {
  it('returns a code without pairing anything', async () => {
    const s = setup(null, () => json(500, {}), { pairOutput: '{"code":"654321","expiresAt":42}' });
    expect(await s.pairing.generateCode()).toEqual({ code: '654321', expiresAt: 42 });
    expect(s.calls).toHaveLength(0);
    expect(s.deviceNames).toEqual([]);
  });

  it('surfaces malformed CLI output as an error', async () => {
    const s = setup(null, () => json(500, {}), { pairOutput: 'nope' });
    await expect(s.pairing.generateCode()).rejects.toMatchObject({ kind: 'bad_output' });
  });
});
