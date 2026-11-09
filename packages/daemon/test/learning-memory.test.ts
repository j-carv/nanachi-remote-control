import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { LearningMemory } from '../src/learning-memory.js';
import { insertEvent, insertSession, insertWorkspace } from '../src/repository.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database;
let memory: LearningMemory;
let evidence: number;
let turn: number;
const lesson = { kind: 'skill' as const, title: 'Workspace tests', content: 'Run the workspace test command before sharing changes.', evidenceSeqs: [] as number[] };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-learning-memory-'));
  db = openDatabase(join(dir, 'data.db'));
  memory = new LearningMemory(db);
  insertWorkspace(db, { id: 'w1', name: 'One', path: join(dir, 'one'), createdAt: 1, muted: false });
  insertWorkspace(db, { id: 'w2', name: 'Two', path: join(dir, 'two'), createdAt: 1, muted: false });
  for (const [id, workspaceId] of [['s1', 'w1'], ['s2', 'w2']] as const) insertSession(db, { id, workspaceId, agent: 'fake', title: 'Synthetic learning', status: 'idle', createdAt: 1 });
  evidence = insertEvent(db, { sessionId: 's1', ts: 1, kind: 'user_message', payload: JSON.stringify({ text: lesson.content }) });
  turn = insertEvent(db, { sessionId: 's1', ts: 2, kind: 'turn_end', payload: JSON.stringify({ stopReason: 'end_turn' }) });
});
afterEach(async () => { db.close(); await removeTempDir(dir); });
function review(approvalRequired = false, entries = [{ ...lesson, evidenceSeqs: [evidence] }], sourceTurnSeq = turn) {
  return memory.applyReview({ workspaceId: 'w1', sessionId: 's1', sourceTurnSeq, approvalRequired, result: { summary: 'A reusable workspace procedure', entries } });
}

