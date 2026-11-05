import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { messageOf } from '../common/message.js';
import type { PairingCode, SeedMachine } from '../common/types.js';

export type PairingErrorKind = 'cli_failed' | 'bad_output' | 'rejected' | 'rate_limited' | 'network' | 'bad_response';

export class PairingError extends Error {
  readonly kind: PairingErrorKind;
  constructor(kind: PairingErrorKind, message: string) {
    super(message);
    this.name = 'PairingError';
    this.kind = kind;
  }
}

/**
 * Parses what `cli.js pair --json` prints: one JSON line `{"code":"123456","expiresAt":<ms>}`. Earlier noise lines
 * are tolerated (the last non-empty line wins); a malformed line is an error, never a guess.
 */
export function parsePairOutput(stdout: string): PairingCode {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) throw new PairingError('bad_output', 'o comando de pareamento não imprimiu nada');

  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    throw new PairingError('bad_output', 'o comando de pareamento imprimiu algo que não é JSON');
  }
  if (typeof json !== 'object' || json === null) {
    throw new PairingError('bad_output', 'resposta do comando de pareamento inválida');
  }
  const { code, expiresAt } = json as Record<string, unknown>;
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
    throw new PairingError('bad_output', 'o código de pareamento não tem 6 dígitos');
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new PairingError('bad_output', 'a validade do código de pareamento é inválida');
  }
  return { code, expiresAt };
}

/** What `cli.js device add --json` prints: one JSON line `{"deviceId":"...","token":"..."}`. */
export interface NewDevice {
  deviceId: string;
  token: string;
}

/** Parses the line of `device add --json`. Earlier noise lines are tolerated; a malformed line is an error, never a guess. */
export function parseDeviceOutput(stdout: string): NewDevice {
  const last = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .at(-1);
  if (last === undefined) throw new PairingError('bad_output', 'o comando de dispositivo não imprimiu nada');

  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    throw new PairingError('bad_output', 'o comando de dispositivo imprimiu algo que não é JSON');
  }
  if (typeof json !== 'object' || json === null) {
    throw new PairingError('bad_output', 'resposta do comando de dispositivo inválida');
  }
  const { deviceId, token } = json as Record<string, unknown>;
  if (typeof deviceId !== 'string' || deviceId === '' || typeof token !== 'string' || token === '') {
    throw new PairingError('bad_output', 'o comando de dispositivo não devolveu deviceId e token');
  }
  return { deviceId, token };
}

/** Device name given to `device add` (and shown in the PWA's device list): the daemon accepts 1 to 64 characters. */
export function desktopDeviceName(hostname: string): string {
  const prefix = 'Nanachi Desktop (';
  const room = 64 - prefix.length - 1;
  const name = hostname.trim() === '' ? 'PC' : hostname.trim();
  return `${prefix}${name.slice(0, room)})`;
}

/** Where the token lives between runs. */
export interface TokenStore {
  load(): SeedMachine | null;
  /** False when the token could not be kept (no OS encryption): the caller then keeps it in memory only. */
  save(machine: SeedMachine): boolean;
  clear(): void;
}

/** The part of Electron's `safeStorage` used here (Windows: DPAPI). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function isSeedMachine(value: unknown): value is SeedMachine {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['id', 'name', 'baseUrl', 'token'].every((key) => typeof record[key] === 'string' && record[key] !== '');
}

/**
 * Token store in a file, encrypted with `safeStorage`. Without encryption nothing is written: no plain-text tokens.
 *
 * Known limit: the token also reaches the panel's own storage. The preload seeds `nanachi.machines` (token included) into
 * the PWA's `localStorage`, which Chromium keeps unencrypted under `%APPDATA%\Nanachi\Local Storage`. That is the same
 * place and trust level as the PWA on any phone or browser (anyone who can read the Windows user's files can read it),
 * and the PWA offers no other way to be handed a token. The encrypted file here is what survives a cleared profile.
 */
