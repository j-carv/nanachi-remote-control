/**
 * Splits one line of the Logs section into tokens for the highlighting: timestamps, levels, quoted strings, keys, numbers,
 * URLs, file paths, JSON punctuation and stack-trace frames. A log line is not source code, so this is one scan with a
 * few patterns and no parser: whatever is not recognised stays plain text, and nothing here can fail.
 *
 * The tokens give back the line exactly (joined, they are the line), so the view shows the file's text unchanged.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LogTokenKind = 'timestamp' | 'level' | 'string' | 'key' | 'number' | 'url' | 'path' | 'punctuation' | 'frame' | 'text';

export type LogToken = { readonly kind: Exclude<LogTokenKind, 'level'>; readonly text: string } | { readonly kind: 'level'; readonly text: string; readonly level: LogLevel };

export interface AnalyzedLogLine {
  readonly tokens: readonly LogToken[];
  readonly level: LogLevel;
}

// The sources below are written without capture names, so the scanner can give each alternative its own named group.
// The separators are the characters a path or a URL cannot end in or contain: whitespace, quotes, brackets, `,;=`.

const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|(?<![\w:.])\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?: ?[AP]M)?(?![\w:])`;
/** The scheme and `://`, then characters up to the first separator; the last character is never punctuation. */
const URL = String.raw`(?<![\w+.-])[A-Za-z][\w+.-]*:\/\/[^\s"'<>()\[\]{}]*[^\s"'<>()\[\]{},;:.!?]`;
const DQUOTE = String.raw`"(?:[^"\\\r\n]|\\.)*"`;
/** A single-quoted text only when it opens after a separator and closes before one: `d'água` is not a quote. */
const SQUOTE = String.raw`(?<=^|[\s(\[{=:,])'[^'\r\n]*'(?=$|[\s),.;:\]}])`;
/** `name=` (not `==`): a key of the key=value form. */
const KEY = String.raw`(?<=^|[\s(\[{,&?;])[A-Za-z_][\w.-]*=(?!=)`;
const KEY_LEVEL = String.raw`(?<=(?<![\w.-])level=)[A-Za-z]+(?!\w)`;
/** The value after `"level":` and `"time":`, in JSON: the number or the string. */
const JSON_LEVEL = String.raw`(?<="level"\s*:\s*)(?:-?\d+|"[^"\\\r\n]*")`;
const JSON_TIME = String.raw`(?<="(?:time|timestamp)"\s*:\s*)(?:-?\d+|"[^"\\\r\n]*")`;
/** A Windows path. Spaces are allowed inside it (`Área de Trabalho`), so a path ends at a separator, not at a space. */
const WIN_PATH = String.raw`(?<!\w)[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|()\[\]{},;'=]|[\\/]|[ ](?=[^\s\\/:*?"<>|()\[\]{},;'=]))*(?::\d+){0,2}`;
/** An absolute path (`/a/b.js`) or one with a folder in it (`src/a.ts`), always with an extension; `and/or` is not a path. */
const POSIX_PATH = String.raw`(?<![\w.:/\\-])(?:(?:\.{1,2})?\/[\w@~+.-]+(?:\/[\w@~+.-]+)*|[\w@~+-]+(?:\/[\w@~+.-]+)+)\.[A-Za-z0-9]{1,8}(?::\d+){0,2}(?![\w/])`;
/** A bracketed tag such as `[warn]`, `[tsnet]` or `[shared-tsc]`: a level when it names one, a plain tag otherwise. */
const BRACKET = String.raw`\[[\w.-]+\]`;
/** A word on its own; it is a level only at the start of the line (see `scan`). */
const WORD = String.raw`(?<!\w)[A-Za-z]+(?!\w)`;
/** Integers and decimals, IP addresses included; not the digits inside a word or a version such as `v1.2.3`. */
const NUMBER = String.raw`(?<![\w.\/\\-])-?\d+(?:\.\d+)*(?!\w|\.\d)`;
const PUNCTUATION = String.raw`[{}\[\]:,=]`;