describe('workspace-local SQLite learning memory', () => {
  it('persists real FTS retrieval and denies cross-workspace reads, edits, forgetting and review actions', () => {
    const applied = review();
    const entry = memory.list('w1', { query: 'workspace test', status: 'active' })[0];
    expect(entry).toMatchObject({ kind: 'skill', sourceSessionId: 's1', evidenceSeqs: [evidence], reviewId: applied?.reviewId });
    expect(entry).toBeDefined();
    if (entry === undefined || applied === null) throw new Error('Missing persisted review');
    expect(memory.list('w2', { query: 'workspace' })).toEqual([]);
    expect(memory.read('w2', entry.id)).toBeUndefined();
    expect(() => memory.save('w2', { ...lesson, id: entry.id, expectedVersion: entry.version, content: 'Crossed edit' })).toThrow();
    expect(() => memory.forget('w2', entry.id, entry.version)).toThrow();
    expect(() => memory.manageReview('w2', applied.reviewId, 'revert')).toThrow();
    db.close();
    db = openDatabase(join(dir, 'data.db'));
    memory = new LearningMemory(db);
    expect(memory.list('w1', { query: 'workspace' })).toHaveLength(1);
    expect(memory.list('w1', { query: '" OR * NEAR(' })).toEqual([]);
    expect(() => memory.list('w1', { query: 'x'.repeat(1001) })).toThrow();
  });

  it('uses optimistic versions across separate SQLite connections without losing the winning edit', () => {
    const original = memory.save('w1', lesson);
    const otherDb = openDatabase(join(dir, 'data.db'));
    try {
      const other = new LearningMemory(otherDb);
      const stale = other.read('w1', original.id);
      const winner = memory.save('w1', { ...lesson, id: original.id, expectedVersion: original.version, content: 'The first editor wins.' });
      if (stale === undefined) throw new Error('Missing stale snapshot');
      expect(other.read('w1', original.id)).toMatchObject({ content: winner.content, version: 2 });
      expect(() => other.save('w1', { ...lesson, id: original.id, expectedVersion: stale.version, content: 'The stale editor must not overwrite.' })).toThrow();
    } finally { otherDb.close(); }
  });

  it('authenticates every evidence sequence and rolls back the whole batch on invalid evidence', () => {
    const foreign = insertEvent(db, { sessionId: 's2', ts: 3, kind: 'user_message', payload: '{"text":"foreign evidence"}' });
    const notice = insertEvent(db, { sessionId: 's1', ts: 3, kind: 'learning', payload: '{}' });
    const future = insertEvent(db, { sessionId: 's1', ts: 4, kind: 'agent_message_chunk', payload: '{"text":"future evidence"}' });
    for (const seqs of [[], [foreign], [notice], [future], [999999]]) {
      expect(() => review(false, [{ ...lesson, evidenceSeqs: [evidence] }, { ...lesson, content: 'Invalid second item', evidenceSeqs: seqs }])).toThrow();
      expect(memory.list('w1')).toEqual([]);
    }
    expect(() => memory.applyReview({ workspaceId: 'w2', sessionId: 's1', sourceTurnSeq: turn, approvalRequired: false, result: { summary: 'Wrong workspace', entries: [{ ...lesson, evidenceSeqs: [evidence] }] } })).toThrow();
  });

  it('preserves active content while pending edits await approval, then reverses the approved edit', () => {
    const original = memory.save('w1', lesson);
    const pending = memory.applyReview({ workspaceId: 'w1', sessionId: 's1', sourceTurnSeq: turn, approvalRequired: true, result: { summary: 'Improve procedure', entries: [{ ...lesson, id: original.id, expectedVersion: 1, content: 'Run focused tests before all workspace checks.', evidenceSeqs: [evidence] }] } });
    if (pending === null) throw new Error('Missing pending review');
    expect(memory.read('w1', original.id)?.content).toBe(lesson.content);
    expect(memory.list('w1', { status: 'pending' })).toHaveLength(1);
    expect(memory.manageReview('w1', pending.reviewId, 'approve')).toMatchObject({ status: 'applied', entryIds: [original.id] });
    expect(memory.list('w1', { status: 'pending' })).toEqual([]);
    expect(memory.read('w1', original.id)).toMatchObject({ content: 'Run focused tests before all workspace checks.', version: 2 });
    expect(() => memory.manageReview('w1', pending.reviewId, 'approve')).toThrow();
    expect(memory.manageReview('w1', pending.reviewId, 'revert')).toMatchObject({ status: 'reverted' });
    expect(memory.read('w1', original.id)).toMatchObject({ content: lesson.content, version: 3 });
    expect(() => memory.manageReview('w1', pending.reviewId, 'revert')).toThrow();
  });

  it('rejects pending proposals with a confirmed rejected notice and refuses later approval', () => {
    const pending = review(true);
    if (pending === null) throw new Error('Missing pending review');
    expect(memory.manageReview('w1', pending.reviewId, 'reject')).toMatchObject({ status: 'rejected', entryIds: [], memoryCount: 0, skillCount: 0 });
    expect(memory.list('w1')).toEqual([]);
    expect(() => memory.manageReview('w1', pending.reviewId, 'approve')).toThrow();
  });

  it('atomically refuses reversal when any entry was edited later', () => {
    const applied = review(false, [{ ...lesson, evidenceSeqs: [evidence] }, { ...lesson, title: 'Second', content: 'A distinct second lesson.', evidenceSeqs: [evidence] }]);
    if (applied === null) throw new Error('Missing applied review');
    const edited = memory.list('w1')[0];
    if (edited === undefined) throw new Error('Missing entry');
    memory.save('w1', { ...lesson, id: edited.id, expectedVersion: edited.version, content: 'An owner edited this after learning.' });
    expect(() => memory.manageReview('w1', applied.reviewId, 'revert')).toThrow();
    expect(memory.list('w1', { status: 'active' })).toHaveLength(2);
    expect(memory.read('w1', edited.id)?.content).toBe('An owner edited this after learning.');
  });

  it('deduplicates reviews and tombstones forgotten lessons against reimport from the same evidence', () => {
    const applied = review();
    expect(review()).toBeNull();
    const entry = memory.list('w1')[0];
    if (entry === undefined || applied === null) throw new Error('Missing applied review');
    memory.forget('w1', entry.id, entry.version);
    const nextTurn = insertEvent(db, { sessionId: 's1', ts: 5, kind: 'turn_end', payload: '{"stopReason":"end_turn"}' });
    expect(review(false, [{ ...lesson, title: 'Renamed lesson', content: lesson.content.toUpperCase(), evidenceSeqs: [evidence] }], nextTurn)).toBeNull();
    expect(memory.list('w1')).toEqual([]);
    expect(memory.read('w1', entry.id)).toMatchObject({ status: 'deleted', version: 2 });
    expect(() => memory.save('w1', { ...lesson, evidenceSeqs: [evidence] }, { sessionId: 's1' })).toThrow();
    const snapshots = db.prepare<[], { snapshot: string }>('SELECT snapshot FROM learning_history ORDER BY seq').all();
    expect(snapshots.map((row) => JSON.parse(row.snapshot).status)).toEqual(['active', 'deleted']);
  });

  it('refuses approval after a later owner edit without consuming the pending proposal', () => {
    const original = memory.save('w1', lesson);
    const pending = memory.applyReview({ workspaceId: 'w1', sessionId: 's1', sourceTurnSeq: turn, approvalRequired: true, result: { summary: 'Proposed edit', entries: [{ ...lesson, id: original.id, expectedVersion: original.version, content: 'Proposed updated procedure.', evidenceSeqs: [evidence] }] } });
    if (pending === null) throw new Error('Missing pending review');
    memory.save('w1', { ...lesson, id: original.id, expectedVersion: original.version, content: 'Owner version after proposal.' });
    expect(() => memory.manageReview('w1', pending.reviewId, 'approve')).toThrow();
    expect(memory.list('w1', { status: 'pending' })).toHaveLength(1);
    expect(memory.read('w1', original.id)?.content).toBe('Owner version after proposal.');
    expect(memory.manageReview('w1', pending.reviewId, 'reject')?.status).toBe('rejected');
  });

  it('bounds result counts and rejects recognizable credentials without storing them', () => {
    expect(() => memory.save('w1', { ...lesson, content: 'api_key=sk-testcredential012345678901234567890' })).toThrow();
    expect(memory.list('w1')).toEqual([]);
    for (let index = 0; index < 45; index++) memory.save('w1', { ...lesson, title: `Lesson ${index}`, content: `Distinct learning record ${index}` });
    expect(memory.list('w1')).toHaveLength(40);
    expect(memory.list('w1', { query: 'Distinct' })).toHaveLength(40);
  });

  it('rolls back entries and ledger when SQLite cannot persist history', () => {
    db.exec("CREATE TRIGGER reject_learning_history BEFORE INSERT ON learning_history BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    expect(() => review()).toThrow();
    expect(memory.list('w1')).toEqual([]);
    expect(db.prepare('SELECT * FROM learning_reviews').all()).toEqual([]);
  });
});
