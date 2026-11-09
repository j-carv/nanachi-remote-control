import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { insertDevice, listPushSubscriptions, upsertPushSubscription } from '../src/repository.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-push-language-'));
  db = openDatabase(join(dir, 'data.db'));
  insertDevice(db, { id: 'd1', name: 'iPhone', tokenHash: 'hash-d1', createdAt: 1 });
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

const keys = { p256dh: 'p256', auth: 'auth' };
const ENDPOINT = 'https://push.example.test/d1';

function languageOf(endpoint: string): string | null | undefined {
  return listPushSubscriptions(db).find((row) => row.endpoint === endpoint)?.language;
}

describe('push subscription language', () => {
  it('stores the language with the subscription and returns it from listPushSubscriptions', () => {
    upsertPushSubscription(db, { endpoint: ENDPOINT, deviceId: 'd1', keys, language: 'es', createdAt: 1 });

    expect(languageOf(ENDPOINT)).toBe('es');
  });

  it('a subscription without a language (made before the column, or by an older client) lists as null', () => {
    upsertPushSubscription(db, { endpoint: ENDPOINT, deviceId: 'd1', keys, createdAt: 1 });

    expect(languageOf(ENDPOINT)).toBeNull();
  });

  it('subscribing the same endpoint again with another language replaces it', () => {
    upsertPushSubscription(db, { endpoint: ENDPOINT, deviceId: 'd1', keys, language: 'pt-BR', createdAt: 1 });
    upsertPushSubscription(db, { endpoint: ENDPOINT, deviceId: 'd1', keys, language: 'en', createdAt: 2 });

    expect(languageOf(ENDPOINT)).toBe('en');
  });

  it('subscribing again without a language keeps the one already stored', () => {
    upsertPushSubscription(db, { endpoint: ENDPOINT, deviceId: 'd1', keys, language: 'en', createdAt: 1 });
    upsertPushSubscription(db, { endpoint: ENDPOINT, deviceId: 'd1', keys, createdAt: 2 });

    expect(languageOf(ENDPOINT)).toBe('en');
  });
});
