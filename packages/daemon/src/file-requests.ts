import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  REQUEST_FILE_TIMEOUT_MS, fileMatchesAccept,
  type RequestFileAgentResult, type RequestFileRequest, type RequestFileResult,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { EventDraft } from './acp-mapping.js';
import { ApiError } from './api-error.js';
import { toFileInfo } from './files.js';
import { findFileById, hasFileRequest, orphanedFileRequests } from './repository.js';

const MAX_PENDING_PER_SESSION = 8;
type CancellationReason = Extract<RequestFileResult, { status: 'cancelled' }>['reason'];
interface PendingFileRequest {
  accept: readonly string[] | undefined;
  expiresAt: number;
  timer: NodeJS.Timeout;
  settling: boolean;
  cleanup(): void;
  resolve(result: RequestFileAgentResult): void;
}

/** Uploads alone never answer a request; only an explicit paired-device selection enters this registry. */
export class FileRequests {
  private readonly pending = new Map<string, Map<string, PendingFileRequest>>();
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly persist: (sessionId: string, event: EventDraft) => void,
    private readonly timeoutMs = REQUEST_FILE_TIMEOUT_MS,
  ) {
    for (const { sessionId, requestId } of orphanedFileRequests(db)) {
      this.persist(sessionId, {
        kind: 'file_request_resolved', requestId,
        result: { status: 'cancelled', reason: 'session_ended' },
      });
    }
  }

  request(sessionId: string, request: RequestFileRequest, signal: AbortSignal): Promise<RequestFileAgentResult> {
    if (this.closed) throw new ApiError(409, 'session_ended', 'daemon is shutting down');
    if (signal.aborted) return Promise.resolve({ status: 'cancelled', reason: 'disconnected' });
    let requests = this.pending.get(sessionId);
    if ((requests?.size ?? 0) >= MAX_PENDING_PER_SESSION) {
      throw new ApiError(429, 'too_many_file_requests', 'too many pending file requests in this session');
    }
    if (hasFileRequest(this.db, sessionId, request.requestId)) {
      throw new ApiError(409, 'file_request_conflict', 'file request id has already been used');
    }
    if (requests === undefined) {
      requests = new Map();
      this.pending.set(sessionId, requests);
    }
    const expiresAt = Date.now() + this.timeoutMs;
    let resolveResult!: (result: RequestFileAgentResult) => void;
    const result = new Promise<RequestFileAgentResult>((resolve) => { resolveResult = resolve; });
    const disconnected = (): void => { this.cancel(sessionId, request.requestId, 'disconnected'); };
    const timer = setTimeout(() => this.cancel(sessionId, request.requestId, 'expired'), this.timeoutMs);
    timer.unref();
    const pending: PendingFileRequest = {
      accept: request.accept, expiresAt, timer, settling: false,
      cleanup: () => signal.removeEventListener('abort', disconnected), resolve: resolveResult,
    };
    requests.set(request.requestId, pending);
    signal.addEventListener('abort', disconnected, { once: true });
    try {
      this.persist(sessionId, { kind: 'file_request', ...request, expiresAt });
    } catch (error) {
      clearTimeout(timer);
      pending.cleanup();
      requests.delete(request.requestId);
      if (requests.size === 0) this.pending.delete(sessionId);
      throw error;
    }
    return result;
  }

  respond(sessionId: string, requestId: string, fileId: string | null): RequestFileResult {
    const pending = this.pending.get(sessionId)?.get(requestId);
    if (pending === undefined || pending.settling) {
      throw new ApiError(409, 'file_request_not_pending', 'file request is no longer pending');
    }
    if (Date.now() >= pending.expiresAt) {
      this.cancel(sessionId, requestId, 'expired');
      throw new ApiError(410, 'file_request_expired', 'file request has expired');
    }
    if (fileId === null) {
      const result = { status: 'cancelled', reason: 'user_cancelled' } as const;
      this.finish(sessionId, requestId, pending, result, result);
      return result;
    }
    const record = findFileById(this.db, fileId);
    if (record === undefined || record.sessionId !== sessionId || record.direction !== 'from_phone') {
      throw new ApiError(400, 'invalid_attachment', 'attachment does not belong to this session');
    }
    if (!fileMatchesAccept(record, pending.accept)) {
      throw new ApiError(400, 'file_type_not_accepted', 'attachment type is not accepted by this request');
    }
    // Do not release a successful MCP result with a missing file or a non-absolute database path.
    let available = false;
    try { available = isAbsolute(record.path) && statSync(record.path).isFile(); } catch { /* Missing stored attachment. */ }
    if (!available) throw new ApiError(410, 'attachment_unavailable', 'attachment is no longer available');
    if (Date.now() >= pending.expiresAt) {
      this.cancel(sessionId, requestId, 'expired');
      throw new ApiError(410, 'file_request_expired', 'file request has expired');
    }
    const result = { status: 'received', file: toFileInfo(record) } as const;
    this.finish(sessionId, requestId, pending, result, { ...result, path: record.path });
    return result;
  }

  cancelSession(sessionId: string, reason: CancellationReason = 'session_ended'): void {
    const requests = this.pending.get(sessionId);
    if (requests === undefined) return;
    for (const requestId of [...requests.keys()]) this.cancel(sessionId, requestId, reason);
  }

  close(): void {
    this.closed = true;
    for (const sessionId of [...this.pending.keys()]) this.cancelSession(sessionId);
  }

  private cancel(sessionId: string, requestId: string, reason: CancellationReason): void {
    const pending = this.pending.get(sessionId)?.get(requestId);
    if (pending === undefined || pending.settling) return;
    const result = { status: 'cancelled', reason } as const;
    this.finish(sessionId, requestId, pending, result, result);
  }

  private finish(
    sessionId: string, requestId: string, pending: PendingFileRequest,
    result: RequestFileResult, agentResult: RequestFileAgentResult,
  ): void {
    // The public event must commit before the private path reaches the agent. Guard reentrant device replies.
    pending.settling = true;
    try {
      this.persist(sessionId, { kind: 'file_request_resolved', requestId, result });
    } catch (error) {
      pending.settling = false;
      throw error;
    }
    clearTimeout(pending.timer);
    pending.cleanup();
    const requests = this.pending.get(sessionId);
    requests?.delete(requestId);
    if (requests?.size === 0) this.pending.delete(sessionId);
    pending.resolve(agentResult);
  }
}
