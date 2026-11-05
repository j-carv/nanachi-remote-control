import { describe, expect, it } from 'vitest';
import { CONTROL_SECTIONS } from '../../src/common/control-api.js';
import type { DaemonStatus } from '../../src/common/types.js';
import { initialSection, sessionsState, sessionsViewWanted } from '../../src/control/lib/sessions.js';
import { acquireOverlay, overlayActive } from '../../src/control/state/overlay.js';
import { sameViewport, viewportOf } from '../../src/control/state/sessions-viewport.js';
import { holdToasts, toastsHeld } from '../../src/control/state/toast-hold.js';
import { ToastStack } from '../../src/control/ui/Toast.js';
import { decideSessionsView } from '../../src/main/sessions-viewport.js';
import { SessionsStage, SessionsUnavailable } from '../../src/control/sections/SessionsSection.js';
import { createElement } from 'react';
import { html } from './render-helpers.js';

function daemon(patch: Partial<DaemonStatus> = {}): DaemonStatus {
  return { state: 'running', port: 7780, mode: 'spawned', pid: 1, version: '0.1.0', machineName: 'PC', restricted: false, message: null, logTail: [], ...patch };
}

describe('the sessions section is the eighth, after the settings', () => {
  it('is last in the sidebar order and answers Ctrl+8', () => {
    expect(CONTROL_SECTIONS).toHaveLength(8);
    expect(CONTROL_SECTIONS[7]).toBe('sessions');
    expect(CONTROL_SECTIONS[6]).toBe('settings');
  });

  it('a window opened for it starts on it; anything else starts on the overview', () => {
    expect(initialSection('?section=sessions')).toBe('sessions');
    expect(initialSection('?mock=1&section=logs')).toBe('logs');
    for (const search of ['', '?section=', '?section=nope', '?section=SESSIONS', '?section=sessions%20', '?x=sessions']) {
      expect(initialSection(search), search).toBe('overview');
    }
  });
});

describe('what the sessions section shows for each daemon state', () => {
  it('is the PWA only while the daemon is ready', () => {
    expect(sessionsState(daemon())).toBe('ready');
    expect(sessionsState(daemon({ state: 'attached', mode: 'attached' }))).toBe('ready');
  });

  it('is the control center\'s own explanation otherwise', () => {
    expect(sessionsState(null)).toBe('starting');
    expect(sessionsState(daemon({ state: 'starting', pid: null }))).toBe('starting');
    expect(sessionsState(daemon({ state: 'stopped', mode: 'none', pid: null }))).toBe('stopped');
    expect(sessionsState(daemon({ state: 'error', mode: 'none', pid: null }))).toBe('error');
    expect(sessionsState(daemon({ restricted: true }))).toBe('restricted');
    expect(sessionsState(daemon({ state: 'attached', mode: 'attached', restricted: true }))).toBe('restricted');
  });
});

describe('a page that kept dying', () => {
  it('turns a ready daemon into the crashed state, and leaves every other daemon state as it is', () => {
    expect(sessionsState(daemon(), 'ok')).toBe('ready');
    expect(sessionsState(daemon(), 'crashed')).toBe('crashed');
    expect(sessionsState(daemon({ state: 'attached', mode: 'attached' }), 'crashed')).toBe('crashed');
    expect(sessionsState(daemon({ state: 'stopped', mode: 'none', pid: null }), 'crashed')).toBe('stopped');
    expect(sessionsState(daemon({ restricted: true }), 'crashed')).toBe('restricted');
    expect(sessionsState(null, 'crashed')).toBe('starting');
  });

  it('keeps the section reporting itself as active while the view is down, so opening it anew is what retries', () => {
    expect(sessionsViewWanted('ready')).toBe(true);
    expect(sessionsViewWanted('crashed')).toBe(true);
    for (const state of ['starting', 'stopped', 'error', 'restricted'] as const) expect(sessionsViewWanted(state)).toBe(false);
  });
});

