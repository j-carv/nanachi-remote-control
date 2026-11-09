import { createHash, randomUUID } from 'node:crypto';
import {
  LearningReviewResultSchema, MemoryEntrySchema, MemoryWriteSchema,
  type LearningNotice, type LearningReviewResult, type MemoryEntry, type MemoryWrite,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { ApiError } from './api-error.js';
import { containsLearningSecret } from './learning-redaction.js';

type Source = { sessionId: string; evidenceSeqs?: number[]; pending?: boolean };
type ReviewRow = { id: string; workspace_id: string; session_id: string; source_turn_seq: number; summary: string; status: 'pending' | 'applied' | 'rejected' | 'reverted' };
type ChangeRow = { proposal_id: string; target_id: string; before_json: string | null; proposal_json: string };
type AppliedRow = { entry_id: string; before_json: string | null; after_version: number };
type EntryRow = { id: string; workspace_id: string; kind: 'memory' | 'skill'; title: string; content: string; status: 'active' | 'pending' | 'deleted'; version: number; source_session_id: string | null; evidence_seqs: string; review_id: string | null; created_at: number; updated_at: number };
const EVIDENCE_KINDS: Readonly<Record<string, true>> = { user_message: true, agent_message_chunk: true, tool_call: true, tool_call_update: true };
const MAX_RESULTS = 40;
const hashContent = (content: string): string => createHash('sha256').update(content.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()).digest('hex');
const conflict = (): never => { throw new ApiError(409, 'memory_conflict', 'Memory changed since it was read'); };
const invalid = (): never => { throw new ApiError(400, 'invalid_request', 'Invalid learning memory request'); };
function entryOf(row: EntryRow): MemoryEntry {
  return MemoryEntrySchema.parse({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, title: row.title, content: row.content, status: row.status, version: row.version, sourceSessionId: row.source_session_id, evidenceSeqs: JSON.parse(row.evidence_seqs), reviewId: row.review_id, createdAt: row.created_at, updatedAt: row.updated_at });
}

/** Workspace-local retrieval only. Every mutation and its immutable snapshot share a transaction. */
export class LearningMemory {
  constructor(private readonly db: Database.Database) {}

  list(workspaceId: string, options: { query?: string; kind?: 'memory' | 'skill'; status?: 'active' | 'pending' | 'deleted' } = {}): MemoryEntry[] {
    const { query, kind, status } = options;
    if (query !== undefined && (typeof query !== 'string' || query.length > 1000)) invalid();
    if (kind !== undefined && kind !== 'memory' && kind !== 'skill') invalid();
    if (status !== undefined && !['active', 'pending', 'deleted'].includes(status)) invalid();
    const terms = (query ?? '').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
    if (query?.trim() && terms.length === 0) return [];
    const predicates = ['e.workspace_id = ?'];
    const params: Array<string | number> = [workspaceId];
    if (kind !== undefined) { predicates.push('e.kind = ?'); params.push(kind); }
    if (status !== undefined) { predicates.push('e.status = ?'); params.push(status); }
    else predicates.push("e.status IN ('active', 'pending')");
    if (terms.length > 0) { predicates.push('learning_search MATCH ?'); params.push(terms.map((term) => `"${term}"`).join(' AND ')); }
    params.push(MAX_RESULTS);
    return this.db.prepare<Array<string | number>, EntryRow>(`SELECT e.* FROM learning_entries e ${terms.length > 0 ? 'JOIN learning_search ON learning_search.rowid = e.rowid' : ''} WHERE ${predicates.join(' AND ')} ORDER BY ${terms.length > 0 ? 'bm25(learning_search),' : ''} e.updated_at DESC, e.id LIMIT ?`).all(...params).map(entryOf);
  }

  read(workspaceId: string, id: string): MemoryEntry | undefined {
    const row = this.db.prepare<[string, string], EntryRow>('SELECT * FROM learning_entries WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
    return row === undefined ? undefined : entryOf(row);
  }

  save(workspaceId: string, input: MemoryWrite, source?: Source): MemoryEntry {
    return this.db.transaction(() => {
      this.requireWorkspace(workspaceId);
      const parsed = MemoryWriteSchema.safeParse(input);
      if (!parsed.success) return invalid();
      const write = parsed.data;
      if (containsLearningSecret(`${write.title}\n${write.content}`)) invalid();
      const evidence = [...new Set(source?.evidenceSeqs ?? write.evidenceSeqs)].sort((a, b) => a - b);
      if (source !== undefined) this.requireEvidence(workspaceId, source.sessionId, evidence);
      else if (evidence.length > 0) invalid();
      const before = write.id === undefined ? undefined : this.requireEntry(workspaceId, write.id);
      if (before !== undefined && (before.status === 'deleted' || before.version !== write.expectedVersion)) conflict();
      if (before === undefined && write.expectedVersion !== undefined) invalid();
      if (before !== undefined && before.kind !== write.kind) invalid();
      if (source !== undefined && this.tombstoned(workspaceId, write)) conflict();
      const duplicate = this.duplicate(workspaceId, write, before?.id);
      if (duplicate !== undefined) {
        if (before !== undefined) conflict();
        return duplicate;
      }
      if (before !== undefined && before.title === write.title && before.content === write.content) return before;
      if (source !== undefined) {
        if (before !== undefined && before.status !== 'active') conflict();
        const reviewId = randomUUID();
        const now = Date.now();
        const proposal: MemoryEntry = { id: source.pending ? randomUUID() : before?.id ?? randomUUID(), workspaceId, kind: write.kind, title: write.title, content: write.content, status: source.pending ? 'pending' : 'active', version: source.pending ? 1 : (before?.version ?? 0) + 1, sourceSessionId: source.sessionId, evidenceSeqs: evidence, reviewId, createdAt: source.pending ? now : before?.createdAt ?? now, updatedAt: now };
        this.db.prepare('INSERT INTO learning_reviews (id, workspace_id, session_id, source_turn_seq, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(reviewId, workspaceId, source.sessionId, Math.max(...evidence), 'Agent-proposed memory change', source.pending ? 'pending' : 'applied', now);
        this.persist(proposal, source.pending ? 'tool_pending' : 'tool_apply');
        this.db.prepare('INSERT INTO learning_review_changes (review_id, proposal_id, target_id, before_json, proposal_json) VALUES (?, ?, ?, ?, ?)').run(reviewId, proposal.id, before?.id ?? proposal.id, before === undefined ? null : JSON.stringify(before), JSON.stringify(proposal));
        if (!source.pending) this.recordApplied(reviewId, proposal, before);
        return proposal;
      }
      const now = Date.now();
      const entry: MemoryEntry = { id: before?.id ?? randomUUID(), workspaceId, kind: write.kind, title: write.title, content: write.content, status: 'active', version: (before?.version ?? 0) + 1, sourceSessionId: null, evidenceSeqs: evidence, reviewId: null, createdAt: before?.createdAt ?? now, updatedAt: now };
      this.persist(entry, 'save');
      return entry;
    }).immediate();
  }

  forget(workspaceId: string, id: string, expectedVersion: number): void {
    this.db.transaction(() => {
      const entry = this.requireEntry(workspaceId, id);
      if (entry.version !== expectedVersion || entry.status === 'deleted') conflict();
      this.remove(entry, 'forget', true);
    }).immediate();
  }

  applyReview(input: { workspaceId: string; sessionId: string; sourceTurnSeq: number; result: LearningReviewResult; approvalRequired: boolean }): LearningNotice | null {
    return this.db.transaction(() => {
      const { workspaceId, sessionId, sourceTurnSeq, approvalRequired } = input;
      this.requireWorkspace(workspaceId);
      const parsed = LearningReviewResultSchema.safeParse(input.result);
      if (!parsed.success || !Number.isSafeInteger(sourceTurnSeq) || sourceTurnSeq < 1) return invalid();
      if (containsLearningSecret(parsed.data.summary)) invalid();
      this.requireSource(workspaceId, sessionId);
      const turn = this.db.prepare<[string, number], { kind: string }>('SELECT kind FROM events WHERE session_id = ? AND seq = ?').get(sessionId, sourceTurnSeq);
      if (turn?.kind !== 'turn_end') invalid();
      if (this.db.prepare('SELECT 1 FROM learning_reviews WHERE session_id = ? AND source_turn_seq = ?').get(sessionId, sourceTurnSeq) !== undefined) return null;
      const changes: Array<{ before: MemoryEntry | undefined; proposal: MemoryEntry }> = [];
      const reviewId = randomUUID();
      const seen = new Set<string>();
      const targets = new Set<string>();
      for (const write of parsed.data.entries) {
        if (containsLearningSecret(`${write.title}\n${write.content}`)) invalid();
        const evidence = [...new Set(write.evidenceSeqs)].sort((a, b) => a - b);
        this.requireEvidence(workspaceId, sessionId, evidence, sourceTurnSeq);
        const before = write.id === undefined ? undefined : this.requireEntry(workspaceId, write.id);
        if (before !== undefined && (before.status !== 'active' || before.version !== write.expectedVersion)) conflict();
        if (before === undefined && write.expectedVersion !== undefined) invalid();
        if (before !== undefined && before.kind !== write.kind) invalid();
        if (before !== undefined && targets.has(before.id)) invalid();
        if (before !== undefined) targets.add(before.id);
        const fingerprint = `${write.kind}:${hashContent(write.content)}`;
        if (seen.has(fingerprint) || this.tombstoned(workspaceId, write) || this.duplicate(workspaceId, write, before?.id) !== undefined) continue;
        seen.add(fingerprint);
        if (before !== undefined && before.title === write.title && before.content === write.content) continue;
        const now = Date.now();
        changes.push({ before, proposal: { id: approvalRequired ? randomUUID() : before?.id ?? randomUUID(), workspaceId, kind: write.kind, title: write.title, content: write.content, status: approvalRequired ? 'pending' : 'active', version: approvalRequired ? 1 : (before?.version ?? 0) + 1, sourceSessionId: sessionId, evidenceSeqs: evidence, reviewId, createdAt: approvalRequired ? now : before?.createdAt ?? now, updatedAt: now } });
      }
      if (changes.length === 0) return null;
      const review: ReviewRow = { id: reviewId, workspace_id: workspaceId, session_id: sessionId, source_turn_seq: sourceTurnSeq, summary: parsed.data.summary, status: approvalRequired ? 'pending' : 'applied' };
      this.db.prepare('INSERT INTO learning_reviews (id, workspace_id, session_id, source_turn_seq, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(review.id, workspaceId, sessionId, sourceTurnSeq, review.summary, review.status, Date.now());
      for (const { before, proposal } of changes) {
        this.persist(proposal, approvalRequired ? 'review_pending' : 'review_apply');
        this.db.prepare('INSERT INTO learning_review_changes (review_id, proposal_id, target_id, before_json, proposal_json) VALUES (?, ?, ?, ?, ?)').run(review.id, proposal.id, before?.id ?? proposal.id, before === undefined ? null : JSON.stringify(before), JSON.stringify(proposal));
        if (!approvalRequired) this.recordApplied(review.id, proposal, before);
      }
      return this.notice(review, changes.map(({ proposal }) => proposal));
    }).immediate();
  }

  manageReview(workspaceId: string, reviewId: string, action: 'approve' | 'reject' | 'revert'): LearningNotice | null {
    return this.db.transaction(() => {
      const review = this.db.prepare<[string, string], ReviewRow>('SELECT * FROM learning_reviews WHERE workspace_id = ? AND id = ?').get(workspaceId, reviewId);
      if (review === undefined) throw new ApiError(404, 'not_found', 'Learning review not found');
      const changes = this.db.prepare<[string], ChangeRow>('SELECT * FROM learning_review_changes WHERE review_id = ? ORDER BY proposal_id').all(review.id);
      const entries: MemoryEntry[] = [];
      if (action === 'approve' || action === 'reject') {
        if (review.status !== 'pending') conflict();
        for (const change of changes) {
          const proposal = this.requireEntry(workspaceId, change.proposal_id);
          const original = MemoryEntrySchema.parse(JSON.parse(change.proposal_json));
          if (proposal.version !== original.version || proposal.status !== 'pending') conflict();
          const before = change.before_json === null ? undefined : MemoryEntrySchema.parse(JSON.parse(change.before_json));
          if (action === 'reject') { this.remove(proposal, 'review_reject', true); continue; }
          if (before !== undefined) {
            const current = this.requireEntry(workspaceId, change.target_id);
            if (current.version !== before.version || current.status !== 'active') conflict();
          }
          if (this.tombstoned(workspaceId, { kind: proposal.kind, content: proposal.content })) conflict();
          if (this.duplicate(workspaceId, { kind: proposal.kind, content: proposal.content }, proposal.id, before?.id) !== undefined) conflict();
          const applied: MemoryEntry = { ...proposal, id: change.target_id, status: 'active', version: (before?.version ?? proposal.version) + 1, createdAt: before?.createdAt ?? proposal.createdAt, updatedAt: Date.now() };
          if (proposal.id !== applied.id) this.remove(proposal, 'proposal_approved', false);
          this.persist(applied, 'review_approve');
          this.recordApplied(review.id, applied, before);
          entries.push(applied);
        }
        review.status = action === 'approve' ? 'applied' : 'rejected';
      } else if (action === 'revert') {
        if (review.status !== 'applied') conflict();
        const applied = this.db.prepare<[string], AppliedRow>('SELECT * FROM learning_review_applied WHERE review_id = ? ORDER BY entry_id').all(review.id);
        for (const change of applied) {
          const current = this.requireEntry(workspaceId, change.entry_id);
          if (current.version !== change.after_version || current.status !== 'active') conflict();
          entries.push(current);
          this.tombstone(current);
          if (change.before_json === null) this.remove(current, 'review_revert', false);
          else {
            const before = MemoryEntrySchema.parse(JSON.parse(change.before_json));
            this.persist({ ...before, version: current.version + 1, updatedAt: Date.now() }, 'review_revert');
          }
        }
        review.status = 'reverted';
      } else return invalid();
      this.db.prepare('UPDATE learning_reviews SET status = ? WHERE id = ?').run(review.status, review.id);
      return this.notice(review, entries);
    }).immediate();
  }

  private requireWorkspace(workspaceId: string): void {
    if (this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId) === undefined) throw new ApiError(404, 'not_found', 'Workspace not found');
  }
  private requireSource(workspaceId: string, sessionId: string): void {
    if (this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND workspace_id = ?').get(sessionId, workspaceId) === undefined) throw new ApiError(404, 'not_found', 'Source session not found');
  }
  private requireEvidence(workspaceId: string, sessionId: string, seqs: number[], ceiling = Number.MAX_SAFE_INTEGER): void {
    this.requireSource(workspaceId, sessionId);
    if (seqs.length === 0 || seqs.length > 30) invalid();
    const lookup = this.db.prepare<[string, number, number], { kind: string }>('SELECT kind FROM events WHERE session_id = ? AND seq = ? AND seq <= ?');
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq) || seq <= 0) invalid();
      const event = lookup.get(sessionId, seq, ceiling);
      if (event === undefined || EVIDENCE_KINDS[event.kind] !== true) invalid();
    }
  }
  private requireEntry(workspaceId: string, id: string): MemoryEntry {
    const entry = this.read(workspaceId, id);
    if (entry === undefined) throw new ApiError(404, 'not_found', 'Memory entry not found');
    return entry;
  }
  private duplicate(workspaceId: string, write: { kind: string; content: string }, excluding = '', excludingTarget = ''): MemoryEntry | undefined {
    const row = this.db.prepare<[string, string, string, string, string], EntryRow>("SELECT * FROM learning_entries WHERE workspace_id = ? AND kind = ? AND content_hash = ? AND status IN ('active', 'pending') AND id NOT IN (?, ?) LIMIT 1").get(workspaceId, write.kind, hashContent(write.content), excluding, excludingTarget);
    return row === undefined ? undefined : entryOf(row);
  }
  private tombstoned(workspaceId: string, write: { kind: string; content: string }): boolean {
    return this.db.prepare('SELECT 1 FROM learning_tombstones WHERE workspace_id = ? AND kind = ? AND content_hash = ?').get(workspaceId, write.kind, hashContent(write.content)) !== undefined;
  }
  private tombstone(entry: MemoryEntry): void {
    this.db.prepare('INSERT OR IGNORE INTO learning_tombstones (workspace_id, kind, content_hash, source_session_id, evidence_seqs, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(entry.workspaceId, entry.kind, hashContent(entry.content), entry.sourceSessionId, JSON.stringify(entry.evidenceSeqs), Date.now());
  }
  private remove(entry: MemoryEntry, reason: string, tombstone: boolean): void {
    if (tombstone) this.tombstone(entry);
    this.persist({ ...entry, status: 'deleted', version: entry.version + 1, updatedAt: Date.now() }, reason);
  }
  private persist(entry: MemoryEntry, reason: string): void {
    this.db.prepare(`INSERT INTO learning_entries (id, workspace_id, kind, title, content, content_hash, status, version, source_session_id, evidence_seqs, review_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, content_hash = excluded.content_hash, status = excluded.status, version = excluded.version, source_session_id = excluded.source_session_id, evidence_seqs = excluded.evidence_seqs, review_id = excluded.review_id, updated_at = excluded.updated_at`).run(entry.id, entry.workspaceId, entry.kind, entry.title, entry.content, hashContent(entry.content), entry.status, entry.version, entry.sourceSessionId, JSON.stringify(entry.evidenceSeqs), entry.reviewId, entry.createdAt, entry.updatedAt);
    this.db.prepare('INSERT INTO learning_history (workspace_id, entry_id, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(entry.workspaceId, entry.id, JSON.stringify(entry), reason, Date.now());
  }
  private recordApplied(reviewId: string, entry: MemoryEntry, before: MemoryEntry | undefined): void {
    this.db.prepare('INSERT INTO learning_review_applied (review_id, entry_id, before_json, after_version) VALUES (?, ?, ?, ?)').run(reviewId, entry.id, before === undefined ? null : JSON.stringify(before), entry.version);
  }
  private notice(review: ReviewRow, entries: MemoryEntry[]): LearningNotice {
    return { reviewId: review.id, status: review.status, summary: review.summary, memoryCount: entries.filter((entry) => entry.kind === 'memory').length, skillCount: entries.filter((entry) => entry.kind === 'skill').length, entryIds: entries.map((entry) => entry.id), sourceTurnSeq: review.source_turn_seq };
  }
}