const SCANNER = new RegExp(
  [
    `(?<timestamp>${TIMESTAMP})`,
    `(?<url>${URL})`,
    `(?<jsonlevel>${JSON_LEVEL})`,
    `(?<jsontime>${JSON_TIME})`,
    `(?<dquote>${DQUOTE})`,
    `(?<squote>${SQUOTE})`,
    `(?<kv>${KEY})`,
    `(?<kvlevel>${KEY_LEVEL})`,
    `(?<win>${WIN_PATH})`,
    `(?<posix>${POSIX_PATH})`,
    `(?<bracket>${BRACKET})`,
    `(?<word>${WORD})`,
    `(?<number>${NUMBER})`,
    `(?<punct>${PUNCTUATION})`,
  ].join('|'),
  'g',
);

/** The url and path pieces of a quoted string; everything else in the string stays string. */
const STRING_BODY = new RegExp(`(?<url>${URL})|(?<path>${WIN_PATH}|${POSIX_PATH})`, 'g');

/** A colon after optional spaces, tested at a position (sticky), so a JSON key is found without copying the rest of the line. */
const COLON_AHEAD = /\s*:/y;

/** The start of a line before its first word: an optional timestamp and optional `[tag]`s. */
const LEAD = /^\s*(?:(?:\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?: ?[AP]M)?)\s+)?(?:\[[^\]\r\n]*\]\s*)*/;
/** A stack-trace frame: the indentation, then `at`. */
const FRAME = /^(\s+)at(?=\s)/;

/** Pino's numeric levels (the daemon's stdout), and the names used in text. */
const NUMERIC_LEVELS = new Map<string, LogLevel>([
  ['10', 'trace'],
  ['20', 'debug'],
  ['30', 'info'],
  ['40', 'warn'],
  ['50', 'error'],
  ['60', 'error'],
]);
const WORD_LEVELS = new Map<string, LogLevel>([
  ['trace', 'trace'],
  ['debug', 'debug'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['warning', 'warn'],
  ['aviso', 'warn'],
  ['error', 'error'],
  ['erro', 'error'],
  ['fatal', 'error'],
]);

/** Lines with no level marker keep the keyword rule the Logs section always had. */
const ERROR_WORD = /\b(error|erro|fatal|exception|uncaught|panic)\b/i;
const WARN_WORD = /\b(warn|warning|aviso)\b/i;

/** The level a text names (`30`, `"warn"`, `[ERROR]`, `erro`), or null. */
function levelOf(text: string): LogLevel | null {
  const bare = text.replace(/^["[]+|["\]]+$/g, '').toLowerCase();
  return /^\d+$/.test(bare) ? (NUMERIC_LEVELS.get(bare) ?? null) : (WORD_LEVELS.get(bare) ?? null);
}

type PlainKind = Exclude<LogTokenKind, 'level'>;

/** Adds a token; adjacent text (or string) pieces are joined so a plain line is one token. */
function push(out: LogToken[], kind: PlainKind, text: string): void {
  if (text === '') return;
  const last = out.at(-1);
  if (last !== undefined && last.kind === kind && (kind === 'text' || kind === 'string')) {
    out[out.length - 1] = { kind, text: last.text + text };
    return;
  }
  out.push({ kind, text });
}

/** The url and path pieces of a quoted string. The string's own characters are `string`. */
function pushStringBody(out: LogToken[], text: string): void {
  STRING_BODY.lastIndex = 0;
  let cursor = 0;
  for (let match = STRING_BODY.exec(text); match !== null; match = STRING_BODY.exec(text)) {
    const piece = match.groups?.url !== undefined ? match[0] : match[0].replace(/\.+$/, '');
    if (piece === '') {
      STRING_BODY.lastIndex = match.index + 1;
      continue;
    }
    push(out, 'string', text.slice(cursor, match.index));
    push(out, match.groups?.url !== undefined ? 'url' : 'path', piece);
    cursor = match.index + piece.length;
    STRING_BODY.lastIndex = cursor;
  }
  push(out, 'string', text.slice(cursor));
}

