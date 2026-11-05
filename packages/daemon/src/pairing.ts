import { randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { findDeviceByTokenHash, insertDevice, touchDevice, type DeviceRow, type PairMethod } from './repository.js';
import { generateToken, hashToken } from './tokens.js';

export const PAIR_CODE_TTL_MS = 5 * 60_000;
const MAX_CODE_ATTEMPTS = 20;

export type PairFailure = 'invalid' | 'expired' | 'used';

export type PairResult = { ok: true; token: string; deviceId: string } | { ok: false; reason: PairFailure };

/**
 * Gera um código de 6 dígitos de uso único, válido por PAIR_CODE_TTL_MS.
 * Antes, marca como usados os códigos anteriores ainda válidos: só o código mais recente vale.
 */
export function createPairCode(db: Database.Database, now: number): string {
  db.prepare<[number, number]>('UPDATE pair_codes SET used_at = ? WHERE used_at IS NULL AND expires_at > ?').run(now, now);
  db.prepare<[number]>('DELETE FROM pair_codes WHERE expires_at <= ?').run(now);

  const exists = db.prepare<[string], { code: string }>('SELECT code FROM pair_codes WHERE code = ?');
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    if (exists.get(code) === undefined) {
      db.prepare<[string, number]>('INSERT INTO pair_codes (code, expires_at) VALUES (?, ?)').run(
        code,
        now + PAIR_CODE_TTL_MS,
      );
      return code;
    }
  }
  throw new Error('não foi possível gerar um código de pareamento único');
}

/** Cria o device com um token novo e devolve o token (só ele vê o texto puro; o banco guarda o hash). */
function createDevice(
  db: Database.Database,
  input: { deviceName: string; now: number; pairMethod: PairMethod },
): { token: string; deviceId: string } {
  const token = generateToken();
  const deviceId = randomUUID();
  insertDevice(db, {
    id: deviceId,
    name: input.deviceName,
    tokenHash: hashToken(token),
    createdAt: input.now,
    pairMethod: input.pairMethod,
  });
  return { token, deviceId };
}

/** Consome o código e cria o dispositivo com um token novo. Tudo numa transação. */
export function pairDevice(
  db: Database.Database,
  input: { code: string; deviceName: string; now: number },
): PairResult {
  return db.transaction((): PairResult => {
    const row = db
      .prepare<[string], { expires_at: number; used_at: number | null }>(
        'SELECT expires_at, used_at FROM pair_codes WHERE code = ?',
      )
      .get(input.code);
    if (row === undefined) return { ok: false, reason: 'invalid' };
    if (row.used_at !== null) return { ok: false, reason: 'used' };
    if (row.expires_at <= input.now) return { ok: false, reason: 'expired' };

    db.prepare<[number, string]>('UPDATE pair_codes SET used_at = ? WHERE code = ?').run(input.now, input.code);
    return { ok: true, ...createDevice(db, { deviceName: input.deviceName, now: input.now, pairMethod: 'code' }) };
  })();
}

/**
 * Entrar com Tailscale: cria o device sem código. Quem chama já checou o login (peer loopback, allowlist e
 * `tailscaleAutoPair`); aqui só se grava o device com `pair_method = 'tailscale'`.
 */
export function pairDeviceViaTailscale(
  db: Database.Database,
  input: { deviceName: string; now: number },
): { token: string; deviceId: string } {
  return createDevice(db, { ...input, pairMethod: 'tailscale' });
}

/** Devolve o dispositivo ativo dono do token e atualiza last_seen_at. Nunca lança. */
export function authenticateToken(
  db: Database.Database,
  token: string | undefined,
  now: number,
): DeviceRow | undefined {
  if (token === undefined || token.length === 0) return undefined;
  const device = findDeviceByTokenHash(db, hashToken(token));
  if (device === undefined || device.revokedAt !== null) return undefined;
  touchDevice(db, device.id, now);
  return { ...device, lastSeenAt: now };
}
