import {
  GitCheckoutRequestSchema,
  WorkspaceFileWriteRequestSchema,
  WorkspaceMkdirRequestSchema,
  WorkspaceRenameRequestSchema,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.js';
import type { DeviceGuard } from './file-routes.js';
import { assertBranchName, assertGitRepo, readBranches, readRepoBranches, switchBranch } from './git-branches.js';
import { createRateLimiter } from './rate-limit.js';
import { findWorkspaceById, hasBusySessionsInWorkspace } from './repository.js';
import {
  deleteEntry,
  listDirectory,
  makeDirectory,
  readTextFile,
  renameEntry,
  writeTextFile,
} from './workspace-fs.js';
import { realRootOf } from './workspace-paths.js';

/** Writes (PUT, mkdir, rename, delete) allowed per device per minute. Beyond that: 429 `too_many_writes`. */
export const WRITES_PER_MINUTE = 120;
const WRITE_WINDOW_MS = 60_000;
/**
 * Body limit for PUT. Content is capped at 2 MiB of UTF-8 (413 `file_too_large`), but JSON escapes control characters
 * (up to 6 bytes each), so the body can exceed 2 MiB while the content does not.
 */
const PUT_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

export interface WorkspaceRouteDeps {
  db: Database.Database;
  /** Device Bearer check run in onRequest: a route never reads the body of a caller that fails it. */
  requireDevice: DeviceGuard;
}

function invalidRequest(): ApiError {
  return new ApiError(400, 'invalid_request', 'invalid request');
}

/** Required `path` query parameter. Missing or repeated → 400. */
function requiredPath(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest();
  return value;
}

/** Optional path for listing: missing means the workspace root. */
function optionalPath(value: unknown): string {
  return value === undefined ? '' : requiredPath(value);
}

/**
 * Branch and workspace-file routes (PLAN, "Extra (04/11) — branches e arquivos do workspace").
 * All of them use a device Bearer token. Paths are relative to the workspace root and go through `workspace-paths`.
 */
export async function registerWorkspaceRoutes(api: FastifyInstance, deps: WorkspaceRouteDeps): Promise<void> {
  const { db, requireDevice } = deps;
  const writes = createRateLimiter({ max: WRITES_PER_MINUTE, windowMs: WRITE_WINDOW_MS });

  /** Real root of the workspace. Unknown id → 404; folder gone from disk → 404 (see `realRootOf`). */
  const rootOf = (id: string): string => {
    const workspace = findWorkspaceById(db, id);
    if (workspace === undefined) throw new ApiError(404, 'not_found', 'workspace not found');
    return realRootOf(workspace.path);
  };

  const countWrite = (request: FastifyRequest): void => {
    if (!writes.take(request.device?.id ?? 'no-device', Date.now())) {
      throw new ApiError(429, 'too_many_writes', 'too many changes in a row: wait a minute');
    }
  };

  await api.register(async (scope) => {
    scope.addHook('onRequest', requireDevice);

    scope.get<{ Params: { id: string } }>('/api/workspaces/:id/git/branches', async (request) => {
      return readBranches(rootOf(request.params.id));
    });

    scope.post<{ Params: { id: string } }>('/api/workspaces/:id/git/checkout', async (request) => {
      const parsed = GitCheckoutRequestSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest();
      const root = rootOf(request.params.id);
      await assertGitRepo(root);
      await assertBranchName(root, parsed.data.branch);
      if (hasBusySessionsInWorkspace(db, request.params.id)) {
        throw new ApiError(409, 'sessions_running', 'a session of this workspace is running: stop it or wait before switching branches');
      }
      await switchBranch(root, parsed.data.branch, parsed.data.create === true);
      return readRepoBranches(root);
    });

    scope.get<{ Params: { id: string }; Querystring: { path?: unknown } }>(
      '/api/workspaces/:id/fs/list',
      async (request) => listDirectory(rootOf(request.params.id), optionalPath(request.query.path)),
    );

    scope.get<{ Params: { id: string }; Querystring: { path?: unknown } }>(
      '/api/workspaces/:id/fs/file',
      async (request) => readTextFile(rootOf(request.params.id), requiredPath(request.query.path)),
    );

    scope.put<{ Params: { id: string } }>(
      '/api/workspaces/:id/fs/file',
      { bodyLimit: PUT_BODY_LIMIT_BYTES },
      async (request) => {
        countWrite(request);
        const parsed = WorkspaceFileWriteRequestSchema.safeParse(request.body);
        if (!parsed.success) throw invalidRequest();
        return writeTextFile(rootOf(request.params.id), parsed.data.path, parsed.data.content, parsed.data.baseEtag);
      },
    );

    scope.post<{ Params: { id: string } }>('/api/workspaces/:id/fs/mkdir', async (request, reply) => {
      countWrite(request);
      const parsed = WorkspaceMkdirRequestSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest();
      const created = await makeDirectory(rootOf(request.params.id), parsed.data.path);
      return reply.code(201).send(created);
    });

    scope.post<{ Params: { id: string } }>('/api/workspaces/:id/fs/rename', async (request) => {
      countWrite(request);
      const parsed = WorkspaceRenameRequestSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest();
      return renameEntry(rootOf(request.params.id), parsed.data.from, parsed.data.to);
    });

    scope.delete<{ Params: { id: string }; Querystring: { path?: unknown } }>(
      '/api/workspaces/:id/fs/entry',
      async (request, reply) => {
        countWrite(request);
        await deleteEntry(rootOf(request.params.id), requiredPath(request.query.path));
        return reply.code(204).send();
      },
    );
  });
}
