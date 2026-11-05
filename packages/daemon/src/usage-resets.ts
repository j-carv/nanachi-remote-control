import type { ResetEntry, ResetRedeemResponse } from '@nanachi/shared';
import type { CodexConsumeOutcome } from './codex-app-server.js';

/*
 * Rate-limit resets: pure parsing, validation and mapping (docs/PLAN.md, "rate-limit resets in the usage drawer").
 * No I/O here. omp answers `/usage reset` as text on the usage probe (usage-probe.ts); codex answers over its
 * app-server (codex-app-server.ts). The formats below are the ones the contract records for omp 18.13.2 and codex.
 */

/** Texto do comando que lista os resets salvos no omp. */
export const OMP_RESET_LIST_COMMAND = '/usage reset';

/** Alvo que o codex aceita sem id: o backend escolhe o próximo crédito. */
export const NEXT_CREDIT_TARGET = 'next';

/** Teto do texto de mensagem que volta no corpo do POST (omp). */
const REDEEM_MESSAGE_MAX = 500;

/** Provedores com reset no omp (anthropic: sessão de 5 h; openai-codex). */
const OMP_REDEEM_TARGET = /^(anthropic|openai-codex)\/(\d+|active)$/;

/** Remove sequências ANSI (cor, negrito, movimento de cursor). O texto que sobra é o do agente. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Fonte de resets de um agente: omp (texto no probe) ou codex (app-server). Outro agente não tem. */
export type ResetSource = 'omp' | 'codex';

/** Fonte de resets do agente pelo id do config, ou undefined (claude, agy, shell e ids desconhecidos). */
export function resetSourceOf(agentId: string): ResetSource | undefined {
  if (agentId === 'omp') return 'omp';
  if (agentId === 'codex') return 'codex';
  return undefined;
}

export interface ParsedResets {
  entries: ResetEntry[];
  /** Primeira linha não vazia quando não há entradas (ex.: "No provider accounts found..."). */
  message: string | null;
}

/**
 * Linha de conta: `- <label> [<providerLabel> · <provider>/<credentialId>]: <resto>`. O label pode ter " · org";
 * o provedor e o id são o último par dentro dos colchetes.
 */
const ACCOUNT_LINE = /^- (.+?) \[([^\]]*?) · ([^/\]\s]+)\/([^\]\s]+)\]: (.+)$/;
const ACTIVE_SUFFIX = / \(active\)$/;
const UNAVAILABLE = /^unavailable \((.+)\)$/;
/** `<A> saved, <U> usable now` and whatever follows it (the tail, see `parseTail`). */
const AVAILABLE = /^(\d+) saved, (\d+) usable now(.*)$/;
const EXPIRES_PREFIX = ', expires ';
/**
 * A time zone as omp prints it after a date: UTC, GMT, Z with an optional offset (GMT-3, UTC+02:00), an abbreviation
 * ending in T (PST, CEST), or a bare offset (+02:00, -0300).
 */
const TIME_ZONE = /^(?:(?:UTC|GMT|Z)(?:[+-]\d{1,2}(?::?\d{2})?)?|[A-Z]{2,4}T|[+-]\d{2}:?\d{2})$/;

/** Lê a listagem de `/usage reset` do omp (ANSI já removido aqui). Linhas que não casam são ignoradas. */
export function parseOmpResetList(reply: string): ParsedResets {
  const lines = stripAnsi(reply)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const entries: ResetEntry[] = [];
  for (const line of lines) {
    const entry = parseAccountLine(line);
    if (entry !== undefined) entries.push(entry);
  }
  if (entries.length > 0) return { entries, message: null };
  const firstLine = lines.find((line) => line.length > 0);
  return { entries, message: firstLine ?? null };
}

