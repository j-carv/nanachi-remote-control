import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSearchResponseSchema } from '@nanachi/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeader } from './agent-support.js';
import { openDatabase } from '../src/db.js';
import {
  deleteSessionRows,
  insertEvent,
  insertSession,
  insertWorkspace,
  searchSessionMessages,
} from '../src/repository.js';
import { setupDaemonTests } from './support.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-search-'));
});

afterEach(async () => {
  db?.close();
  db = undefined;
  await removeTempDir(dir);
});

/** Records an event the way the SessionManager does: `payload` is the draft itself, as JSON, with its `kind`. */
function event(database: Database.Database, sessionId: string, ts: number, payload: Record<string, unknown>): void {
  insertEvent(database, { sessionId, ts, kind: String(payload.kind), payload: JSON.stringify(payload) });
}

function session(database: Database.Database, id: string, workspaceId: string, title: string): void {
  insertSession(database, { id, workspaceId, agent: 'omp', title, status: 'idle', createdAt: 1 });
}

/**
 * Two workspaces and four sessions. `s-gone` belongs to a deleted workspace: its row stays in the database, so the
 * search must not return it (the screens have no way to open it).
 */
function seed(database: Database.Database): void {
  insertWorkspace(database, { id: 'w-1', name: 'app', path: 'C:\\app', createdAt: 1, muted: false });
  insertWorkspace(database, { id: 'w-2', name: 'docs', path: 'C:\\docs', createdAt: 1, muted: false });
  session(database, 's-1', 'w-1', 'Refatorar o parser');
  session(database, 's-2', 'w-1', 'Documentação');
  session(database, 's-3', 'w-2', 'Notas do café');
  session(database, 's-gone', 'w-apagado', 'Órfã');

  event(database, 's-1', 100, { kind: 'user_message', text: 'Quero uma sessão nova para o parser' });
  event(database, 's-1', 110, { kind: 'agent_thought_chunk', text: 'pensando no parser de linhas' });
  event(database, 's-1', 115, { kind: 'tool_call', toolCallId: 't1', title: 'Lendo tools', content: [], locations: [] });
  event(database, 's-1', 118, { kind: 'terminal_output', data: 'parser em terminal' });
  event(database, 's-1', 120, { kind: 'agent_message_chunk', text: 'Vou olhar o parser agora' });
  event(database, 's-2', 200, { kind: 'user_message', text: 'Atualiza o README do parser' });
  event(database, 's-3', 150, { kind: 'agent_message_chunk', text: 'Sessão de café em Coimbra' });
  event(database, 's-gone', 300, { kind: 'user_message', text: 'parser perdido' });
}

function openSeeded(): Database.Database {
  db = openDatabase(join(dir, 'data.db'));
  seed(db);
  return db;
}

describe('migration 10: message index', () => {

  it('indexes existing user and agent messages when opening a version 9 database', async () => {
    db = new Database(join(dir, 'data.db'));
    db.exec(await readFile(new URL('./fixtures/database-v9.sql', import.meta.url), 'utf8'));
    db.exec(`
      INSERT INTO workspaces (id, name, path, created_at) VALUES ('w-1', 'app', 'C:\\app', 1);
      INSERT INTO sessions (id, workspace_id, agent, title, status, created_at, updated_at)
        VALUES ('s-1', 'w-1', 'omp', 'User history', 'idle', 1, 1),
               ('s-2', 'w-1', 'omp', 'Agent history', 'idle', 1, 1);
      INSERT INTO events (session_id, ts, kind, payload)
        VALUES ('s-1', 100, 'user_message', '{"kind":"user_message","text":"Review the parser"}'),
               ('s-2', 200, 'agent_message_chunk', '{"kind":"agent_message_chunk","text":"The parser needs a boundary check"}');
    `);
    db.close();
    db = undefined;

    db = openDatabase(join(dir, 'data.db'));
    const found = searchSessionMessages(db, { query: 'parser', limit: 20 }).map((row) => row.sessionId);
    expect(found).toEqual(['s-2', 's-1']);
  });

  it('the DELETE trigger on events removes the message from the index (forgetting a session)', () => {
    const database = openSeeded();
    deleteSessionRows(database, 's-2');
    expect(searchSessionMessages(database, { query: 'README', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: 'parser', limit: 20 }).map((row) => row.sessionId)).toEqual([
      's-1',
    ]);
  });
});

