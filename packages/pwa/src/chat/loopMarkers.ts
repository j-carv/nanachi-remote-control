import { LOOP_INTERVAL_MAX_MS, LOOP_INTERVAL_MIN_MS, parseLoopDuration } from '@nanachi/shared';
import { formatCountdown } from './loop.js';

/*
 * Loop markers the agent writes at the end of a round (`[[nanachi-loop-next: <duração>]]`, `[[nanachi-loop-stop]]`;
 * the daemon reads them in `parseLoopMarker`, loop-runner.ts). The stored text keeps them. The chat hides them and
 * shows a note in their place. Pure, no React.
 */

const MARKER_BODY = String.raw`\[\[nanachi-loop-(?:stop|next:[^\]\n]*)\]\]`;
const MARKER_START = '[[nanachi-loop-';
const BLANK = String.raw`[ \t\r\`]`;

/** A line that is only a marker (spaces, tabs or backticks around it are allowed). */
const WHOLE_LINE = new RegExp(`^${BLANK}*${MARKER_BODY}${BLANK}*$`);
/** Markers at the end of the text, inline or on their own lines, with the whitespace before them. */
const TRAILING = new RegExp(String.raw`(?:[\s\`]*${MARKER_BODY})+[\s\`]*$`);
const EVERY_MARKER = new RegExp(MARKER_BODY, 'g');

/** Prefix of a marker still arriving in a streaming chunk: the text from `[[` on, while it is a prefix of `[[nanachi-`. */
const PARTIAL_PREFIX = '[[nanachi-';

type Marker = { kind: 'stop' } | { kind: 'next'; delayMs: number };

export interface LoopMarkerSplit {
  /** Text to show, without the markers. */
  text: string;
  /** Note for the end of the round, or null when the text has no well-formed marker. */
  note: string | null;
}

/** Reads a complete marker the way the daemon does: `next` durations are limited to 30 s–24 h. */
function markerOf(marker: string): Marker | undefined {
  const body = marker.slice(MARKER_START.length, -2);
  if (body === 'stop') return { kind: 'stop' };
  const delay = parseLoopDuration(body.slice('next:'.length).trim());
  if (delay === undefined) return undefined;
  return { kind: 'next', delayMs: Math.min(LOOP_INTERVAL_MAX_MS, Math.max(LOOP_INTERVAL_MIN_MS, delay)) };
}

/** The note for the last well-formed marker in the text (the daemon also takes the last one). */
function noteOf(text: string): string | null {
  let last: Marker | undefined;
  for (const match of text.matchAll(EVERY_MARKER)) {
    const marker = markerOf(match[0]);
    if (marker !== undefined) last = marker;
  }
  if (last === undefined) return null;
  return last.kind === 'stop' ? 'Loop encerrado pelo agente' : `Próxima rodada em ${formatCountdown(last.delayMs)}`;
}

/** Index where an unfinished marker starts at the end of the text, or -1. */
function partialMarkerStart(text: string): number {
  const index = text.lastIndexOf('[[');
  if (index === -1) return -1;
  const tail = text.slice(index);
  const isPrefix = tail.length < PARTIAL_PREFIX.length && PARTIAL_PREFIX.startsWith(tail);
  const isOpenMarker =
    tail.startsWith(PARTIAL_PREFIX) && !tail.includes('\n') && !tail.includes(']]');
  return isPrefix || isOpenMarker ? index : -1;
}

/**
 * Splits agent text into the visible text and the round note. Removes whole-line markers and markers at the end
 * of the text. A marker still arriving at the end (`[[nanachi-loo`) is hidden until it completes, so a streaming
 * chunk never shows a fragment of it. A marker in the middle of a line stays as written.
 */
export function splitLoopMarkers(text: string): LoopMarkerSplit {
  const note = noteOf(text);
  let visible = text
    .split('\n')
    .filter((line) => !WHOLE_LINE.test(line))
    .join('\n')
    .replace(TRAILING, '');
  const partial = partialMarkerStart(visible);
  if (partial !== -1) visible = visible.slice(0, partial);
  if (visible !== text) visible = visible.trimEnd();
  return { text: visible, note };
}
