import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { LearningMemory } from '../src/learning-memory.js';
import { deleteSessionRows, deleteWorkspace, insertEvent, insertSession, insertWorkspace } from '../src/repository.js';
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

describe('installation-global SQLite learning memory', () => {
  it('persists real FTS retrieval across projects while keeping source provenance', () => {
    const applied = review();
    const entry = memory.list({ query: 'workspace test', status: 'active' })[0];
    expect(entry).toMatchObject({ kind: 'skill', workspaceId: 'w1', sourceWorkspace: { id: 'w1', name: 'One', path: join(dir, 'one') }, sourceSessionId: 's1', evidenceSeqs: [evidence], reviewId: applied?.reviewId });
    expect(entry).toBeDefined();
    if (entry === undefined || applied === null) throw new Error('Missing persisted review');
    expect(memory.list({ query: 'workspace' })).toEqual([entry]);
    expect(memory.read(entry.id)).toEqual(entry);
    const otherEvidence = insertEvent(db, { sessionId: 's2', ts: 3, kind: 'user_message', payload: JSON.stringify({ text: lesson.content }) });
    expect(memory.save({ ...lesson, evidenceSeqs: [otherEvidence] }, { workspaceId: 'w2', sessionId: 's2' })).toEqual(entry);
    db.close();
    db = openDatabase(join(dir, 'data.db'));
    memory = new LearningMemory(db);
    expect(memory.list({ query: 'workspace' })).toHaveLength(1);
    expect(memory.list({ query: '" OR * NEAR(' })).toEqual([]);
    expect(() => memory.list({ query: 'x'.repeat(1001) })).toThrow();
  });

  it('uses global versions across separate SQLite connections and refuses stale cross-project edits and reverts', () => {
    const original = memory.save({ ...lesson, evidenceSeqs: [evidence] }, { workspaceId: 'w1', sessionId: 's1' });
    const otherEvidence = insertEvent(db, { sessionId: 's2', ts: 3, kind: 'user_message', payload: '{"text":"The second project editor wins."}' });
    const otherDb = openDatabase(join(dir, 'data.db'));
    try {
      const other = new LearningMemory(otherDb);
      const stale = other.read(original.id);
      const winner = memory.save({ ...lesson, id: original.id, expectedVersion: original.version, content: 'The second project editor wins.', evidenceSeqs: [otherEvidence] }, { workspaceId: 'w2', sessionId: 's2' });
      if (stale === undefined) throw new Error('Missing stale snapshot');
      expect(other.read(original.id)).toMatchObject({ content: winner.content, version: 2, workspaceId: 'w2', sourceWorkspace: { id: 'w2' } });
      expect(() => other.save({ ...lesson, id: original.id, expectedVersion: stale.version, content: 'The stale editor must not overwrite.', evidenceSeqs: [evidence] }, { workspaceId: 'w1', sessionId: 's1' })).toThrow();
      if (original.reviewId === null || winner.reviewId === null) throw new Error('Missing global reviews');
      expect(() => other.manageReview(original.reviewId ?? '', 'revert')).toThrow();
      expect(memory.read(original.id)?.content).toBe(winner.content);
      expect(other.manageReview(winner.reviewId, 'revert')).toMatchObject({ status: 'reverted' });
      expect(memory.read(original.id)).toMatchObject({ content: original.content, version: 3, workspaceId: 'w1' });
    } finally { otherDb.close(); }
  });

  it('records actual agent update origin globally, retains it on owner edits, and restores prior origin on revert', () => {
    const original = memory.save({ ...lesson, evidenceSeqs: [evidence] }, { workspaceId: 'w1', sessionId: 's1' });
    const otherEvidence = insertEvent(db, { sessionId: 's2', ts: 3, kind: 'user_message', payload: '{"text":"Use the shared focused workflow."}' });
    const updated = memory.save({ ...lesson, id: original.id, expectedVersion: original.version, content: 'Use the shared focused workflow.', evidenceSeqs: [otherEvidence] }, { workspaceId: 'w2', sessionId: 's2' });
    expect(memory.read(original.id)).toMatchObject({ version: 2, workspaceId: 'w2', sourceWorkspace: { id: 'w2', name: 'Two' }, sourceSessionId: 's2', evidenceSeqs: [otherEvidence] });
    if (updated.reviewId === null) throw new Error('Missing cross-project review');
    memory.manageReview(updated.reviewId, 'revert');
    expect(memory.read(original.id)).toMatchObject({ content: original.content, version: 3, workspaceId: 'w1', sourceWorkspace: { id: 'w1' } });
    const owned = memory.save({ ...lesson, id: original.id, expectedVersion: 3, content: 'Owner clarified the procedure.' });
    expect(owned).toMatchObject({ workspaceId: 'w1', sourceWorkspace: { id: 'w1' }, version: 4 });
    expect(() => memory.manageReview(updated.reviewId ?? '', 'revert')).toThrow();
  });

  it.each(['approve', 'reject', 'revert'] as const)('retains global memories and permits %s after source workspace and session deletion', (action) => {
    const notice = review(action !== 'revert');
    const entry = memory.list()[0];
    if (notice === null || entry === undefined) throw new Error('Missing retained review');
    deleteWorkspace(db, 'w1', 10);
    deleteSessionRows(db, 's1');
    expect(memory.read(entry.id)).toMatchObject({ workspaceId: 'w1', sourceWorkspace: null, sourceSessionId: 's1', version: entry.version });
    expect(memory.manageReview(notice.reviewId, action)).toMatchObject({ status: action === 'approve' ? 'applied' : action === 'reject' ? 'rejected' : 'reverted' });
    if (action === 'approve') {
      expect(memory.list({ status: 'active' })).toMatchObject([{ workspaceId: 'w1', sourceWorkspace: null }]);
      expect(memory.manageReview(notice.reviewId, 'revert')).toMatchObject({ status: 'reverted' });
    }
    expect(memory.list()).toEqual([]);
    const otherEvidence = insertEvent(db, { sessionId: 's2', ts: 11, kind: 'user_message', payload: JSON.stringify({ text: lesson.content }) });
    expect(() => memory.save({ ...lesson, evidenceSeqs: [otherEvidence] }, { workspaceId: 'w2', sessionId: 's2' })).toThrow();
  });

  it('creates and forgets owner memories without a workspace and blocks resurrection from another project', () => {
    const entry = memory.save(lesson);
    expect(entry).toMatchObject({ workspaceId: null, sourceWorkspace: null, sourceSessionId: null });
    memory.forget(entry.id, entry.version);
    expect(memory.read(entry.id)).toMatchObject({ status: 'deleted', workspaceId: null, version: 2 });
    expect(() => memory.save({ ...lesson, evidenceSeqs: [evidence] }, { workspaceId: 'w1', sessionId: 's1' })).toThrow();
    const otherEvidence = insertEvent(db, { sessionId: 's2', ts: 3, kind: 'user_message', payload: JSON.stringify({ text: lesson.content }) });
    expect(() => memory.save({ ...lesson, evidenceSeqs: [otherEvidence] }, { workspaceId: 'w2', sessionId: 's2' })).toThrow();
  });

  it('authenticates every evidence sequence and rolls back the whole batch on invalid evidence', () => {
    const foreign = insertEvent(db, { sessionId: 's2', ts: 3, kind: 'user_message', payload: '{"text":"foreign evidence"}' });
    const notice = insertEvent(db, { sessionId: 's1', ts: 3, kind: 'learning', payload: '{}' });
    const future = insertEvent(db, { sessionId: 's1', ts: 4, kind: 'agent_message_chunk', payload: '{"text":"future evidence"}' });
    for (const seqs of [[], [foreign], [notice], [future], [999999]]) {
      expect(() => review(false, [{ ...lesson, evidenceSeqs: [evidence] }, { ...lesson, content: 'Invalid second item', evidenceSeqs: seqs }])).toThrow();
      expect(memory.list()).toEqual([]);
    }
    expect(() => memory.applyReview({ workspaceId: 'w2', sessionId: 's1', sourceTurnSeq: turn, approvalRequired: false, result: { summary: 'Wrong workspace', entries: [{ ...lesson, evidenceSeqs: [evidence] }] } })).toThrow();
  });

  it('preserves active content while pending edits await approval, then reverses the approved edit', () => {
    const original = memory.save(lesson);
    const pending = memory.applyReview({ workspaceId: 'w1', sessionId: 's1', sourceTurnSeq: turn, approvalRequired: true, result: { summary: 'Improve procedure', entries: [{ ...lesson, id: original.id, expectedVersion: 1, content: 'Run focused tests before all workspace checks.', evidenceSeqs: [evidence] }] } });
    if (pending === null) throw new Error('Missing pending review');
    expect(memory.read(original.id)?.content).toBe(lesson.content);
    expect(memory.list({ status: 'pending' })).toHaveLength(1);
    expect(memory.manageReview(pending.reviewId, 'approve')).toMatchObject({ status: 'applied', entryIds: [original.id] });
    expect(memory.list({ status: 'pending' })).toEqual([]);
    expect(memory.read(original.id)).toMatchObject({ content: 'Run focused tests before all workspace checks.', version: 2 });
    expect(() => memory.manageReview(pending.reviewId, 'approve')).toThrow();
    expect(memory.manageReview(pending.reviewId, 'revert')).toMatchObject({ status: 'reverted' });
    expect(memory.read(original.id)).toMatchObject({ content: lesson.content, version: 3 });
    expect(() => memory.manageReview(pending.reviewId, 'revert')).toThrow();
  });

  it('rejects pending proposals with a confirmed rejected notice and refuses later approval', () => {
    const pending = review(true);
    if (pending === null) throw new Error('Missing pending review');
    expect(memory.manageReview(pending.reviewId, 'reject')).toMatchObject({ status: 'rejected', entryIds: [], memoryCount: 0, skillCount: 0 });
    expect(memory.list()).toEqual([]);
    expect(() => memory.manageReview(pending.reviewId, 'approve')).toThrow();
  });

  it('atomically refuses reversal when any entry was edited later', () => {
    const applied = review(false, [{ ...lesson, evidenceSeqs: [evidence] }, { ...lesson, title: 'Second', content: 'A distinct second lesson.', evidenceSeqs: [evidence] }]);
    if (applied === null) throw new Error('Missing applied review');
    const edited = memory.list()[0];
    if (edited === undefined) throw new Error('Missing entry');
    memory.save({ ...lesson, id: edited.id, expectedVersion: edited.version, content: 'An owner edited this after learning.' });
    expect(() => memory.manageReview(applied.reviewId, 'revert')).toThrow();
    expect(memory.list({ status: 'active' })).toHaveLength(2);
    expect(memory.read(edited.id)?.content).toBe('An owner edited this after learning.');
  });

  it('deduplicates reviews and tombstones forgotten lessons against reimport from any workspace', () => {
    const applied = review();
    expect(review()).toBeNull();
    const entry = memory.list()[0];
    if (entry === undefined || applied === null) throw new Error('Missing applied review');
    memory.forget(entry.id, entry.version);
    const nextTurn = insertEvent(db, { sessionId: 's1', ts: 5, kind: 'turn_end', payload: '{"stopReason":"end_turn"}' });
    expect(review(false, [{ ...lesson, title: 'Renamed lesson', content: lesson.content.toUpperCase(), evidenceSeqs: [evidence] }], nextTurn)).toBeNull();
    expect(memory.list()).toEqual([]);
    expect(memory.read(entry.id)).toMatchObject({ status: 'deleted', version: 2 });
    expect(() => memory.save({ ...lesson, evidenceSeqs: [evidence] }, { workspaceId: 'w1', sessionId: 's1' })).toThrow();
    const snapshots = db.prepare<[], { snapshot: string }>('SELECT snapshot FROM learning_history ORDER BY seq').all();
    expect(snapshots.map((row) => JSON.parse(row.snapshot).status)).toEqual(['active', 'deleted']);
  });

  it('refuses approval after a later owner edit without consuming the pending proposal', () => {
    const original = memory.save(lesson);
    const pending = memory.applyReview({ workspaceId: 'w1', sessionId: 's1', sourceTurnSeq: turn, approvalRequired: true, result: { summary: 'Proposed edit', entries: [{ ...lesson, id: original.id, expectedVersion: original.version, content: 'Proposed updated procedure.', evidenceSeqs: [evidence] }] } });
    if (pending === null) throw new Error('Missing pending review');
    memory.save({ ...lesson, id: original.id, expectedVersion: original.version, content: 'Owner version after proposal.' });
    expect(() => memory.manageReview(pending.reviewId, 'approve')).toThrow();
    expect(memory.list({ status: 'pending' })).toHaveLength(1);
    expect(memory.read(original.id)?.content).toBe('Owner version after proposal.');
    expect(memory.manageReview(pending.reviewId, 'reject')?.status).toBe('rejected');
  });

  it('bounds result counts and rejects recognizable credentials without storing them', () => {
    expect(() => memory.save({ ...lesson, content: 'api_key=sk-testcredential012345678901234567890' })).toThrow();
    expect(memory.list()).toEqual([]);
    for (let index = 0; index < 45; index++) memory.save({ ...lesson, title: `Lesson ${index}`, content: `Distinct learning record ${index}` });
    expect(memory.list()).toHaveLength(40);
    expect(memory.list({ query: 'Distinct' })).toHaveLength(40);
  });

  it('rolls back entries and ledger when SQLite cannot persist history', () => {
    db.exec("CREATE TRIGGER reject_learning_history BEFORE INSERT ON learning_history BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    expect(() => review()).toThrow();
    expect(memory.list()).toEqual([]);
    expect(db.prepare('SELECT * FROM learning_reviews').all()).toEqual([]);
  });
});