export function createTokenStore(file: string, safe: SafeStorageLike): TokenStore {
  return {
    load() {
      try {
        if (!safe.isEncryptionAvailable()) return null;
        const parsed: unknown = JSON.parse(safe.decryptString(readFileSync(file)));
        return isSeedMachine(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    save(machine) {
      try {
        if (!safe.isEncryptionAvailable()) return false;
        mkdirSync(dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        writeFileSync(temp, safe.encryptString(JSON.stringify(machine)));
        renameSync(temp, file);
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      rmSync(file, { force: true });
    },
  };
}

export interface PairingDeps {
  /** Runs `node cli.js pair --json` under the same runtime as the daemon and returns what it printed. */
  runPairCli(): Promise<string>;
  /**
   * Runs `node cli.js device add --name <name> --json`. Desktop's own device is made this way and not with a pairing
   * code: `pair` makes the daemon drop every code that is still valid, so it would break one the user is typing.
   */
  runDeviceAddCli(name: string): Promise<string>;
  fetchImpl: typeof fetch;
  store: TokenStore;
  /** `http://127.0.0.1:<port>`, read when needed so a port change is honoured. */
  baseUrl(): string;
  deviceName: string;
  now?: () => number;
}

/** Minimum time between two automatic re-pairs triggered by a 401 seen in the panel. */
const REPAIR_COOLDOWN_MS = 30_000;

export interface DesktopPairing {
  /** A fresh 6-digit code from the daemon CLI (for the pairing window and the PWA sheet). It invalidates older codes. */
  generateCode(): Promise<PairingCode>;
  /** The machine the panel needs: the stored one if the daemon still accepts it, else a new pairing (once). */
  ensureMachine(): Promise<SeedMachine>;
  /** What is held right now, without any network call. */
  current(): SeedMachine | null;
  /**
   * The panel saw a 401. Checks the stored token against `/api/me` and pairs again if it was revoked.
   * Returns the new machine only when the token changed. Rate limited, and never runs twice at once.
   */
  recoverFromUnauthorized(): Promise<SeedMachine | null>;
}

export function createPairing(deps: PairingDeps): DesktopPairing {
  const now = deps.now ?? Date.now;
  let machine: SeedMachine | null = null;
  let inflight: Promise<SeedMachine> | null = null;
  let lastRepairAt = Number.NEGATIVE_INFINITY;

  async function generateCode(): Promise<PairingCode> {
    return parsePairOutput(await deps.runPairCli());
  }

  async function pairNew(): Promise<SeedMachine> {
    const { token } = parseDeviceOutput(await deps.runDeviceAddCli(deps.deviceName));
    const baseUrl = deps.baseUrl();
    // The CLI knows the device, not which machine it belongs to: the daemon says so when the new token is used.
    let response: Response;
    try {
      response = await deps.fetchImpl(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new PairingError('network', `o daemon não respondeu ao pareamento: ${messageOf(error)}`);
    }
    if (response.status === 429) throw new PairingError('rate_limited', 'muitas tentativas de pareamento; aguarde um pouco');
    if (!response.ok) throw new PairingError('rejected', `o daemon recusou o novo dispositivo (HTTP ${response.status})`);

    const body: unknown = await response.json().catch(() => null);
    const { machineId, machineName } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof machineId !== 'string' || typeof machineName !== 'string' || machineId === '' || machineName === '') {
      throw new PairingError('bad_response', 'resposta de pareamento inválida');
    }
    const paired: SeedMachine = { id: machineId, name: machineName, baseUrl, token };
    deps.store.save(paired);
    machine = paired;
    return paired;
  }

  /** `unauthorized`: the daemon says the token is not valid. Any other failure keeps the token (the daemon may be down). */
  async function checkToken(candidate: SeedMachine): Promise<'valid' | 'unauthorized' | 'unknown'> {
    try {
      const response = await deps.fetchImpl(`${candidate.baseUrl}/api/me`, {
        headers: { authorization: `Bearer ${candidate.token}` },
      });
      if (response.status === 401) return 'unauthorized';
      return response.ok ? 'valid' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function ensure(): Promise<SeedMachine> {
    const baseUrl = deps.baseUrl();
    const candidate = machine ?? deps.store.load();
    if (candidate !== null && candidate.baseUrl === baseUrl) {
      const verdict = await checkToken(candidate);
      if (verdict !== 'unauthorized') {
        machine = candidate;
        return candidate;
      }
    }
    // First run, a different daemon address, or a revoked device: pair again, one attempt.
    deps.store.clear();
    machine = null;
    lastRepairAt = now();
    return pairNew();
  }

  function once(): Promise<SeedMachine> {
    inflight ??= ensure().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    generateCode,
    ensureMachine: once,
    current: () => machine,
    async recoverFromUnauthorized() {
      if (inflight !== null || machine === null) return null;
      if (now() - lastRepairAt < REPAIR_COOLDOWN_MS) return null;
      const stale = machine;
      if ((await checkToken(stale)) !== 'unauthorized') return null;
      const repaired = await once();
      return repaired.token === stale.token ? null : repaired;
    },
  };
}