function parseAccountLine(line: string): ResetEntry | undefined {
  const match = ACCOUNT_LINE.exec(line);
  if (match === null) return undefined;
  const [, accountLabel = '', providerLabel = '', provider = '', credentialId = '', rest = ''] = match;
  const active = ACTIVE_SUFFIX.test(rest);
  const body = rest.replace(ACTIVE_SUFFIX, '');
  const target = `${provider}/${credentialId}`;

  const unavailable = UNAVAILABLE.exec(body);
  if (unavailable !== null) {
    return {
      target,
      accountLabel,
      providerLabel: providerLabel || null,
      available: 0,
      usable: 0,
      expiresAt: null,
      note: unavailable[1] ?? null,
      active,
    };
  }

  const counts = AVAILABLE.exec(body);
  if (counts === null) return undefined;
  const [, available = '0', usable = '0', rawTail = ''] = counts;
  const tail = parseTail(rawTail);
  if (tail === undefined) return undefined;
  return {
    target,
    accountLabel,
    providerLabel: providerLabel || null,
    available: Number(available),
    usable: Number(usable),
    expiresAt: tail.expiresAt,
    note: tail.note,
    active,
  };
}

interface Tail {
  expiresAt: string | null;
  note: string | null;
}

/**
 * What follows `<U> usable now` (the `(active)` marker is already off): nothing, `, expires <when>`, ` (<reason>)`, or
 * both. Reasons and expiries may hold parentheses of their own (`(cooldown (5h))`, `Nov 6 (UTC)`), so the groups are
 * read by depth from the end, never with a character class. The rule:
 *  - the reason is the last balanced group;
 *  - except that a lone group right after `expires <text>` belongs to the expiry when it reads as a time zone
 *    (`expires Nov 6 (UTC)`); a second group after it is always the reason (`expires Nov 6 (UTC) (blocked (429))`);
 *  - without `expires`, the group is the reason, whatever it holds.
 * Only a tail that starts with neither `, expires ` nor ` (` is refused. Unbalanced or odd text still keeps the row.
 */
function parseTail(tail: string): Tail | undefined {
  if (tail === '') return { expiresAt: null, note: null };
  const hasExpiry = tail.startsWith(EXPIRES_PREFIX);
  if (!hasExpiry && !tail.startsWith(' (')) return undefined;
  const rest = (hasExpiry ? tail.slice(EXPIRES_PREFIX.length) : tail).trim();

  const start = trailingGroupStart(rest);
  if (start < 0) return hasExpiry ? { expiresAt: orNull(rest), note: null } : { expiresAt: null, note: orNull(rest) };

  const before = rest.slice(0, start).trimEnd();
  const reason = rest.slice(start + 1, -1).trim();
  if (!hasExpiry) return { expiresAt: null, note: before === '' ? orNull(reason) : rest };
  if (before === '' || (!before.endsWith(')') && TIME_ZONE.test(reason))) return { expiresAt: rest, note: null };
  return { expiresAt: before, note: orNull(reason) };
}

/** Where the balanced `(...)` group that ends `text` starts, or -1 when `text` does not end in one. */
function trailingGroupStart(text: string): number {
  if (!text.endsWith(')')) return -1;
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === ')') depth += 1;
    if (char === '(') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function orNull(text: string): string | null {
  return text === '' ? null : text;
}

/**
 * Comando de resgate do omp para um alvo da listagem (`<provider>/<credentialId|active>`), ou undefined se o alvo não
 * está no formato. O comando sai só das partes validadas: nenhum texto do cliente entra no prompt.
 */
export function ompRedeemPrompt(target: string): string | undefined {
  const match = OMP_REDEEM_TARGET.exec(target);
  if (match === null) return undefined;
  return `/usage reset ${match[1] ?? ''}/${match[2] ?? ''}`;
}

