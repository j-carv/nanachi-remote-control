import { stripAnsi } from '../chat/ansi.js';

/** One limit window, e.g. "5 horas" at 10% that resets in 2h. Labels are the UI text (Portuguese). */
export interface UsageWindow {
  label: string;
  /** Percentage of the window already used, 0 to 100. `null` when the agent reply has no percentage. */
  usedPercent: number | null;
  /** The agent's own reset text, kept as written ("em 2h", "Nov 4, 12:30 PM GMT-3"). */
  resetsAt?: string;
  /** Id of an entry in `ParsedUsage.accounts`. */
  account?: string;
  /** The window this session is currently drawing on. */
  inUse?: boolean;
}

export interface UsageAccount {
  id: string;
  provider?: string;
  label: string;
  plan?: string;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageSession {
  costUsd?: number;
  tokens?: UsageTokens;
  /** Active time as the agent wrote it, e.g. "14m". */
  durationText?: string;
}

/** A value the agent reported that has no dedicated field (credits, spend, token status). */
export interface UsageExtra {
  label: string;
  value: string;
}

export interface ParsedUsage {
  windows: UsageWindow[];
  accounts: UsageAccount[];
  session?: UsageSession;
  model?: string;
  extras: UsageExtra[];
  /** Text the parser did not understand, as markdown. Shown under "Detalhes". */
  unparsed: string;
}

/** What one agent parser found. `consumed[i]` marks the lines it understood (they are not repeated as unparsed). */
interface Outcome {
  windows: UsageWindow[];
  accounts: UsageAccount[];
  session: UsageSession | undefined;
  model: string | undefined;
  extras: UsageExtra[];
  consumed: boolean[];
}

/**
 * Reads the text of an agent's usage command (`/usage` for claude and omp, `/status` for codex) into windows,
 * accounts and session numbers. Escape codes are removed first. Lines that are not understood stay in
 * `unparsed`; when nothing is understood the whole text is `unparsed` and the rest is empty.
 */
export function parseUsage(agent: string, text: string): ParsedUsage {
  const plain = stripAnsi(text).replace(/\r\n?/g, '\n');
  const lines = plain.split('\n');
  return finish(cleanText(plain), lines, runParser(agent, lines));
}

function runParser(agent: string, lines: readonly string[]): Outcome {
  switch (agent) {
    case 'claude':
      return parseClaude(lines);
    case 'omp':
      return parseOmp(lines);
    case 'codex':
      return parseCodex(lines);
    default:
      return emptyOutcome(lines.length);
  }
}

function emptyOutcome(lineCount: number): Outcome {
  return {
    windows: [],
    accounts: [],
    session: undefined,
    model: undefined,
    extras: [],
    consumed: Array.from({ length: lineCount }, () => false),
  };
}

function finish(text: string, lines: readonly string[], out: Outcome): ParsedUsage {
  const hasData = out.windows.length > 0 || out.session !== undefined || out.model !== undefined || out.extras.length > 0;
  if (!hasData) return { windows: [], accounts: [], extras: [], unparsed: text };

  // Claude and codex report one account per reply: their windows belong to it.
  const only = out.accounts.length === 1 ? out.accounts[0] : undefined;
  if (only !== undefined) {
    for (const item of out.windows) {
      if (item.account === undefined) item.account = only.id;
    }
  }

  const unparsed = cleanText(lines.filter((_, index) => out.consumed[index] !== true).join('\n'));
  return {
    windows: out.windows,
    accounts: out.accounts,
    extras: out.extras,
    ...(out.session !== undefined ? { session: out.session } : {}),
    ...(out.model !== undefined ? { model: out.model } : {}),
    unparsed,
  };
}

/** Trailing spaces off, no runs of blank lines, no outer blank lines. */
function cleanText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes the bold and code markers the agents put around labels and values. */
function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function addAccount(out: Outcome, account: UsageAccount): void {
  if (!out.accounts.some((known) => known.id === account.id)) out.accounts.push(account);
}

function makeAccount(id: string, label: string, provider?: string, plan?: string): UsageAccount {
  const account: UsageAccount = { id, label };
  if (provider !== undefined && provider !== '') account.provider = provider;
  if (plan !== undefined && plan !== '') account.plan = plan;
  return account;
}

function buildWindow(fields: {
  label: string;
  usedPercent: number | null;
  resetsAt?: string | undefined;
  account?: string | undefined;
  inUse?: boolean;
}): UsageWindow {
  const built: UsageWindow = { label: fields.label, usedPercent: fields.usedPercent };
  if (fields.resetsAt !== undefined) built.resetsAt = fields.resetsAt;
  if (fields.account !== undefined) built.account = fields.account;
  if (fields.inUse === true) built.inUse = true;
  return built;
}

/** Percent or money text from a table cell or a value: "$0.42" → 0.42, "1,234" → 1234. */
function parseMoney(text: string): number | null {
  const match = /\$\s*(\d+(?:\.\d+)?)/.exec(text.replace(/,/g, ''));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Token counts as claude prints them: "0", "1.2k", "35.4k", "2.1M". */
function parseTokenCount(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmMbB])?$/.exec(text.trim().replace(/,/g, ''));
  if (match?.[1] === undefined) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === '' ? 1 : unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : null;
  if (scale === null) return null;
  return Math.round(Number(match[1]) * scale);
}

