// Fake `codex app-server` for the daemon tests (line-delimited JSON-RPC without the `jsonrpc` field).
// Used through CODEX_PATH in the codex agent's env: the daemon runs a .mjs path with node (codex-app-server.ts).
// It never talks to OpenAI, so a consume here spends nothing.
//
// Env (set by the test):
//  - FAKE_CODEX_RECORD=<file>: every received message is appended to it as one JSON line.
//  - FAKE_CODEX_PID_FILE=<file>: the pid of this process is written there at start.
//  - FAKE_CODEX_ENV_FILE=<file>: at start, one JSON line { CODEX_HOME } (null when unset) is appended there: which
//    account home this process got.
//  - FAKE_CODEX_CREDITS=ids (default) | renewed | null | none | error | hang: what account/rateLimits/read answers.
//    renewed = another list (one available credit, credit-4), to tell a later read from an earlier one;
//    null = the credit list is null (only the count is known); none = rateLimitResetCredits itself is null.
//  - FAKE_CODEX_RATE_LIMITS_GATE=<file>: account/rateLimits/read is held until that file exists (the test creates it
//    to release the answer: an ordering without sleeps).
//  - FAKE_CODEX_CONSUME=ok (default) | already | error | hang | weird: what account/rateLimitResetCredit/consume
//    answers. already = alreadyRedeemed for any credit.
//  - FAKE_CODEX_EXIT_ON=<method>: exit without answering when that method arrives.
//  - FAKE_CODEX_EXIT_AFTER=<method>: answer that method, then exit right away (the answer may still be in the pipe).
// Consume outcomes by creditId: credit-2 -> reset, credit-1 -> noCredit, no creditId (next) -> nothingToReset,
// any other id -> alreadyRedeemed.

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const recordFile = process.env.FAKE_CODEX_RECORD;
const pidFile = process.env.FAKE_CODEX_PID_FILE;
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
const envFile = process.env.FAKE_CODEX_ENV_FILE;
if (envFile !== undefined) {
  appendFileSync(envFile, `${JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME ?? null })}\n`);
}

const credits = process.env.FAKE_CODEX_CREDITS ?? 'ids';
const consume = process.env.FAKE_CODEX_CONSUME ?? 'ok';
const exitOn = process.env.FAKE_CODEX_EXIT_ON;
const exitAfter = process.env.FAKE_CODEX_EXIT_AFTER;
const gateFile = process.env.FAKE_CODEX_RATE_LIMITS_GATE;

const RATE_LIMITS = {
  rateLimits: { primary: null, secondary: null },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      { id: 'credit-1', resetType: 'session', status: 'available', grantedAt: 1_700_000_000, expiresAt: 1_800_000_000, title: null, description: null },
      { id: 'credit-2', resetType: 'session', status: 'available', grantedAt: 1_700_000_000, expiresAt: 1_750_000_000, title: null, description: null },
      { id: 'credit-3', resetType: 'session', status: 'redeemed', grantedAt: 1_690_000_000, expiresAt: null, title: null, description: null },
    ],
  },
};

const RENEWED_LIMITS = {
  rateLimits: { primary: null, secondary: null },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      { id: 'credit-4', resetType: 'session', status: 'available', grantedAt: 1_710_000_000, expiresAt: 1_760_000_000, title: null, description: null },
    ],
  },
};

const OUTCOME_BY_CREDIT = { 'credit-2': 'reset', 'credit-1': 'noCredit' };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32000, message } });
}

function answerRateLimits(id) {
  if (credits === 'hang') return;
  if (credits === 'error') return fail(id, 'backend exploded: fixture-only detail');
  if (credits === 'none') return reply(id, { rateLimits: RATE_LIMITS.rateLimits, rateLimitResetCredits: null });
  if (credits === 'null') {
    return reply(id, {
      rateLimits: RATE_LIMITS.rateLimits,
      rateLimitResetCredits: { availableCount: 2, credits: null },
    });
  }
  if (credits === 'renewed') return reply(id, RENEWED_LIMITS);
  return reply(id, RATE_LIMITS);
}

function handle(message) {
  if (recordFile !== undefined) appendFileSync(recordFile, `${JSON.stringify(message)}\n`);
  const { method } = message;
  if (exitOn === method) process.exit(9);
  handleMethod(message);
  // The empty write completes after the answer above: the exit comes with the answer still in the pipe.
  if (exitAfter === method) process.stdout.write('', () => process.exit(0));
}

function handleMethod(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      reply(id, { userAgent: 'fake-codex-app-server', codexHome: '', platformFamily: 'windows', platformOs: 'windows' });
      return;
    case 'initialized':
      return;
    case 'account/read':
      reply(id, {
        account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus' },
        requiresOpenaiAuth: false,
      });
      return;
    case 'account/rateLimits/read':
      if (gateFile !== undefined) {
        // Held until the test creates the file; the answer is built when the gate opens.
        const gate = setInterval(() => {
          if (!existsSync(gateFile)) return;
          clearInterval(gate);
          answerRateLimits(id);
        }, 20);
        return;
      }
      answerRateLimits(id);
      return;
    case 'account/rateLimitResetCredit/consume': {
      if (consume === 'hang') return;
      if (consume === 'already') return reply(id, { outcome: 'alreadyRedeemed' });
      if (consume === 'error') return fail(id, 'consume exploded: fixture-only detail');
      if (consume === 'weird') return reply(id, { outcome: 'somethingNew' });
      const creditId = typeof params?.creditId === 'string' ? params.creditId : undefined;
      const outcome =
        creditId === undefined ? 'nothingToReset' : (OUTCOME_BY_CREDIT[creditId] ?? 'alreadyRedeemed');
      reply(id, { outcome });
      return;
    }
    default:
      // Anything else (thread/turn, ...) is a bug in the client: say so loudly.
      if (id !== undefined) fail(id, `fixture does not serve ${String(method)}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim().length === 0) return;
  handle(JSON.parse(line));
});
lines.on('close', () => process.exit(0));