function pushLevel(out: LogToken[], text: string, level: LogLevel): void {
  out.push({ kind: 'level', text, level });
}

/**
 * Scans `line` from `from` with the single scanner. `leadEnd` is where the first word of the line starts (after the
 * timestamp and tags): a level word counts only there, so `Found 9 errors` does not turn the line into an error.
 */
function scan(line: string, from: number, leadEnd: number, out: LogToken[]): void {
  SCANNER.lastIndex = from;
  let cursor = from;
  for (let match = SCANNER.exec(line); match !== null; match = SCANNER.exec(line)) {
    const start = match.index;
    const groups: Partial<Record<string, string>> = match.groups ?? {};
    // A path that ends in full stops gives them back to the text: `C:\a\b.ts.` is the path and a full stop.
    const text = groups.win !== undefined ? match[0].replace(/\.+$/, '') : match[0];
    if (text === '') {
      SCANNER.lastIndex = start + 1;
      continue;
    }
    SCANNER.lastIndex = start + text.length;
    push(out, 'text', line.slice(cursor, start));
    cursor = start + text.length;

    if (groups.timestamp !== undefined || groups.jsontime !== undefined) {
      push(out, 'timestamp', text);
    } else if (groups.url !== undefined) {
      push(out, 'url', text);
    } else if (groups.jsonlevel !== undefined) {
      // The value of a JSON "level": a number (pino) or a string. Other values keep their own kind.
      const level = levelOf(text);
      if (level !== null) pushLevel(out, text, level);
      else push(out, text.startsWith('"') ? 'string' : 'number', text);
    } else if (groups.kvlevel !== undefined) {
      const level = levelOf(text);
      if (level !== null) pushLevel(out, text, level);
      else push(out, 'text', text);
    } else if (groups.dquote !== undefined) {
      // A quoted text followed by a colon is a JSON key; any other quoted text is a string value.
      COLON_AHEAD.lastIndex = cursor;
      if (COLON_AHEAD.test(line)) push(out, 'key', text);
      else pushStringBody(out, text);
    } else if (groups.squote !== undefined) {
      pushStringBody(out, text);
    } else if (groups.kv !== undefined) {
      push(out, 'key', text.slice(0, -1));
      push(out, 'punctuation', '=');
    } else if (groups.win !== undefined || groups.posix !== undefined) {
      push(out, 'path', text);
    } else if (groups.bracket !== undefined) {
      const level = levelOf(text);
      if (level !== null) pushLevel(out, text, level);
      else push(out, 'text', text);
    } else if (groups.word !== undefined) {
      const level = start === leadEnd ? levelOf(text) : null;
      if (level !== null) pushLevel(out, text, level);
      else push(out, 'text', text);
    } else if (groups.number !== undefined) {
      push(out, 'number', text);
    } else {
      push(out, 'punctuation', text);
    }
  }
  push(out, 'text', line.slice(cursor));
}

/** The level of the first token that names one; without such a token, the keyword rule. */
function lineLevel(tokens: readonly LogToken[], line: string): LogLevel {
  for (const token of tokens) {
    if (token.kind === 'level') return token.level;
  }
  if (ERROR_WORD.test(line)) return 'error';
  if (WARN_WORD.test(line)) return 'warn';
  return 'info';
}

/** The tokens of one log line and its level. Pure: the same line always gives the same answer. */
export function analyzeLogLine(line: string): AnalyzedLogLine {
  const tokens: LogToken[] = [];
  const leadEnd = LEAD.exec(line)?.[0].length ?? 0;
  const frame = FRAME.exec(line);
  let from = 0;
  if (frame !== null) {
    const indent = frame[1] ?? '';
    push(tokens, 'text', indent);
    push(tokens, 'frame', 'at');
    from = indent.length + 2;
  }
  scan(line, from, leadEnd, tokens);
  return { tokens, level: lineLevel(tokens, line) };
}