/** Splits the markdown table that starts at `start` into rows of cells, without the separator row. */
function readTable(lines: readonly string[], start: number): { rows: string[][]; next: number } {
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
    const cells = (lines[index] ?? '')
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
    index += 1;
  }
  return { rows, next: index };
}

// ---------- claude: `/usage` (markdown) ----------

/** "5-hour limit — 10% · Resets Nov 4, 12:30 PM", with the percentage or the reset optional. */
const CLAUDE_LIMIT = /^(.+?)\s+—\s+(?:(\d+(?:\.\d+)?)%\s*)?(?:·\s*)?(?:Resets\s+(.+))?$/;

function claudeLabel(raw: string): string {
  if (/^5-hour limit$/i.test(raw)) return '5 horas';
  const weekly = /^Weekly\s*·\s*(.+)$/i.exec(raw);
  if (weekly !== null) {
    const scope = (weekly[1] ?? '').trim();
    return scope.toLowerCase() === 'all models' ? 'Semanal' : `Semanal · ${scope}`;
  }
  return raw;
}

function parseClaude(lines: readonly string[]): Outcome {
  const out = emptyOutcome(lines.length);
  let section: 'root' | 'limits' | 'session' | 'other' = 'root';

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;

    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading !== null) {
      const title = stripMarkdown(heading[1] ?? '');
      if (/^usage$/i.test(title)) {
        out.consumed[index] = true;
      } else if (/^limits$/i.test(title)) {
        section = 'limits';
        out.consumed[index] = true;
      } else if (/^this session$/i.test(title)) {
        section = 'session';
        out.consumed[index] = true;
      } else {
        section = 'other';
      }
      continue;
    }

    if (/^-{3,}$/.test(line)) {
      out.consumed[index] = true;
      continue;
    }

    // The plan line is the only blockquote before the first section ("> Claude team subscription usage").
    if (line.startsWith('>')) {
      if (section === 'root') {
        const label = stripMarkdown(line.slice(1)).replace(/\s+usage$/i, '');
        if (label !== '') {
          addAccount(out, makeAccount('claude', label));
          out.consumed[index] = true;
        }
      }
      continue;
    }

    if (section === 'limits') {
      const text = stripMarkdown(line);
      if (/^[█░▓▒]+$/.test(text)) {
        out.consumed[index] = true;
        continue;
      }
      const limit = CLAUDE_LIMIT.exec(text);
      if (limit !== null) {
        out.windows.push(
          buildWindow({
            label: claudeLabel(limit[1] ?? ''),
            usedPercent: limit[2] === undefined ? null : Number(limit[2]),
            resetsAt: limit[3],
          }),
        );
        out.consumed[index] = true;
      }
      continue;
    }

    if (section === 'session' && line.startsWith('|')) {
      const { rows, next } = readTable(lines, index);
      if (applySessionTable(out, rows)) {
        for (let row = index; row < next; row += 1) out.consumed[row] = true;
      }
      index = next - 1;
    }
  }
  return out;
}

/** Reads the "Cost | API time | Active" and "Breakdown | Tokens" tables. Returns false for any other table. */
function applySessionTable(out: Outcome, rows: readonly string[][]): boolean {
  const header = (rows[0] ?? []).map((cell) => cell.toLowerCase());
  const first = rows[1] ?? [];
  const cell = (name: string): string => first[header.indexOf(name)] ?? '';

  if (header[0] === 'cost') {
    const session: UsageSession = out.session ?? {};
    const cost = parseMoney(cell('cost'));
    const active = cell('active');
    const apiTime = cell('api time');
    if (cost !== null) session.costUsd = cost;
    if (active !== '') session.durationText = active;
    if (apiTime !== '') out.extras.push({ label: 'Tempo de API', value: apiTime });
    out.session = session;
    return true;
  }

  if (header[0] === 'breakdown') {
    const tokens: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const row of rows.slice(1)) {
      const count = parseTokenCount(row[1] ?? '');
      if (count === null) continue;
      const name = (row[0] ?? '').toLowerCase();
      if (name === 'input') tokens.input = count;
      else if (name === 'output') tokens.output = count;
      else if (name === 'cache read') tokens.cacheRead = count;
      else if (name === 'cache write') tokens.cacheWrite = count;
    }
    out.session = { ...(out.session ?? {}), tokens };
    return true;
  }

  return false;
}

