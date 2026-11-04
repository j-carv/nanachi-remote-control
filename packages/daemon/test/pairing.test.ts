import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { PAIR_CODE_TTL_MS, authenticateToken, createPairCode, pairDevice } from '../src/pairing.js';
import { createFailureLimiter } from '../src/rate-limit.js';
import { ensureMachine, listDevices, revokeDevice } from '../src/repository.js';
import { generateToken, hashToken } from '../src/tokens.js';
import { removeTempDir } from './temp.js';

const MINUTE = 60_000;
let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-pair-'));
  db = openDatabase(join(dir, 'data.db'));
  ensureMachine(db, 'PC-TESTE');
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

describe('generateToken / hashToken', () => {
  it('gera 32 bytes aleatórios em base64url, sem repetição', () => {
    const token = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
  });

  it('hashToken é sha256 hex do token', () => {
    const expected = createHash('sha256').update('abc').digest('hex');
    expect(hashToken('abc')).toBe(expected);
  });
});

describe('createPairCode', () => {
  it('gera código de 6 dígitos que expira em 5 minutos', () => {
    const now = 1_000_000;
    const code = createPairCode(db, now);

    expect(code).toMatch(/^\d{6}$/);
    expect(PAIR_CODE_TTL_MS).toBe(5 * MINUTE);
    const row = db
      .prepare<[string], { expires_at: number; used_at: number | null }>(
        'SELECT expires_at, used_at FROM pair_codes WHERE code = ?',
      )
      .get(code);
    expect(row).toEqual({ expires_at: now + 5 * MINUTE, used_at: null });
  });

  it('gerar um código novo invalida os anteriores ainda válidos', () => {
    const now = Date.now();
    const first = createPairCode(db, now);
    const second = createPairCode(db, now + 1000);

    expect(pairDevice(db, { code: first, deviceName: 'antigo', now: now + 2000 })).toEqual({ ok: false, reason: 'used' });
    expect(pairDevice(db, { code: second, deviceName: 'iPhone', now: now + 2000 }).ok).toBe(true);
  });

  it('remove códigos expirados ao gerar um novo', () => {
    createPairCode(db, 0);
    createPairCode(db, 10 * MINUTE);

    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM pair_codes').get()).toEqual({ count: 1 });
  });
});

describe('pairDevice', () => {
  it('troca código válido por token e grava só o sha256 do token', () => {
    const now = Date.now();
    const code = createPairCode(db, now);

    const result = pairDevice(db, { code, deviceName: 'iPhone', now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db
      .prepare<[string], { token_hash: string }>('SELECT token_hash FROM devices WHERE id = ?')
      .get(result.deviceId);
    expect(row?.token_hash).toBe(hashToken(result.token));
    expect(db.prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM devices WHERE token_hash = ?').get(result.token)).toEqual({ count: 0 });
  });

  it('código que não existe → invalid', () => {
    const result = pairDevice(db, { code: '123456', deviceName: 'iPhone', now: Date.now() });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('código expirado → expired', () => {
    const now = Date.now();
    const code = createPairCode(db, now - 6 * MINUTE);

    expect(pairDevice(db, { code, deviceName: 'iPhone', now })).toEqual({ ok: false, reason: 'expired' });
  });

  it('código já usado → used, sem criar outro dispositivo', () => {
    const now = Date.now();
    const code = createPairCode(db, now);
    expect(pairDevice(db, { code, deviceName: 'iPhone', now }).ok).toBe(true);

    expect(pairDevice(db, { code, deviceName: 'outro', now })).toEqual({ ok: false, reason: 'used' });
    expect(listDevices(db)).toHaveLength(1);
  });
});

describe('authenticateToken', () => {
  it('aceita token ativo e atualiza last_seen_at', () => {
    const now = Date.now();
    const pairing = pairDevice(db, { code: createPairCode(db, now), deviceName: 'iPhone', now });
    if (!pairing.ok) throw new Error('pareamento de teste falhou');

    const device = authenticateToken(db, pairing.token, now + 1000);
    expect(device).toMatchObject({ id: pairing.deviceId, name: 'iPhone', lastSeenAt: now + 1000 });
  });

  it('rejeita token desconhecido', () => {
    expect(authenticateToken(db, 'nao-existe', Date.now())).toBeUndefined();
  });

  it('rejeita token de dispositivo revogado', () => {
    const now = Date.now();
    const pairing = pairDevice(db, { code: createPairCode(db, now), deviceName: 'iPhone', now });
    if (!pairing.ok) throw new Error('pareamento de teste falhou');

    expect(revokeDevice(db, pairing.deviceId, now)).toBe(true);
    expect(authenticateToken(db, pairing.token, now)).toBeUndefined();
  });
});

describe('revokeDevice', () => {
  it('retorna false para id inexistente ou já revogado', () => {
    const now = Date.now();
    const pairing = pairDevice(db, { code: createPairCode(db, now), deviceName: 'iPhone', now });
    if (!pairing.ok) throw new Error('pareamento de teste falhou');

    expect(revokeDevice(db, 'nao-existe', now)).toBe(false);
    expect(revokeDevice(db, pairing.deviceId, now)).toBe(true);
    expect(revokeDevice(db, pairing.deviceId, now)).toBe(false);
  });
});

describe('createFailureLimiter', () => {
  it('bloqueia a partir de 5 falhas na janela de 1 minuto e libera depois', () => {
    const limiter = createFailureLimiter({ maxFailures: 5, windowMs: MINUTE });
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4', 0);
    expect(limiter.isBlocked('1.2.3.4', 0)).toBe(false);

    limiter.recordFailure('1.2.3.4', 0);
    expect(limiter.isBlocked('1.2.3.4', 0)).toBe(true);
    expect(limiter.isBlocked('1.2.3.4', MINUTE - 1)).toBe(true);
    expect(limiter.isBlocked('1.2.3.4', MINUTE)).toBe(false);
  });

  it('isola contadores por chave (IP)', () => {
    const limiter = createFailureLimiter({ maxFailures: 1, windowMs: MINUTE });
    limiter.recordFailure('a', 0);

    expect(limiter.isBlocked('a', 0)).toBe(true);
    expect(limiter.isBlocked('b', 0)).toBe(false);
  });
});
