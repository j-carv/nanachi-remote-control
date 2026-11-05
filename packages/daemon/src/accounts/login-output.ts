/**
 * Parsing of what a login CLI prints into a pseudoterminal (PLAN.md, "Login" under "Routes"). Pure functions: no I/O,
 * and nothing here logs. The text is untrusted terminal output, so it is only ever read, never executed.
 */

/** Characters of the cleaned output the API exposes (the tail). */
export const OUTPUT_LIMIT = 4000;
/** Replacement for a code the user pasted when the terminal echoes it back. */
export const CODE_MASK = '••••';

/** OSC, terminated by BEL or ST (`ESC \`). OSC 8 hyperlinks carry the URL in the parameters; the visible text stays. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** An OSC whose terminator has not arrived yet (the chunk ended inside it). */
const OSC_OPEN = /\u001b\][^\u0007\u001b]*\u001b?$/;
/** SGR (colours and styles): dropped without a trace so words are never split. */
const SGR = /\u001b\[[0-9;:]*m/g;
/** Any other CSI (cursor moves, erase, modes). Replaced by a space: dropping it would glue the neighbouring lines. */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** A CSI (or a lone ESC) cut off at the end of the chunk. */
const CSI_OPEN = /\u001b(?:\[[0-?]*[ -/]*)?$/;
/** Two-byte and charset escapes (`ESC =`, `ESC ( B`) that remain after the sequences above. */
const OTHER_ESCAPE = /\u001b[ -/]*[0-~]/g;
/** C0 controls other than tab, CR and LF, plus DEL. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
/** Between the characters of a pasted code the terminal may have redrawn with cursor moves, which become spaces. */
const GAP = '[ \\t\\n]*';
const MIN_FUZZY_LENGTH = 8;

export interface ParsedLogin {
  /** The output with escape sequences removed, CRLF normalised. Unmasked: callers mask before exposing it. */
  text: string;
  url: string | null;
  userCode: string | null;
}

/** Removes escape sequences from terminal output and normalises line endings. */
export function cleanTerminalText(raw: string): string {
  return raw
    .replace(OSC, '')
    .replace(OSC_OPEN, '')
    .replace(SGR, '')
    .replace(CSI, ' ')
    .replace(CSI_OPEN, '')
    .replace(OTHER_ESCAPE, '')
    .replace(CONTROL, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** A copy of the pattern that keeps no state between searches (a `g` or `y` flag would). */
function stateless(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

/**
 * Cleans `raw` and finds the sign-in link and, when the adapter has a pattern, the one-time code printed after it.
 * `final: false` (the process is still printing) ignores a match that touches the end of the text, since the rest of it
 * may still be on the way; `final: true` takes it as it is.
 */
export function parseLoginOutput(raw: string, codePattern: RegExp | null, final: boolean): ParsedLogin {
  const text = cleanTerminalText(raw);
  const urlMatch = URL_PATTERN.exec(text);
  if (urlMatch === null) return { text, url: null, userCode: null };
  const urlEnd = urlMatch.index + urlMatch[0].length;
  if (!final && urlEnd === text.length) return { text, url: null, userCode: null };

  let userCode: string | null = null;
  if (codePattern !== null) {
    const codeMatch = stateless(codePattern).exec(text.slice(urlEnd));
    if (codeMatch !== null && (final || urlEnd + codeMatch.index + codeMatch[0].length < text.length)) {
      userCode = codeMatch[0];
    }
  }
  return { text, url: urlMatch[0], userCode };
}

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every echo of a pasted code with `••••`. A long code also matches when the terminal redrew it with spaces or
 * line breaks between characters.
 */
export function maskCodes(text: string, codes: readonly string[]): string {
  let result = text;
  for (const code of codes) {
    if (code.length === 0) continue;
    if (code.length < MIN_FUZZY_LENGTH) {
      result = result.split(code).join(CODE_MASK);
      continue;
    }
    const pattern = new RegExp(Array.from(code, escapeRegExp).join(GAP), 'g');
    result = result.replace(pattern, CODE_MASK);
  }
  return result;
}

/** The last `OUTPUT_LIMIT` characters. */
export function tailOf(text: string, limit: number = OUTPUT_LIMIT): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}