/** Resultado do resgate do omp a partir da resposta do comando (texto com ANSI). */
export function ompRedeemOutcome(reply: string): ResetRedeemResponse {
  const text = stripAnsi(reply).trim();
  const message = text.slice(0, REDEEM_MESSAGE_MAX);
  if (text.includes('Reset applied')) return { outcome: 'reset', message };
  if (text.includes('already redeemed')) return { outcome: 'already_redeemed', message };
  if (text.includes('no saved resets')) return { outcome: 'no_credit', message };
  if (text.includes('nothing to reset')) return { outcome: 'nothing_to_reset', message };
  return { outcome: 'failed', message };
}

/** Crédito de reset como o app-server do codex o manda (`expiresAt` em segundos). */
export interface CodexResetCredit {
  id: string;
  status: string;
  expiresAt: number | null;
}

/** `rateLimitResetCredits` de `account/rateLimits/read`. `credits: null` = só a contagem é conhecida. */
export interface CodexResetCredits {
  availableCount: number;
  credits: readonly CodexResetCredit[] | null;
}

export interface CodexResetsView {
  entries: ResetEntry[];
  message: string | null;
  /** Ids vistos na listagem: o único conjunto que um resgate com id aceita. */
  knownIds: string[];
}

const CODEX_PROVIDER_LABEL = 'OpenAI Codex';
const CODEX_NO_ACCOUNT_LABEL = 'Conta';
const CODEX_NO_RESETS_MESSAGE = 'Nenhum reset salvo nesta conta';

/**
 * Uma entrada por conta (a conta do codex é a única). Alvo: id do crédito disponível que expira antes; sem id
 * conhecido, `next`. `usable` conta os créditos `available`, ou a contagem quando não há lista de créditos.
 */
export function codexResetsView(email: string | null, credits: CodexResetCredits | null): CodexResetsView {
  if (credits === null) return { entries: [], message: CODEX_NO_RESETS_MESSAGE, knownIds: [] };

  const list = credits.credits;
  const available = list === null ? undefined : list.filter((credit) => credit.status === 'available');
  const usable = available === undefined ? credits.availableCount : available.length;
  const soonest = available === undefined ? undefined : [...available].sort(byExpiry)[0];
  const expiry = available === undefined ? undefined : soonest?.expiresAt;
  const entry: ResetEntry = {
    target: soonest?.id ?? NEXT_CREDIT_TARGET,
    accountLabel: email ?? CODEX_NO_ACCOUNT_LABEL,
    providerLabel: CODEX_PROVIDER_LABEL,
    available: credits.availableCount,
    usable,
    expiresAt: expiry === undefined || expiry === null ? null : new Date(expiry * 1000).toISOString(),
    note: null,
    active: true,
  };
  return {
    entries: [entry],
    message: null,
    // Only an `available` credit is a target worth sending: redeeming, redeemed and unknown ones are not.
    knownIds: (available ?? []).map((credit) => credit.id),
  };
}

/**
 * Resultado do resgate no codex. Os textos são do daemon (o do JSON-RPC vai para o log). `failed` cobre erro
 * JSON-RPC: nada foi confirmado, e o daemon não tenta de novo.
 */
export function codexRedeemResponse(outcome: CodexConsumeOutcome | 'failed'): ResetRedeemResponse {
  switch (outcome) {
    case 'reset':
      return { outcome: 'reset', message: 'Reset aplicado no Codex.' };
    case 'nothingToReset':
      return {
        outcome: 'nothing_to_reset',
        message: 'Nada para resetar agora: os limites não estão restringidos. Nenhum crédito foi gasto.',
      };
    case 'noCredit':
      return { outcome: 'no_credit', message: 'Não há reset salvo para gastar no Codex.' };
    case 'alreadyRedeemed':
      return { outcome: 'already_redeemed', message: 'Esse reset já foi usado.' };
    case 'failed':
      return { outcome: 'failed', message: 'Não foi possível concluir o reset no Codex. Veja o log do daemon.' };
  }
}

function byExpiry(a: CodexResetCredit, b: CodexResetCredit): number {
  return (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY);
}
