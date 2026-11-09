import {
  ASK_USER_TIMEOUT_MS,
  type AskUserOption,
  type AskUserRequest,
  type AskUserResult,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { EventDraft } from './acp-mapping.js';
import { ApiError } from './api-error.js';
import { hasUserQuestion, orphanedUserQuestions } from './repository.js';

const MAX_PENDING_PER_SESSION = 8;
type CancellationReason = Extract<AskUserResult, { status: 'cancelled' }>['reason'];
interface PendingQuestion {
  options: readonly AskUserOption[];
  expiresAt: number;
  timer: NodeJS.Timeout;
  settling: boolean;
  cleanup(): void;
  resolve(result: AskUserResult): void;
}

/** Only explicit device selections answer questions; permissions and session status never enter this registry. */
export class UserQuestions {
  private readonly pending = new Map<string, Map<string, PendingQuestion>>();
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly persist: (sessionId: string, event: EventDraft) => void,
    private readonly timeoutMs = ASK_USER_TIMEOUT_MS,
  ) {
    // A persisted question cannot revive an MCP HTTP request after a restart.
    for (const { sessionId, requestId } of orphanedUserQuestions(db)) {
      this.persist(sessionId, {
        kind: 'user_question_resolved', requestId,
        result: { status: 'cancelled', reason: 'session_ended' },
      });
    }
  }

  ask(sessionId: string, request: AskUserRequest, signal: AbortSignal): Promise<AskUserResult> {
    if (this.closed) throw new ApiError(409, 'session_ended', 'daemon is shutting down');
    if (signal.aborted) return Promise.resolve({ status: 'cancelled', reason: 'disconnected' });
    let questions = this.pending.get(sessionId);
    if ((questions?.size ?? 0) >= MAX_PENDING_PER_SESSION) {
      throw new ApiError(429, 'too_many_questions', 'too many pending questions in this session');
    }
    if (hasUserQuestion(this.db, sessionId, request.requestId)) {
      throw new ApiError(409, 'question_conflict', 'question id has already been used');
    }
    if (questions === undefined) {
      questions = new Map();
      this.pending.set(sessionId, questions);
    }
    const expiresAt = Date.now() + this.timeoutMs;
    let resolveResult!: (result: AskUserResult) => void;
    const result = new Promise<AskUserResult>((resolve) => { resolveResult = resolve; });
    const disconnected = (): void => { this.cancel(sessionId, request.requestId, 'disconnected'); };
    const timer = setTimeout(() => this.cancel(sessionId, request.requestId, 'expired'), this.timeoutMs);
    timer.unref();
    const pending: PendingQuestion = {
      options: request.options,
      expiresAt,
      timer,
      settling: false,
      cleanup: () => signal.removeEventListener('abort', disconnected),
      resolve: resolveResult,
    };
    questions.set(request.requestId, pending);
    signal.addEventListener('abort', disconnected, { once: true });
    try {
      this.persist(sessionId, { kind: 'user_question', ...request, expiresAt });
    } catch (error) {
      clearTimeout(timer);
      pending.cleanup();
      questions.delete(request.requestId);
      if (questions.size === 0) this.pending.delete(sessionId);
      throw error;
    }
    return result;
  }

  respond(sessionId: string, requestId: string, optionId: string | null): AskUserResult {
    const pending = this.pending.get(sessionId)?.get(requestId);
    if (pending === undefined || pending.settling) throw new ApiError(409, 'question_not_pending', 'question is no longer pending');
    // The deadline is authoritative even if a busy event loop has delayed the expiry callback.
    if (Date.now() >= pending.expiresAt) {
      this.cancel(sessionId, requestId, 'expired');
      throw new ApiError(410, 'question_expired', 'question has expired');
    }
    let result: AskUserResult;
    if (optionId === null) {
      result = { status: 'cancelled', reason: 'user_cancelled' };
    } else {
      const option = pending.options.find((item) => item.id === optionId);
      if (option === undefined) throw new ApiError(400, 'invalid_option', 'option does not belong to this question');
      result = { status: 'answered', option: { id: option.id, label: option.label } };
    }
    this.finish(sessionId, requestId, pending, result);
    return result;
  }

  cancelSession(sessionId: string, reason: CancellationReason = 'session_ended'): void {
    const questions = this.pending.get(sessionId);
    if (questions === undefined) return;
    for (const requestId of [...questions.keys()]) this.cancel(sessionId, requestId, reason);
  }

  close(): void {
    this.closed = true;
    for (const sessionId of [...this.pending.keys()]) this.cancelSession(sessionId);
  }

  private cancel(sessionId: string, requestId: string, reason: CancellationReason): void {
    const pending = this.pending.get(sessionId)?.get(requestId);
    if (pending !== undefined && !pending.settling) this.finish(sessionId, requestId, pending, { status: 'cancelled', reason });
  }

  private finish(sessionId: string, requestId: string, pending: PendingQuestion, result: AskUserResult): void {
    // Persist before releasing any waiter or discarding live state. Block reentrant replies during event delivery.
    pending.settling = true;
    try {
      this.persist(sessionId, { kind: 'user_question_resolved', requestId, result });
    } catch (error) {
      pending.settling = false;
      throw error;
    }
    clearTimeout(pending.timer);
    pending.cleanup();
    const questions = this.pending.get(sessionId);
    questions?.delete(requestId);
    if (questions?.size === 0) this.pending.delete(sessionId);
    pending.resolve(result);
  }
}
