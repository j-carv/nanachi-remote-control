import {
  LOOP_DYNAMIC_DEFAULT_MS,
  LOOP_INTERVAL_MAX_MS,
  LOOP_INTERVAL_MIN_MS,
  LOOP_PROMPT_MAX,
  parseLoopDuration,
  type Loop,
  type LoopMode,
  type LoopRequest,
} from '@nanachi/shared';
import { t } from '../i18n/index.js';
import { durationInputOf, durationLabel } from './loop.js';

/** Interval presets: 1 min, 5 min, 15 min, 30 min, 1 h. */
export const LOOP_PRESETS_MS: readonly number[] = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];

/** The sheet's field values. All text, as typed; validation lives in `loopRequestFrom`. */
export interface LoopFormValues {
  prompt: string;
  mode: LoopMode;
  /** Interval text (`5m`, `90s`, `1h30m`). Only used in `interval` mode. */
  interval: string;
  /** Round limit; empty means no limit. */
  rounds: string;
  runNow: boolean;
}

export type IntervalParse = { ok: true; intervalMs: number } | { ok: false; message: string };

export function parseIntervalText(text: string): IntervalParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: t('chat:loop.form.intervalEmpty') };
  const ms = parseLoopDuration(trimmed);
  if (ms === undefined) return { ok: false, message: t('chat:loop.form.intervalFormat') };
  if (ms < LOOP_INTERVAL_MIN_MS || ms > LOOP_INTERVAL_MAX_MS) {
    return { ok: false, message: t('chat:loop.form.intervalRange') };
  }
  return { ok: true, intervalMs: ms };
}

export type LoopFormResult = { ok: true; request: LoopRequest } | { ok: false; message: string };

/** The API request for the sheet's values, or the message of the first invalid field. */
export function loopRequestFrom(values: LoopFormValues): LoopFormResult {
  const prompt = values.prompt.trim();
  if (prompt === '') return { ok: false, message: t('chat:loop.form.promptEmpty') };
  if (prompt.length > LOOP_PROMPT_MAX) {
    return { ok: false, message: t('chat:loop.form.promptTooLong', { max: LOOP_PROMPT_MAX }) };
  }

  const rounds = values.rounds.trim();
  let maxIterations: number | undefined;
  if (rounds !== '') {
    const count = Number(rounds);
    if (!/^\d+$/.test(rounds) || !Number.isSafeInteger(count) || count < 1) {
      return { ok: false, message: t('chat:loop.form.roundsInvalid') };
    }
    maxIterations = count;
  }

  if (values.mode === 'dynamic') {
    return {
      ok: true,
      request: {
        prompt,
        mode: 'dynamic',
        runNow: values.runNow,
        ...(maxIterations === undefined ? {} : { maxIterations }),
      },
    };
  }
  const interval = parseIntervalText(values.interval);
  if (!interval.ok) return interval;
  return {
    ok: true,
    request: {
      prompt,
      mode: 'interval',
      intervalMs: interval.intervalMs,
      runNow: values.runNow,
      ...(maxIterations === undefined ? {} : { maxIterations }),
    },
  };
}

/**
 * The same loop written as a Claude command (`/loop 5m prompt`), to send as an ordinary prompt. Undefined when there
 * is no prompt or the interval is not valid.
 */
export function nativeLoopCommand(values: LoopFormValues): string | undefined {
  const prompt = values.prompt.trim();
  if (prompt === '') return undefined;
  if (values.mode === 'dynamic') return `/loop ${prompt}`;
  const interval = parseIntervalText(values.interval);
  if (!interval.ok) return undefined;
  return `/loop ${values.interval.trim()} ${prompt}`;
}

/**
 * Starting values for the sheet. No loop: fixed 5 min interval, run-now on. With a loop: what it is doing now; saving
 * does not run a round by default.
 */
export function formValuesOf(loop: Loop | null): LoopFormValues {
  if (loop === null) return { prompt: '', mode: 'interval', interval: '5m', rounds: '', runNow: true };
  return {
    prompt: loop.prompt,
    mode: loop.mode,
    interval: loop.intervalMs === null ? '5m' : durationInputOf(loop.intervalMs),
    rounds: loop.maxIterations === null ? '' : String(loop.maxIterations),
    runNow: false,
  };
}

/** Longest prompt the live summary quotes. Longer prompts end in an ellipsis. */
const SUMMARY_PROMPT_MAX = 60;

/** The prompt as the summary quotes it: one line, at most `SUMMARY_PROMPT_MAX` characters, in typographic quotes. */
function quotedPromptOf(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ');
  const short = oneLine.length > SUMMARY_PROMPT_MAX ? `${oneLine.slice(0, SUMMARY_PROMPT_MAX - 1).trimEnd()}…` : oneLine;
  return `“${short}”`;
}

/**
 * The live sentence under the form: what the loop will do with the current values. Built from the validated request,
 * so it only exists while the form is valid (undefined otherwise).
 */
export function loopSummaryText(values: LoopFormValues): string | undefined {
  const checked = loopRequestFrom(values);
  if (!checked.ok) return undefined;
  const { request } = checked;
  const prompt = quotedPromptOf(request.prompt);
  const limit = request.maxIterations;

  if (request.mode === 'interval' && request.intervalMs !== undefined) {
    const every = durationLabel(request.intervalMs);
    const first =
      request.runNow === false ? t('chat:loop.summary.intervalLater', { time: every }) : t('chat:loop.summary.intervalNow');
    const limitText =
      limit === undefined ? t('chat:loop.summary.noLimit') : t('chat:loop.summary.upTo', { count: limit });
    return t('chat:loop.summary.interval', { prompt, first, every, limit: limitText });
  }

  const first =
    request.runNow === false
      ? t('chat:loop.summary.dynamicLater', { time: durationLabel(LOOP_DYNAMIC_DEFAULT_MS) })
      : t('chat:loop.summary.dynamicNow');
  const stop =
    limit === undefined
      ? t('chat:loop.summary.untilDone')
      : t('chat:loop.summary.untilDoneOrUpTo', { count: limit });
  return t('chat:loop.summary.dynamic', { prompt, first, stop });
}

/** Helper text under "Primeira rodada agora": when the first round runs if the switch is off. */
export function firstRoundHelpText(mode: LoopMode): string {
  if (mode === 'dynamic') return t('chat:loop.form.firstRoundDynamic', { time: durationLabel(LOOP_DYNAMIC_DEFAULT_MS) });
  return t('chat:loop.form.firstRoundInterval');
}
