import type { Tone } from '../lib/status.js';

/** Text colour per status tone. `muted` is the neutral grey. */
export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  running: 'text-running',
  attention: 'text-attention',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** Solid fill per status tone, for the status dot only. */
export const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  running: 'bg-running',
  attention: 'bg-attention',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground/55',
};

/** Faint tint behind a tone's text (badges, notices). Never a large fill. */
export const TONE_TINT: Record<Tone, string> = {
  success: 'bg-success/12',
  running: 'bg-running/12',
  attention: 'bg-attention/12',
  destructive: 'bg-destructive/10',
  muted: 'bg-muted',
};
