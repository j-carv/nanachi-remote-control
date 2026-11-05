import { describe, expect, it } from 'vitest';
import type { ControlError, FoldersState, SaveRootsResult } from '../../src/common/control-api.js';
import type { DaemonStatus } from '../../src/common/types.js';
import { draftAfter, planSave, restartedMessage, saveFolders, savedMessage, saveOutcome } from '../../src/control/lib/save.js';
import { needsRestartChoice } from '../../src/control/lib/roots.js';
import { createMockControlApi, type MockScenario } from '../../src/control/mock/mock-api.js';
import { controlT } from './translator.js';

const t = controlT('pt-BR');

const make = (scenario: MockScenario = 'default') => createMockControlApi({ scenario, latencyMs: 0 });

const state = (extra: Partial<FoldersState> = {}): FoldersState => ({
  roots: [],
  rootsUnknown: false,
  drives: [],
  editable: true,
  restartPending: false,
  busySessions: 0,
  ...extra,
});

const result = (applied: SaveRootsResult['applied'], extra: Partial<FoldersState> = {}) => ({ ok: true as const, value: { applied, state: state(extra) } });

describe('planSave: what the screen asks main to do', () => {
  it('"auto" is the first click with no dialog: main restarts, and decides by itself whether to ask', () => {
    expect(planSave('auto', 0)).toEqual({ restart: true });
  });

  it('"now" confirms exactly the number of sessions the dialog showed', () => {
    expect(planSave('now', 3)).toEqual({ restart: true, confirmedBusy: 3 });
    expect(planSave('now', 0)).toEqual({ restart: true, confirmedBusy: 0 });
  });

  it('"later" saves and leaves the restart for later', () => {
    expect(planSave('later', 3)).toEqual({ restart: false });
  });
});

describe('the decision to ask before saving', () => {
  it('a dialog is shown when the screen already knows sessions are busy; otherwise main is asked, and it may still refuse', () => {
    expect(needsRestartChoice(2)).toBe(true);
    expect(needsRestartChoice(0)).toBe(false);
  });
});

describe('saveOutcome', () => {
  it.each(['restarted', 'starting', 'restart_failed', 'pending'] as const)('%s is a save that happened', (applied) => {
    const outcome = saveOutcome(result(applied));
    expect(outcome).toMatchObject({ kind: 'saved', applied });
  });

  it('needs_confirmation carries the count main just read, not the one on screen', () => {
    expect(saveOutcome(result('needs_confirmation', { busySessions: 4 }))).toMatchObject({ kind: 'needs_confirmation', busySessions: 4 });
  });

  it('an error stays an error, with its text', () => {
    const error: ControlError = { ok: false, code: 'invalid_input', message: 'A pasta "X" não existe.' };
    expect(saveOutcome(error)).toEqual({ kind: 'failed', error });
  });
});

describe('draftAfter: what happens to the edits on screen', () => {
  const draft = ['C:\\A', 'D:\\'];

  it('a save that happened drops the draft: the saved list is now what was edited', () => {
    expect(draftAfter(saveOutcome(result('restarted')), draft)).toBeNull();
    expect(draftAfter(saveOutcome(result('pending')), draft)).toBeNull();
    expect(draftAfter(saveOutcome(result('restart_failed')), draft)).toBeNull();
  });

  it('a save that was not made keeps the edits: a confirmation asked, or an error', () => {
    expect(draftAfter(saveOutcome(result('needs_confirmation', { busySessions: 2 })), draft)).toEqual(draft);
    expect(draftAfter(saveOutcome({ ok: false, code: 'io', message: 'x' }), draft)).toEqual(draft);
  });

  it('discarding is dropping the draft, whatever it was', () => {
    expect(draftAfter({ kind: 'discarded' }, draft)).toBeNull();
  });
});

describe('saveFolders against the contract (mock main)', () => {
  it('a busy daemon: the first save asks, nothing is written, the edits survive, and the count is the fresh one', async () => {
    const api = make('busy');
    const outcome = await saveFolders(api, ['C:\\Projetos'], planSave('auto', 0));
    expect(outcome).toMatchObject({ kind: 'needs_confirmation', busySessions: 2 });
    expect(draftAfter(outcome, ['C:\\Projetos'])).toEqual(['C:\\Projetos']);
    const saved = await api.folders.get();
    expect(saved.ok && saved.value.roots.map((root) => root.path)).toContain('D:\\Trabalho');
  });

  it('confirming that count saves and restarts', async () => {
    const api = make('busy');
    const asked = await saveFolders(api, ['C:\\Projetos'], planSave('auto', 0));
    if (asked.kind !== 'needs_confirmation') throw new Error('esperava um pedido de confirmação');
    const done = await saveFolders(api, ['C:\\Projetos'], planSave('now', asked.busySessions));
    expect(done).toMatchObject({ kind: 'saved', applied: 'restarted' });
    expect(draftAfter(done, ['C:\\Projetos'])).toBeNull();
  });

  it('"later" never needs a confirmation', async () => {
    const outcome = await saveFolders(make('busy'), ['C:\\Projetos'], planSave('later', 2));
    expect(outcome).toMatchObject({ kind: 'saved', applied: 'pending' });
  });

  it('a rejected call is a failure with a safe text, never a thrown error', async () => {
    const api = make();
    api.folders.save = () => Promise.reject(new Error('Error invoking remote method'));
    expect(await saveFolders(api, ['C:\\Projetos'], planSave('auto', 0))).toMatchObject({ kind: 'failed', error: { code: 'unknown' } });
  });
});

describe('messages', () => {
  it('say what really happened, in Portuguese, and do not promise that idle sessions resume by themselves', () => {
    expect(savedMessage('restarted', t)).toMatchObject({ tone: 'success', message: expect.stringContaining('quando você enviar uma mensagem') });
    expect(savedMessage('starting', t)).toMatchObject({ tone: 'info', message: expect.stringContaining('ainda está iniciando') });
    expect(savedMessage('restart_failed', t)).toMatchObject({ tone: 'error', title: expect.stringContaining('não voltou') });
    expect(savedMessage('pending', t)).toMatchObject({ tone: 'success', message: expect.stringContaining('próximo reinício') });
  });

  it('a restart that answers "starting" is not announced as done', () => {
    const status = (state: DaemonStatus['state']): DaemonStatus => ({ state, port: 7780, mode: 'spawned', pid: 1, version: null, machineName: 'PC', restricted: false, message: null, logTail: [] });
    expect(restartedMessage(status('running'), t)).toMatchObject({ tone: 'success', message: expect.stringContaining('reiniciou') });
    expect(restartedMessage(status('starting'), t)).toMatchObject({ tone: 'info', message: expect.stringContaining('ainda está iniciando') });
  });
});