// ---------- omp: `/usage` (code block, one block per window) ----------

/** "Cursor Models — Monthly", "5 hours", "7 days": the window headers are the lines that start with "- ". */
function ompLabel(name: string): string {
  const hours = /^(\d+) hours?$/i.exec(name);
  if (hours !== null) return hours[1] === '1' ? '1 hora' : `${hours[1]} horas`;
  const days = /^(\d+) days?$/i.exec(name);
  if (days !== null) return days[1] === '1' ? '1 dia' : `${days[1]} dias`;
  const monthly = /^(.+?) — Monthly$/i.exec(name);
  if (monthly !== null) return `${monthly[1]} · Mensal`;
  return name;
}

/** "<account> · plan: <plan>: 90.00% used (10.0% left)" */
const OMP_PLAN_USAGE = /^(.+?)\s*·\s*plan:\s*([^:]+?):\s*(\d+(?:\.\d+)?)%\s*used\b/;
/** "<account>: 51.36% used (48.6% left)" */
const OMP_USAGE = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used\b/;
/** "<account>: 0.11 usd used (99.5% left)": money, no percentage. */
const OMP_USD = /^(.+?):\s*(\d+(?:\.\d+)?)\s*usd used\b/i;
/** "[████░░░] 51%" with or without the percentage, after the colour codes are gone. */
const OMP_BAR = /^\[[^\]]*\](?:\s*(\d+(?:\.\d+)?)%)?$/;
const OMP_RESETS = /^resets in (.+)$/;
const IN_USE = /in use by this session/i;

interface OmpRow {
  index: number;
  text: string;
}

interface OmpBlock {
  window?: UsageWindow;
  account?: UsageAccount;
  extra?: UsageExtra;
  /** Indexes of the block lines the parser understood (the header is added by the caller). */
  consumed: number[];
}

function readOmpBlock(name: string, provider: string | undefined, rows: readonly OmpRow[]): OmpBlock {
  let usage: { index: number; account: string; plan: string | undefined; usedPercent: number; inUse: boolean } | undefined;
  let usd: { index: number; amount: string } | undefined;
  let bar: { index: number; usedPercent: number | undefined } | undefined;
  let resets: { index: number; text: string } | undefined;

  for (const { index, text } of rows) {
    const planned = OMP_PLAN_USAGE.exec(text);
    const plain = OMP_USAGE.exec(text);
    const money = OMP_USD.exec(text);
    const barMatch = OMP_BAR.exec(text);
    const resetMatch = OMP_RESETS.exec(text);

    if (usage === undefined && planned !== null) {
      const [, account = '', plan = '', percent = ''] = planned;
      usage = {
        index,
        account: account.trim(),
        plan: plan.trim(),
        usedPercent: Number(percent),
        inUse: IN_USE.test(text),
      };
    } else if (usage === undefined && plain !== null) {
      const [, account = '', percent = ''] = plain;
      usage = { index, account: account.trim(), plan: undefined, usedPercent: Number(percent), inUse: IN_USE.test(text) };
    } else if (usd === undefined && money !== null) {
      const [, , amount = ''] = money;
      usd = { index, amount };
    } else if (bar === undefined && barMatch !== null) {
      const [, percent] = barMatch;
      bar = { index, usedPercent: percent === undefined ? undefined : Number(percent) };
    } else if (resets === undefined && resetMatch !== null) {
      const [, resetText = ''] = resetMatch;
      resets = { index, text: resetText.trim() };
    }
  }

  const label = ompLabel(name);
  const resetsAt = resets !== undefined ? `em ${resets.text}` : undefined;
  const consumed = [usage?.index, usd?.index, bar?.index, resets?.index].filter((index): index is number => index !== undefined);

  if (usage !== undefined) {
    const account = makeAccount(`${provider ?? ''}|${usage.account}`, usage.account, provider, usage.plan);
    return {
      window: buildWindow({ label, usedPercent: usage.usedPercent, resetsAt, account: account.id, inUse: usage.inUse }),
      account,
      consumed,
    };
  }
  if (usd !== undefined) {
    return { extra: { label, value: `${usd.amount} USD` }, consumed };
  }
  if (bar?.usedPercent !== undefined) {
    return { window: buildWindow({ label, usedPercent: bar.usedPercent, resetsAt }), consumed };
  }
  return { consumed: [] };
}