describe('the sessions section, rendered', () => {
  const noop = (): void => undefined;

  it.each([
    ['pt-BR', 'As sessões pararam de funcionar', 'Troque de seção e volte'],
    ['en', 'Sessions stopped working', 'Switch to another section and come back'],
    ['es', 'Las sesiones dejaron de funcionar', 'Cambia de sección y vuelve'],
  ] as const)('says in %s that the page closed again and again, and how to try once more', (language, title, hint) => {
    const markup = html(createElement(SessionsUnavailable, { daemon: daemon(), viewState: 'crashed', onOpenOverview: noop }), language);
    expect(markup).toContain('data-state="crashed"');
    expect(markup).toContain(title);
    expect(markup).toContain(hint);
    expect(markup).toContain('id="page-title"');
  });

  it('is not the crashed state while the view is fine', () => {
    expect(html(createElement(SessionsUnavailable, { daemon: daemon(), viewState: 'ok', onOpenOverview: noop }))).toBe('');
    expect(html(createElement(SessionsUnavailable, { daemon: daemon(), onOpenOverview: noop }))).toBe('');
  });

  it('the stage keeps a heading for the keyboard focus and a region for the view, and draws nothing else', () => {
    const markup = html(createElement(SessionsStage));
    expect(markup).toContain('id="page-title"');
    expect(markup).toContain('Sessões');
    expect(markup).toContain('data-slot="sessions-stage"');
    expect(html(createElement(SessionsStage), 'en')).toContain('Sessions');
    expect(html(createElement(SessionsStage), 'es')).toContain('Sesiones');
  });

  it.each([
    ['starting', daemon({ state: 'starting', pid: null }), 'Iniciando o daemon', 'porta 7780'],
    ['stopped', daemon({ state: 'stopped', mode: 'none', pid: null }), 'O daemon está parado', 'Inicie o daemon'],
    ['error', daemon({ state: 'error', mode: 'none', pid: null, message: 'A porta 7780 está ocupada.', logTail: ['[desktop] porta ocupada'] }), 'O daemon não conseguiu iniciar', 'A porta 7780 está ocupada.'],
    ['restricted', daemon({ restricted: true }), 'O painel local não consegue usar este daemon', 'Tailscale'],
  ] as const)('explains a daemon that is %s, with the way to the overview', (state, status, title, detail) => {
    const markup = html(createElement(SessionsUnavailable, { daemon: status, onOpenOverview: noop }));
    expect(markup).toContain(`data-state="${state}"`);
    expect(markup).toContain(title);
    expect(markup).toContain(detail);
    expect(markup).toContain('Abrir a Visão geral');
    expect(markup).toContain('id="page-title"');
  });

  it('shows the last log lines of a failed start, and nothing for a daemon that is only starting', () => {
    const failed = html(createElement(SessionsUnavailable, { daemon: daemon({ state: 'error', mode: 'none', logTail: ['[desktop] linha do log'] }), onOpenOverview: noop }));
    expect(failed).toContain('Últimas linhas do log');
    expect(failed).toContain('[desktop] linha do log');
    const starting = html(createElement(SessionsUnavailable, { daemon: daemon({ state: 'starting', logTail: ['[desktop] linha do log'] }), onOpenOverview: noop }));
    expect(starting).not.toContain('linha do log');
  });

  it('prefers the reason main wrote (already in its language) to the generic line', () => {
    const markup = html(createElement(SessionsUnavailable, { daemon: daemon({ state: 'starting', pid: null, message: 'O daemon caiu (código 1); tentando de novo em 1 s.' }), onOpenOverview: noop }));
    expect(markup).toContain('O daemon caiu (código 1)');
  });

  it('renders nothing for a ready daemon (the stage is drawn by the shell then)', () => {
    expect(html(createElement(SessionsUnavailable, { daemon: daemon(), onOpenOverview: noop }))).toBe('');
  });
});

describe('what the page reports about the view', () => {
  const rect = { left: 232, top: 40, width: 948, height: 720 };

  it('is the measured rectangle with the two flags', () => {
    expect(viewportOf(rect, { active: true, covered: false })).toEqual({ x: 232, y: 40, width: 948, height: 720, active: true, covered: false });
  });

  it('is the same report only when nothing changed, flags included', () => {
    const report = viewportOf(rect, { active: true, covered: false });
    expect(sameViewport(null, report)).toBe(false);
    expect(sameViewport(report, viewportOf(rect, { active: true, covered: false }))).toBe(true);
    expect(sameViewport(report, viewportOf({ ...rect, left: 64, width: 1116 }, { active: true, covered: false }))).toBe(false);
    expect(sameViewport(report, viewportOf(rect, { active: false, covered: false }))).toBe(false);
    expect(sameViewport(report, viewportOf(rect, { active: true, covered: true }))).toBe(false);
  });
});

describe('the view and what the control center draws over the same area', () => {
  const rect = { left: 64, top: 40, width: 916, height: 580 };
  const content = { width: 980, height: 620 };
  const visible = (covered: boolean): boolean => decideSessionsView({ viewport: viewportOf(rect, { active: true, covered }), daemonReady: true, contentSize: content }).visible;

  it('a dialog covers it while it is open, and the view is back when it closes', () => {
    expect(visible(overlayActive())).toBe(true);
    const release = acquireOverlay();
    expect(overlayActive()).toBe(true);
    expect(visible(overlayActive())).toBe(false);
    release();
    expect(visible(overlayActive())).toBe(true);
  });

  it('a toast does not cover it: the toasts wait while the view is on screen and nothing is counted as an overlay', () => {
    const items = [{ id: 1, tone: 'success' as const, message: 'Salvo.' }];
    const release = holdToasts();
    expect(toastsHeld()).toBe(true);
    expect(overlayActive()).toBe(false);
    expect(visible(overlayActive())).toBe(true);
    expect(html(createElement(ToastStack, { items, held: toastsHeld(), onDismiss: () => undefined }))).not.toContain('Salvo.');
    release();
    release();
    expect(toastsHeld()).toBe(false);
    // They show when the view is gone, still waiting, as new as when they were raised.
    expect(html(createElement(ToastStack, { items, held: toastsHeld(), onDismiss: () => undefined }))).toContain('Salvo.');
  });

  it('keeps the toast region for screen readers either way', () => {
    for (const held of [false, true]) {
      expect(html(createElement(ToastStack, { items: [], held, onDismiss: () => undefined }))).toContain('aria-label="Notificações"');
    }
  });
});

describe('overlays (dialogs) that need the area the view would cover', () => {
  it('count while on screen and stop counting when each is gone, however often release is called', () => {
    expect(overlayActive()).toBe(false);
    const dialog = acquireOverlay();
    const toast = acquireOverlay();
    expect(overlayActive()).toBe(true);
    dialog();
    expect(overlayActive()).toBe(true);
    dialog();
    expect(overlayActive()).toBe(true);
    toast();
    expect(overlayActive()).toBe(false);
  });
});
