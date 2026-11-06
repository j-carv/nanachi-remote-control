import type { Loop } from '@nanachi/shared';
import { t } from '../i18n/index.js';

/**
 * Display helpers for Loop mode (no React): the header chip, the sheet and the duration text. Times come in as
 * parameters (`now`), so tests do not depend on the clock. UI texts come from the `chat` namespace; durations (`30 s`,
 * `5 min`, `1 h`) read the same in both languages.
 */

/** Countdown text: seconds under a minute, minutes under an hour, then hours. Rounds up. */
export function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(ms, 0) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Exact interval text for presets and the sheet: `1 h 30 min`, `1 min 30 s`, `30 s`. */
export function durationLabel(ms: number): string {
  if (ms < 60_000) return `${ms / 1000} s`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = (ms % 60_000) / 1000;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0) parts.push(`${seconds} s`);
  return parts.join(' ');
}

/** Text the interval field shows for a value in ms. `parseLoopDuration` reads it back. */
export function durationInputOf(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return [hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', seconds > 0 ? `${seconds}s` : ''].join('');
}

/**
 * Which loop state to keep when a snapshot arrives. Snapshots come from the WS `loop` message, from the GET and from
 * the reply of each loop action; the HTTP reply can arrive after a newer WS message, so the higher `revision` wins.
 * `null` (the loop was deleted) always applies: a later loop has a higher revision than anything before it.
 */
export function pickLoop(current: Loop | null, incoming: Loop | null): Loop | null {
  if (incoming === null) return null;
  if (current === null || incoming.revision >= current.revision) return incoming;
  return current;
}

/** Phase the chip shows. `error`: paused after a failure, with `lastError` set. */
export type LoopPhase = 'countdown' | 'running' | 'queued' | 'paused' | 'error';

export interface LoopChipView {
  phase: LoopPhase;
  /** Full text (wide screens). */
  label: string;
  /** Shorter text for 320 px screens. Same as `label` when there is no shorter form. */
  short: string;
}

/** What the header chip shows, or undefined when there is no chip (no loop, or a stopped one). */
export function loopChipView(loop: Loop | null, now: number): LoopChipView | undefined {
  if (loop === null || loop.state === 'stopped') return undefined;
  if (loop.state === 'paused') {
    if (loop.lastError !== null) {
      const text = t('chat:loop.chip.error');
      return { phase: 'error', label: text, short: text };
    }
    const text = t('chat:loop.chip.paused');
    return { phase: 'paused', label: text, short: text };
  }
  // Active with no next run: a loop round is in flight (the daemon clears nextRunAt while it runs).
  if (loop.nextRunAt === null) {
    const text = t('chat:loop.chip.running');
    return { phase: 'running', label: text, short: text };
  }
  const remaining = loop.nextRunAt - now;
  // Past due but not started yet: the agent is busy, so the round waits.
  if (remaining <= 0) {
    const text = t('chat:loop.chip.queued');
    return { phase: 'queued', label: text, short: text };
  }
  const time = formatCountdown(remaining);
  return {
    phase: 'countdown',
    label: t('chat:loop.chip.countdown', { time }),
    short: t('chat:loop.chip.countdownShort', { time }),
  };
}

/** Loop state in words, at the top of the sheet. */
export function loopStatusText(loop: Loop, now: number): string {
  if (loop.state === 'stopped') return t('chat:loop.status.stopped');
  if (loop.state === 'paused') {
    return loop.lastError === null ? t('chat:loop.status.paused') : t('chat:loop.status.pausedError');
  }
  if (loop.nextRunAt === null) return t('chat:loop.status.running');
  const remaining = loop.nextRunAt - now;
  if (remaining <= 0) return t('chat:loop.status.queued');
  return t('chat:loop.status.next', { time: formatCountdown(remaining) });
}

/**
 * The Modo Loop row of the "..." menu: "Ativo", or why the loop is paused. Undefined without a running or paused loop.
 * It has no countdown: the menu does not tick, and the Loop sheet shows the time.
 */
export function loopMenuDetail(loop: Loop | null): string | undefined {
  if (loop === null || loop.state === 'stopped') return undefined;
  if (loop.state === 'paused') return loop.lastError === null ? t('chat:loop.status.paused') : t('chat:loop.status.pausedError');
  return t('chat:loop.status.active');
}

/** Round count for the sheet: `Rodadas: 2 de 5` / `Rounds: 2 of 5`. */
export function loopRoundsText(loop: Loop): string {
  if (loop.iterations === 0) return t('chat:loop.rounds.none');
  if (loop.maxIterations === null) return t('chat:loop.rounds.count', { count: loop.iterations });
  return t('chat:loop.rounds.countOf', { count: loop.iterations, limit: loop.maxIterations });
}
