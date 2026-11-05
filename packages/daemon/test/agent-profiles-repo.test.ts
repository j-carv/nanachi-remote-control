import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  countAgentProfiles,
  countBusySessionsOnAccount,
  findAgentProfile,
  findSessionById,
  getActiveAccountId,
  insertAgentProfile,
  insertAgentProfileIfRoom,
  insertSession,
  listAgentProfiles,
  removeAgentProfile,
  renameAgentProfile,
  setActiveAccountId,
  updateSession,
} from '../src/repository.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-accounts-repo-'));
  db = openDatabase(join(dir, 'data.db'));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

function session(id: string, agent: string, accountId: string | null, status: 'idle' | 'stopped' = 'idle'): void {
  insertSession(db, {
    id,
    workspaceId: 'w-1',
    agent,
    title: id,
    status,
    createdAt: 1,
    accountId,
  });
}

describe('contas de agente (agent_accounts)', () => {
  it('lista por agente, na ordem de criação, e não mistura agentes', () => {
    insertAgentProfile(db, { id: 'a1', agent: 'claude', label: 'Trabalho', createdAt: 20 });
    insertAgentProfile(db, { id: 'b1', agent: 'codex', label: 'Pessoal', createdAt: 10 });
    insertAgentProfile(db, { id: 'a2', agent: 'claude', label: 'Família', createdAt: 30 });

    expect(listAgentProfiles(db, 'claude').map((row) => row.id)).toEqual(['a1', 'a2']);
    expect(listAgentProfiles(db, 'codex').map((row) => row.label)).toEqual(['Pessoal']);
    expect(countAgentProfiles(db, 'claude')).toBe(2);
  });

  it('acha uma conta pelo agente e pelo id, e não acha conta de outro agente', () => {
    insertAgentProfile(db, { id: 'a1', agent: 'claude', label: 'Trabalho', createdAt: 1 });
    expect(findAgentProfile(db, 'claude', 'a1')).toEqual({ id: 'a1', agent: 'claude', label: 'Trabalho', createdAt: 1 });
    expect(findAgentProfile(db, 'codex', 'a1')).toBeUndefined();
  });

  it('renomeia só dentro do agente e devolve a conta nova; id desconhecido devolve undefined', () => {
    insertAgentProfile(db, { id: 'a1', agent: 'claude', label: 'Trabalho', createdAt: 1 });
    expect(renameAgentProfile(db, 'claude', 'a1', 'Empresa')?.label).toBe('Empresa');
    expect(renameAgentProfile(db, 'codex', 'a1', 'X')).toBeUndefined();
    expect(renameAgentProfile(db, 'claude', 'nope', 'X')).toBeUndefined();
  });

  it('ponteiro da conta ativa: sem linha = principal; set com id; set null volta ao principal', () => {
    expect(getActiveAccountId(db, 'claude')).toBeUndefined();
    setActiveAccountId(db, 'claude', 'a1');
    expect(getActiveAccountId(db, 'claude')).toBe('a1');
    setActiveAccountId(db, 'claude', 'a2');
    expect(getActiveAccountId(db, 'claude')).toBe('a2');
    setActiveAccountId(db, 'claude', null);
    expect(getActiveAccountId(db, 'claude')).toBeUndefined();
  });

  it('conta em uso: só sessões com processo vivo (starting, running, awaiting_permission, idle) bloqueiam', () => {
    for (const status of ['starting', 'running', 'awaiting_permission', 'idle'] as const) {
      session(`s-${status}`, 'claude', 'a1');
      updateSession(db, `s-${status}`, { status }, 2);
    }
    session('s-stopped', 'claude', 'a1', 'stopped');
    session('s-other', 'claude', 'a2');
    updateSession(db, 's-other', { status: 'running' }, 2);
    session('s-principal', 'claude', null);
    updateSession(db, 's-principal', { status: 'running' }, 2);

    expect(countBusySessionsOnAccount(db, 'claude', 'a1')).toBe(4);
    expect(countBusySessionsOnAccount(db, 'claude', 'a3')).toBe(0);
    expect(countBusySessionsOnAccount(db, 'codex', 'a1')).toBe(0);
  });

  it('remover a conta apaga a linha, aponta a ativa para o principal e solta as sessões dela (outras contas ficam)', () => {
    insertAgentProfile(db, { id: 'a1', agent: 'claude', label: 'Trabalho', createdAt: 1 });
    insertAgentProfile(db, { id: 'a2', agent: 'claude', label: 'Família', createdAt: 2 });
    setActiveAccountId(db, 'claude', 'a1');
    session('s-1', 'claude', 'a1', 'stopped');
    session('s-2', 'claude', 'a2', 'stopped');

    removeAgentProfile(db, 'claude', 'a1');

    expect(findAgentProfile(db, 'claude', 'a1')).toBeUndefined();
    expect(getActiveAccountId(db, 'claude')).toBeUndefined();
    expect(findSessionById(db, 's-1')?.accountId).toBeNull();
    expect(findSessionById(db, 's-2')?.accountId).toBe('a2');
  });

  it('remover uma conta não mexe na ativa quando ela aponta para outra', () => {
    insertAgentProfile(db, { id: 'a1', agent: 'claude', label: 'Trabalho', createdAt: 1 });
    insertAgentProfile(db, { id: 'a2', agent: 'claude', label: 'Família', createdAt: 2 });
    setActiveAccountId(db, 'claude', 'a2');
    removeAgentProfile(db, 'claude', 'a1');
    expect(getActiveAccountId(db, 'claude')).toBe('a2');
  });
});

describe('insertAgentProfileIfRoom', () => {
  it('insere enquanto o agente tem menos contas que o limite e recusa (sem inserir) no limite', () => {
    expect(insertAgentProfileIfRoom(db, { id: 'a1', agent: 'claude', label: 'A', createdAt: 1 }, 2)).toBe(true);
    expect(insertAgentProfileIfRoom(db, { id: 'a2', agent: 'claude', label: 'B', createdAt: 2 }, 2)).toBe(true);
    expect(insertAgentProfileIfRoom(db, { id: 'a3', agent: 'claude', label: 'C', createdAt: 3 }, 2)).toBe(false);

    expect(listAgentProfiles(db, 'claude').map((profile) => profile.id)).toEqual(['a1', 'a2']);
  });

  it('o limite é por agente', () => {
    expect(insertAgentProfileIfRoom(db, { id: 'a1', agent: 'claude', label: 'A', createdAt: 1 }, 1)).toBe(true);
    expect(insertAgentProfileIfRoom(db, { id: 'c1', agent: 'codex', label: 'A', createdAt: 1 }, 1)).toBe(true);
    expect(countAgentProfiles(db, 'claude')).toBe(1);
    expect(countAgentProfiles(db, 'codex')).toBe(1);
  });
});

describe('sessions.accountId', () => {
  it('sessão sem conta lê accountId null (principal); com conta lê o id', () => {
    session('s-principal', 'claude', null);
    session('s-account', 'claude', 'a1');
    expect(findSessionById(db, 's-principal')?.accountId).toBeNull();
    expect(findSessionById(db, 's-account')?.accountId).toBe('a1');
  });
});