describe('searchSessionMessages', () => {
  it('finds words in user and agent messages, but not in thoughts, tool calls or terminal output', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: 'pensando', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: 'tools', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: 'terminal', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: 'Coimbra', limit: 20 }).map((row) => row.sessionId)).toEqual([
      's-3',
    ]);
  });

  it('ignores accents and case: "sessao" finds "Sessão", "CAFE" finds "café"', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: 'sessao', limit: 20 }).map((row) => row.sessionId)).toEqual([
      's-3',
      's-1',
    ]);
    expect(searchSessionMessages(database, { query: 'CAFE', limit: 20 }).map((row) => row.sessionId)).toEqual(['s-3']);
  });

  it('matches the start of a word ("parse" finds "parser")', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: 'parse', limit: 20 }).map((row) => row.sessionId)).toEqual([
      's-2',
      's-1',
    ]);
  });

  it('returns one row per session: its newest matching message, that message snippet, and the title', () => {
    const database = openSeeded();
    const rows = searchSessionMessages(database, { query: 'parser', limit: 20 });
    expect(rows.filter((row) => row.sessionId === 's-1')).toHaveLength(1);
    const first = rows.find((row) => row.sessionId === 's-1');
    expect(first).toMatchObject({ sessionId: 's-1', workspaceId: 'w-1', title: 'Refatorar o parser', matchedAt: 120 });
    expect(first?.snippet).toContain('parser agora');
  });

  it('requires every word to be in the same message', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: 'quero parser', limit: 20 }).map((row) => row.sessionId)).toEqual([
      's-1',
    ]);
    expect(searchSessionMessages(database, { query: 'quero README', limit: 20 })).toEqual([]);
  });

  it('leaves out sessions of a deleted workspace, and workspaceId narrows the search to the given workspace', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: 'perdido', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: 'parser', limit: 20, workspaceId: 'w-2' })).toEqual([]);
    expect(
      searchSessionMessages(database, { query: 'parser', limit: 20, workspaceId: 'w-1' }).map((row) => row.sessionId),
    ).toEqual(['s-2', 's-1']);
  });

  it('honours the limit, returning the most recent sessions first', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: 'parser', limit: 1 }).map((row) => row.sessionId)).toEqual(['s-2']);
    expect(searchSessionMessages(database, { query: 'parser', limit: 2 }).map((row) => row.sessionId)).toEqual([
      's-2',
      's-1',
    ]);
  });

  it('treats punctuation, quotes and search operators as plain text, without breaking the query', () => {
    const database = openSeeded();
    expect(searchSessionMessages(database, { query: '!!', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: '"', limit: 20 })).toEqual([]);
    expect(searchSessionMessages(database, { query: 'parser"', limit: 20 }).map((row) => row.sessionId)).toEqual([
      's-2',
      's-1',
    ]);
    expect(searchSessionMessages(database, { query: 'NOT parser OR', limit: 20 })).toEqual([]);
  });
});

describe('GET /api/sessions/search', () => {
  const env = setupDaemonTests();

  it('requires the device Bearer token', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({ method: 'GET', url: '/api/sessions/search?q=parser' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects q outside 2 to 100 characters and limit outside 1 to 50 with invalid_request', async () => {
    const daemon = await env.start();
    const headers = await authHeader(daemon);
    for (const url of [
      '/api/sessions/search',
      '/api/sessions/search?q=a',
      '/api/sessions/search?q=%20%20',
      `/api/sessions/search?q=${'a'.repeat(101)}`,
      '/api/sessions/search?q=ab&limit=0',
      '/api/sessions/search?q=ab&limit=51',
      '/api/sessions/search?q=ab&limit=muitos',
      '/api/sessions/search?q=ab&workspaceId=',
    ]) {
      const res = await daemon.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    }
  });

  it('answers { results } in the shared format, leaves out deleted workspaces, and accepts workspaceId', async () => {
    const daemon = await env.start();
    seed(daemon.db);
    const headers = await authHeader(daemon);

    const all = await daemon.app.inject({ method: 'GET', url: '/api/sessions/search?q=parser', headers });
    expect(all.statusCode).toBe(200);
    const body = SessionSearchResponseSchema.parse(all.json<unknown>());
    expect(body.results.map((row) => row.sessionId)).toEqual(['s-2', 's-1']);
    expect(body.results[0]).toEqual({
      sessionId: 's-2',
      workspaceId: 'w-1',
      title: 'Documentação',
      snippet: expect.any(String),
      matchedAt: 200,
    });

    const one = await daemon.app.inject({
      method: 'GET',
      url: '/api/sessions/search?q=parser&limit=1&workspaceId=w-1',
      headers,
    });
    expect(SessionSearchResponseSchema.parse(one.json<unknown>()).results.map((row) => row.sessionId)).toEqual(['s-2']);
  });
});
