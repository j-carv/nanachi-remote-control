import { z } from 'zod';

/** Preview traffic has its own origin; never serve project code on the dashboard origin. */
export const PREVIEW_HTTPS_PORT = 8443;
export const PREVIEW_TIMEOUT_MS = 30 * 60_000;

/** The sidecar and manual Tailscale Serve mapping use this adjacent loopback listener. */
export function previewLocalPort(daemonPort: number): number {
  return daemonPort === 65535 ? 65534 : daemonPort + 1;
}

const PreviewPathSchema = z.string().min(1).max(2048).refine((path) => {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(path) || /%(?![0-9a-f]{2})/i.test(path)) return false;
  return new URL(path, 'http://127.0.0.1').origin === 'http://127.0.0.1';
}, 'Provide a local rooted path, optionally with a query string, without a fragment');

export const PreviewInputSchema = z.object({
  port: z.number().int().min(1).max(65535).describe('HTTP development server port on this PC. The server must already be running on IPv4 loopback.'),
  title: z.string().trim().min(1).max(200).optional().describe('Short title shown on the preview card.'),
  path: PreviewPathSchema.optional().describe('Local page path to open, such as / or /settings?mode=demo.'),
}).strict();
export type PreviewInput = z.infer<typeof PreviewInputSchema>;

export const PreviewInfoSchema = z.object({
  previewId: z.uuid(),
  port: PreviewInputSchema.shape.port,
  title: z.string().trim().min(1).max(200),
  path: PreviewPathSchema,
  expiresAt: z.number().int().nonnegative(),
}).strict();
export type PreviewInfo = z.infer<typeof PreviewInfoSchema>;

export const PreviewCloseReasonSchema = z.enum(['closed', 'expired', 'session_ended']);
export type PreviewCloseReason = z.infer<typeof PreviewCloseReasonSchema>;

/** The URL contains a one-time fragment ticket, not a paired-device or session token. */
export const PreviewOpenResponseSchema = z.object({
  url: z.url(),
  expiresAt: z.number().int().nonnegative(),
}).strict();
export type PreviewOpenResponse = z.infer<typeof PreviewOpenResponseSchema>;
export const PreviewCloseResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type PreviewCloseResponse = z.infer<typeof PreviewCloseResponseSchema>;
