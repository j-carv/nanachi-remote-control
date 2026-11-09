import { z } from 'zod';
import { FileInfoSchema } from './file.js';

export const REQUEST_FILE_TIMEOUT_MS = 5 * 60_000;

/** Safe HTML file-picker extensions and MIME types; only the subtype may be a wildcard. */
const AcceptTypeSchema = z.string().trim().toLowerCase().min(1).max(100).regex(
  /^(?:\.[a-z0-9][a-z0-9._+-]*|[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*))$/,
);

export const RequestFileInputSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  accept: z.array(AcceptTypeSchema).min(1).max(16).optional(),
}).strict();
export type RequestFileInput = z.infer<typeof RequestFileInputSchema>;

/** MCP generates the identity, never the model. */
export const RequestFileRequestSchema = RequestFileInputSchema.safeExtend({ requestId: z.uuid() });
export type RequestFileRequest = z.infer<typeof RequestFileRequestSchema>;

const CancelledFileRequestSchema = z.object({
  status: z.literal('cancelled'),
  reason: z.enum(['user_cancelled', 'expired', 'disconnected', 'session_ended']),
}).strict();

export const RequestFileResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('received'), file: FileInfoSchema }).strict(),
  CancelledFileRequestSchema,
]);
export type RequestFileResult = z.infer<typeof RequestFileResultSchema>;

/** Only the authenticated local agent receives the stored path, never the paired device or history. */
export const RequestFileAgentResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('received'), file: FileInfoSchema, path: z.string().min(1) }).strict(),
  CancelledFileRequestSchema,
]);
export type RequestFileAgentResult = z.infer<typeof RequestFileAgentResultSchema>;

export const RespondFileRequestSchema = z.object({ fileId: z.string().min(1).nullable() }).strict();

/** Picker filtering is advisory; the daemon repeats this check before accepting a selection. */
export function fileMatchesAccept(file: { name: string; mime: string }, accept?: readonly string[]): boolean {
  if (accept === undefined) return true;
  const name = file.name.toLowerCase();
  const mime = file.mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return accept.some((type) => {
    const normalized = type.trim().toLowerCase();
    if (normalized.startsWith('.')) return name.endsWith(normalized);
    if (normalized.endsWith('/*')) return mime.startsWith(normalized.slice(0, -1));
    return mime === normalized;
  });
}