function parseOmp(lines: readonly string[]): Outcome {
  const out = emptyOutcome(lines.length);
  let provider: string | undefined;
  let inModelList = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const text = line.trim();
    const indent = line.length - line.trimStart().length;

    if (text === '') {
      inModelList = false;
      continue;
    }
    if (inModelList && indent >= 4) {
      out.consumed[index] = true;
      continue;
    }
    inModelList = false;

    if (text.startsWith('```') || /^Usage\s*\(.*\)$/.test(text)) {
      out.consumed[index] = true;
      continue;
    }
    if (indent === 2 && text === 'Models with usage data') {
      out.consumed[index] = true;
      inModelList = true;
      continue;
    }

    if (indent === 0 && text.startsWith('- ')) {
      const rows: OmpRow[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next] ?? '';
        if (candidate.trim() === '' || !/^\s/.test(candidate)) break;
        rows.push({ index: next, text: candidate.trim() });
      }
      const block = readOmpBlock(text.slice(2).trim(), provider, rows);
      if (block.window !== undefined || block.extra !== undefined) {
        out.consumed[index] = true;
        for (const consumed of block.consumed) out.consumed[consumed] = true;
        if (block.window !== undefined) out.windows.push(block.window);
        if (block.account !== undefined) addAccount(out, block.account);
        if (block.extra !== undefined) out.extras.push(block.extra);
      }
      continue;
    }

    // A line with no indent that is not a window header is the provider name ("Cursor", "Openai Codex").
    if (indent === 0) {
      provider = text;
      out.consumed[index] = true;
    }
  }
  return out;
}

// ---------- codex: `/status` (bold "Key:" lines) ----------

/** "codex 5h limit: 9% left (resets 02:20)", "codex Weekly limit: 86% left (resets 21:20 on Nov 10)" */
const CODEX_LIMIT = /^(?:codex\s+)?(.+?)\s+limit:\s*(\d+(?:\.\d+)?)%\s*(left|used)(?:\s*\(resets\s+(.+)\))?$/i;
/** "ChatGPT plus (user@example.com)" */
const CODEX_ACCOUNT = /^(\S+)\s+(\S+)\s+\((.+)\)$/;

function codexLabel(raw: string): string {
  if (/^5h$/i.test(raw)) return '5 horas';
  if (/^weekly$/i.test(raw)) return 'Semanal';
  return raw;
}

/** codex prints "data not available yet" until the first turn; shown in Portuguese. */
function codexValue(raw: string): string {
  return raw === 'data not available yet' ? 'indisponível' : raw;
}

function parseCodex(lines: readonly string[]): Outcome {
  const out = emptyOutcome(lines.length);

  for (let index = 0; index < lines.length; index += 1) {
    const text = stripMarkdown(lines[index] ?? '');
    if (text === '') continue;

    const model = /^Model:\s*(.+)$/.exec(text);
    if (model !== null) {
      out.model = (model[1] ?? '').trim();
      out.consumed[index] = true;
      continue;
    }
    // Working directory, approval policy, sandbox and session id: not usage, not shown.
    if (/^(Directory|Approval|Sandbox|Session):/.test(text)) {
      out.consumed[index] = true;
      continue;
    }
    const account = /^Account:\s*(.+)$/.exec(text);
    if (account !== null) {
      const value = (account[1] ?? '').trim();
      const parts = CODEX_ACCOUNT.exec(value);
      addAccount(
        out,
        parts === null
          ? makeAccount(value, value)
          : makeAccount(value, parts[3] ?? value, parts[1], parts[2]),
      );
      out.consumed[index] = true;
      continue;
    }
    const extra = /^(?:codex\s+)?(Token usage|Context window|Credits):\s*(.+)$/i.exec(text);
    if (extra !== null) {
      const names: Record<string, string> = { 'token usage': 'Tokens', 'context window': 'Janela de contexto', credits: 'Créditos' };
      const label = names[(extra[1] ?? '').toLowerCase()];
      if (label !== undefined) out.extras.push({ label, value: codexValue((extra[2] ?? '').trim()) });
      out.consumed[index] = true;
      continue;
    }
    const limit = CODEX_LIMIT.exec(text);
    if (limit !== null) {
      const value = Number(limit[2]);
      const usedPercent = (limit[3] ?? '').toLowerCase() === 'left' ? 100 - value : value;
      out.windows.push(buildWindow({ label: codexLabel(limit[1] ?? ''), usedPercent, resetsAt: limit[4] }));
      out.consumed[index] = true;
    }
  }
  return out;
}
