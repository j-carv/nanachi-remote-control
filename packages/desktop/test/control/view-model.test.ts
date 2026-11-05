import { describe, expect, it } from 'vitest';
import type { DaemonStatus, TailscaleStatus } from '../../src/common/types.js';
import { calmErrorHint, errorMessage, errorTitle, isCalmError, toControlError } from '../../src/control/lib/errors.js';
import { classifyLogLine, isNearBottom, sameLines } from '../../src/control/lib/logs.js';
import { isSidebarToggle, sectionForShortcut } from '../../src/control/lib/shortcuts.js';
import { daemonSummary, tailscaleSummary } from '../../src/control/lib/status.js';
import { controlT } from './translator.js';

const t = controlT('pt-BR');

const daemon = (extra: Partial<DaemonStatus>): DaemonStatus => ({
  state: 'running',
  port: 7780,
  mode: 'spawned',
  pid: 100,
  version: '0.0.0',
  machineName: 'PC',
  restricted: false,
  message: null,
  logTail: [],
  ...extra,
});

describe('daemonSummary', () => {
  it.each([
    ['running', 'Rodando', 'success', false],
    ['attached', 'Conectado', 'running', false],
    ['starting', 'Iniciando', 'attention', true],
    ['stopped', 'Parado', 'muted', false],
    ['error', 'Erro', 'destructive', false],
  ] as const)('%s', (state, word, tone, pulse) => {
    const summary = daemonSummary(daemon({ state }), t);
    expect(summary.word).toBe(word);
    expect(summary.tone).toBe(tone);
    expect(summary.pulse).toBe(pulse);
  });

  it('describes who owns the process', () => {
    expect(daemonSummary(daemon({ state: 'attached', mode: 'attached' }), t).detail).toContain('já estava rodando');
    expect(daemonSummary(daemon({ state: 'running' }), t).detail).toContain('iniciado pelo Nanachi');
  });

  it('a restricted daemon is flagged as attention even when running', () => {
    expect(daemonSummary(daemon({ restricted: true }), t).tone).toBe('attention');
  });
});

describe('tailscaleSummary', () => {
  it.each([
    [{ state: 'off' }, 'Desligado', 'muted', false],
    [{ state: 'starting' }, 'Iniciando', 'attention', true],
    [{ state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' }, 'Precisa entrar', 'attention', false],
    [{ state: 'running', dnsName: 'a.ts.net', tailnet: 't', ips: [] }, 'Ligado', 'success', false],
    [{ state: 'error', message: 'x' }, 'Erro', 'destructive', false],
  ] as Array<[TailscaleStatus, string, string, boolean]>)('%j', (status, word, tone, pulse) => {
    const summary = tailscaleSummary(status, t);
    expect(summary.word).toBe(word);
    expect(summary.tone).toBe(tone);
    expect(summary.pulse).toBe(pulse);
  });
});

describe('errors', () => {
  it('maps every ControlError code to a short Portuguese title', () => {
    for (const code of ['daemon_unavailable', 'not_paired', 'unauthorized', 'invalid_input', 'io', 'not_own_daemon', 'unknown'] as const) {
      expect(errorTitle(code, t).length).toBeGreaterThan(5);
    }
    expect(errorTitle('daemon_unavailable', t)).toBe('O daemon não está respondendo');
  });

  it('a rejected IPC call becomes an unknown ControlError without leaking the raw message', () => {
    const error = toControlError(new Error('Error invoking remote method: boom'));
    // Born in the page, so it carries no message of main: the text is worded in the language on screen when it is shown.
    expect(error).toEqual({ ok: false, code: 'unknown', message: '' });
    expect(errorMessage(error, t)).toBe('Não foi possível falar com o Nanachi. Tente de novo.');
    expect(errorMessage(error, controlT('en'))).toBe('Could not talk to Nanachi. Try again.');
    expect(errorMessage(error, controlT('es'))).toBe('No se pudo comunicar con Nanachi. Intenta de nuevo.');
  });

  it('a message of main is shown as it is, in any language', () => {
    const fromMain = { ok: false, code: 'daemon_unavailable', message: 'O daemon não respondeu.' } as const;
    expect(errorMessage(fromMain, t)).toBe('O daemon não respondeu.');
    expect(errorMessage(fromMain, controlT('en'))).toBe('O daemon não respondeu.');
  });
});

describe('calm errors (attached to a daemon Desktop did not start)', () => {
  it('not paired, unauthorized and not-own-daemon are expected there, not failures', () => {
    expect(isCalmError('not_paired')).toBe(true);
    expect(isCalmError('unauthorized')).toBe(true);
    expect(isCalmError('not_own_daemon')).toBe(true);
    expect(isCalmError('daemon_unavailable')).toBe(false);
    expect(isCalmError('io')).toBe(false);
    expect(isCalmError('unknown')).toBe(false);
  });

  it('they come with one reassuring line that the rest of the panel keeps working', () => {
    expect(calmErrorHint(t)).toContain('não iniciou');
    expect(calmErrorHint(t)).toContain('o resto do painel continua funcionando');
  });
});

describe('logs', () => {
  it('isNearBottom keeps following until the user scrolls up by more than the threshold', () => {
    expect(isNearBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 880, clientHeight: 100, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 700, clientHeight: 100, scrollHeight: 1000 })).toBe(false);
  });

  it('a log that fits without scrolling counts as at the bottom', () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 })).toBe(true);
  });

  it('classifyLogLine highlights only clear error and warning markers', () => {
    expect(classifyLogLine('2026-11-05T10:00:00Z ERROR something broke')).toBe('error');
    expect(classifyLogLine('Uncaught Exception: x')).toBe('error');
    expect(classifyLogLine('[warn] disk almost full')).toBe('warn');
    expect(classifyLogLine('daemon listening on 127.0.0.1:7780')).toBe('info');
    expect(classifyLogLine('terror management')).toBe('info');
  });

  it('sameLines compares content, not identity', () => {
    expect(sameLines(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameLines(['a', 'b'], ['a'])).toBe(false);
    expect(sameLines(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('shortcuts', () => {
  const key = (
    k: string,
    extra: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {},
  ): { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean } => ({
    key: k,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...extra,
  });

  it('Ctrl+1..8 select the sections in sidebar order, Ctrl+8 being the sessions', () => {
    expect(sectionForShortcut(key('1'))).toBe('overview');
    expect(sectionForShortcut(key('2'))).toBe('folders');
    expect(sectionForShortcut(key('7'))).toBe('settings');
    expect(sectionForShortcut(key('8'))).toBe('sessions');
  });

  it('ignores other digits and modified combinations', () => {
    expect(sectionForShortcut(key('9'))).toBeNull();
    expect(sectionForShortcut(key('0'))).toBeNull();
    expect(sectionForShortcut(key('1', { ctrlKey: false }))).toBeNull();
    expect(sectionForShortcut(key('1', { altKey: true }))).toBeNull();
    expect(sectionForShortcut(key('1', { shiftKey: true }))).toBeNull();
  });

  it('Ctrl+B toggles the sidebar, in either case', () => {
    expect(isSidebarToggle(key('b'))).toBe(true);
    expect(isSidebarToggle(key('B'))).toBe(true);
    expect(isSidebarToggle(key('b', { ctrlKey: false }))).toBe(false);
    expect(isSidebarToggle(key('b', { shiftKey: true }))).toBe(false);
  });
});
