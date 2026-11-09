import { describe, expect, it } from 'vitest';
import type { ControlResult } from '../../src/common/control-api.js';
import type { DaemonStatus } from '../../src/common/types.js';
import type { Language } from '../../src/common/i18n/index.js';
import { createMockControlApi, type MockScenario } from '../../src/control/mock/mock-api.js';
import { MOCK_MESSAGES } from '../../src/control/mock/messages.js';

const NOW = 1_700_000_000_000;
const make = (scenario: MockScenario = 'default') => createMockControlApi({ scenario, latencyMs: 0, now: () => NOW });

function value<T>(result: ControlResult<T>): T {
  if (!result.ok) throw new Error(`unexpected ${result.code}: ${result.message}`);
  return result.value;
}

/** The mock is what the renderer tests and the screenshots run against, so it has to keep to the contract. */
describe('mock ControlApi', () => {
  it('overview answers the daemon, the node and the activity', async () => {
    const info = value(await make().overview());
    expect(info.daemon.state).toBe('running');
    expect(info.daemon.mode).toBe('spawned');
    expect(info.tailscale.state).toBe('off');
    expect(info.activity).toMatchObject({ workspaces: expect.any(Number), devices: 3 });
    expect(info.dataFolder).toMatch(/^[A-Z]:\\/);
  });

  it('folders: roots carry exists and coveredBy; drives carry sizes', async () => {
    const state = value(await make().folders.get());
    expect(state.editable).toBe(true);
    expect(state.roots.find((root) => root.path === 'C:\\Projetos\\nanachi-remote')?.coveredBy).toBe('C:\\Projetos');
    expect(state.roots.find((root) => root.path === 'E:\\Antigos')?.exists).toBe(false);
    expect(state.drives.map((drive) => drive.root)).toContain('D:\\');
  });

  it('save writes the list; "later" leaves a restart pending, "restart" does not', async () => {
    const api = make();
    const later = value(await api.folders.save(['C:\\Projetos', 'D:/Trabalho/'], false));
    expect(later.applied).toBe('pending');
    expect(later.state.roots.map((root) => root.path)).toEqual(['C:\\Projetos', 'D:\\Trabalho']);
    expect(later.state.restartPending).toBe(true);
    const now = value(await api.folders.save(['C:\\Projetos', 'D:\\Trabalho', 'C:\\projetos\\'], true));
    expect(now.applied).toBe('restarted');
    expect(now.state.restartPending).toBe(false);
    expect(now.state.roots).toHaveLength(2);
  });

  it('save refuses a path that is not complete, and a read-only daemon', async () => {
    const refused = await make().folders.save(['projetos'], true);
    expect(refused).toMatchObject({ ok: false, code: 'invalid_input' });
    const readOnly = await make('readonly').folders.save(['C:\\a'], true);
    expect(readOnly).toMatchObject({ ok: false, code: 'not_own_daemon' });
    expect(value(await make('attached').folders.get()).editable).toBe(false);
  });

  it('save asks for confirmation instead of restarting over busy sessions, and restarts once the count is confirmed', async () => {
    const api = make('busy');
    const asked = value(await api.folders.save(['C:\\Projetos'], true));
    expect(asked.applied).toBe('needs_confirmation');
    expect(asked.state.busySessions).toBe(2);
    // Nothing was written.
    expect(value(await api.folders.get()).roots.map((root) => root.path)).toContain('D:\\Trabalho');
    expect(value(await api.folders.save(['C:\\Projetos'], true, 1)).applied).toBe('needs_confirmation');
    const done = value(await api.folders.save(['C:\\Projetos'], true, 2));
    expect(done.applied).toBe('restarted');
    expect(done.state.roots.map((root) => root.path)).toEqual(['C:\\Projetos']);
  });

  it('a restart goes through the daemon status events', async () => {
    const api = make();
    const seen: DaemonStatus['state'][] = [];
    const off = api.onDaemonStatus((status) => seen.push(status.state));
    value(await api.restartDaemon());
    await new Promise((resolve) => setTimeout(resolve, 10));
    off();
    expect(seen).toEqual(['starting', 'running']);
    expect(await make('attached').restartDaemon()).toMatchObject({ ok: false, code: 'not_own_daemon' });
  });

  it('devices: this app cannot be revoked, another one can', async () => {
    const api = make();
    expect(await api.devices.revoke('dev-2')).toMatchObject({ ok: false, code: 'invalid_input' });
    const after = value(await api.devices.revoke('dev-1'));
    expect(after.find((device) => device.id === 'dev-1')?.revoked).toBe(true);
    expect(after.find((device) => device.isThisApp)?.revoked).toBe(false);
  });

  it('pairing code: six digits, valid for about five minutes', async () => {
    const code = value(await make().devices.pairingCode());
    expect(code.code).toMatch(/^\d{6}$/);
    expect(code.expiresAt - NOW).toBeGreaterThan(4 * 60_000);
    expect(code.expiresAt - NOW).toBeLessThanOrEqual(5 * 60_000);
  });

  it('accounts: setActive moves "in use" inside one agent only', async () => {
    const agents = value(await make().accounts.setActive('claude', 'work'));
    expect(agents.find((agent) => agent.agentId === 'claude')?.accounts.filter((account) => account.active).map((account) => account.id)).toEqual(['work']);
    expect(agents.find((agent) => agent.agentId === 'codex')?.accounts.find((account) => account.active)?.id).toBe('default');
  });

  it('accounts.list(true) asks the daemon to check the logins again', async () => {
    const api = make();
    await api.accounts.list();
    await api.accounts.list(true);
    expect(api.mock.calls).toEqual(['accounts.list', 'accounts.list:refresh']);
  });

  it('attached to a daemon Desktop did not start: read-only roots, and devices/accounts/activity are not available', async () => {
    const api = make('attached');
    const folders = value(await api.folders.get());
    // Desktop's own list is not that daemon's list: unknown, and empty.
    expect(folders).toMatchObject({ editable: false, rootsUnknown: true, roots: [] });
    expect(value(await make().folders.get()).rootsUnknown).toBe(false);
    expect(value(await api.overview()).activity).toBeNull();
    expect(await api.devices.list()).toMatchObject({ ok: false, code: 'not_paired' });
    expect(await api.accounts.list()).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await api.devices.pairingCode()).toMatchObject({ ok: false, code: 'not_paired' });
  });

  it('tailscale: start passes through starting and ends running (or needs_login), stop turns it off', async () => {
    const api = make();
    const seen: string[] = [];
    api.tailscale.onStatus((status) => seen.push(status.state));
    expect((await api.tailscale.start()).state).toBe('starting');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(['starting', 'running']);
    expect((await api.tailscale.stop()).state).toBe('off');
    const login = make('login');
    await login.tailscale.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await login.tailscale.status()).state).toBe('needs_login');
  });

  it('a daemon that is down answers ControlErrors, not exceptions', async () => {
    const api = make('down');
    expect(await api.overview()).toMatchObject({ ok: false, code: 'daemon_unavailable' });
    expect(await api.folders.get()).toMatchObject({ ok: false, code: 'daemon_unavailable' });
    expect(await api.devices.list()).toMatchObject({ ok: false, code: 'daemon_unavailable' });
  });

  it('the window follows toggleMaximize and tells its listeners', async () => {
    const api = make();
    const states: boolean[] = [];
    api.window.onState((state) => states.push(state.maximized));
    expect((await api.window.toggleMaximize()).maximized).toBe(true);
    expect((await api.window.toggleMaximize()).maximized).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('logs grow while you watch and the autostart switch sticks', async () => {
    const api = make();
    const first = await api.logs.get();
    const second = await api.logs.get();
    expect(second.daemon.length).toBeGreaterThan(first.daemon.length);
    expect(await api.settings.setAutostart(false)).toEqual({ value: false, supported: true });
    expect((await api.settings.getAutostart()).value).toBe(false);
  });
});

/** Like main, the mock words its errors in Desktop's language: the page must never get Portuguese in an English or Spanish window. */
describe('mock ControlApi language', () => {
  const makeIn = (language: Language, scenario: MockScenario = 'default') => createMockControlApi({ scenario, latencyMs: 0, now: () => NOW, language });
  const messageOf = <T>(result: ControlResult<T>): string => {
    if (result.ok) throw new Error('expected a ControlError');
    return result.message;
  };

  it('starts in the language it was given (pt-BR by default) and says so', () => {
    expect(make().language).toBe('pt-BR');
    expect(makeIn('en').language).toBe('en');
    expect(makeIn('es').language).toBe('es');
  });

  it('pt-BR keeps the texts it always had', async () => {
    expect(messageOf(await make('attached').devices.list())).toBe('Este app ainda não está pareado com o daemon que já estava rodando, então ele não pode ler isto.');
    expect(messageOf(await make('down').overview())).toBe('O daemon não respondeu em 127.0.0.1:7780.');
    expect(messageOf(await make().folders.save(['projetos'], true))).toBe('“projetos” não é um caminho completo, como C:\\Projetos.');
  });

  it('English: the messages of every kind of failure are English', async () => {
    const attached = makeIn('en', 'attached');
    expect(messageOf(await attached.devices.list())).toContain('not paired');
    expect(messageOf(await attached.accounts.list())).toContain('did not accept');
    expect(messageOf(await attached.restartDaemon())).toBe('Nanachi only restarts the daemon it started itself.');
    expect(messageOf(await makeIn('en').folders.save(['projects'], true))).toBe('“projects” is not a full path, like C:\\Projects.');
    expect(messageOf(await makeIn('en', 'readonly').folders.save(['C:\\a'], true))).toBe('The list can only be changed on the daemon that Nanachi started.');
    expect(messageOf(await makeIn('en').devices.revoke('dev-2'))).toBe('This app cannot revoke its own access.');
    expect(messageOf(await makeIn('en').devices.revoke('nope'))).toBe('That device no longer exists.');
    const down = makeIn('en', 'down');
    expect(messageOf(await down.overview())).toBe('The daemon did not answer on 127.0.0.1:7780.');
    expect(messageOf(await down.devices.list())).toBe('The daemon did not answer on 127.0.0.1:7780. Try again in a few seconds.');
  });

  it('Spanish: the messages are Spanish', async () => {
    expect(messageOf(await makeIn('es', 'attached').devices.pairingCode())).toContain('no está emparejada');
    expect(messageOf(await makeIn('es').folders.save(['proyectos'], true))).toBe('“proyectos” no es una ruta completa, como C:\\Proyectos.');
    expect(messageOf(await makeIn('es', 'down').folders.get())).toContain('no respondió');
  });

  it('follows the language when it changes in the middle of the session, like main', async () => {
    const api = make('attached');
    expect(messageOf(await api.devices.list())).toContain('Este app ainda não');
    const heard: Language[] = [];
    api.onLanguage((language) => heard.push(language));
    expect(await api.settings.setLanguage('en')).toBe('en');
    expect(api.language).toBe('en');
    expect(heard).toEqual(['en']);
    expect(messageOf(await api.devices.list())).toContain('not paired');
    await api.settings.setLanguage('es');
    expect(messageOf(await api.devices.list())).toContain('no está emparejada');
  });

  it('a language change rewords the message of a status that carries one', async () => {
    const api = make('down');
    const seen: Array<string | null> = [];
    api.onDaemonStatus((status) => seen.push(status.message));
    await api.settings.setLanguage('en');
    expect(seen).toEqual(['Port 7780 is in use by another program.']);
  });

  it.each(['en', 'es'] as const)('no message of the mock in %s has a Portuguese-only letter', (language) => {
    const messages = MOCK_MESSAGES[language];
    const all = [
      messages.notPaired,
      messages.unreachable(7780),
      messages.unreachableShort(7780),
      messages.portBusy(7780),
      messages.notOwnDaemon,
      messages.rootsReadOnly,
      messages.notAFullPath('x'),
      messages.deviceGone,
      messages.deviceSelf,
      messages.accountsRefused,
      messages.transcriptionInvalid,
    ].join('\n');
    expect(all).not.toMatch(/[ãõçâêôÃÕÇÂÊÔ]/);
    if (language === 'en') expect(all.normalize('NFD')).not.toMatch(/\p{M}/u);
  });
});

describe('mock transcription settings', () => {
  it('keeps the exact local default and a separately accessible Whisper installer', async () => {
    const api = make();
    expect(value(await api.settings.transcriptionSettings())).toEqual({ provider: 'whisper', model: 'ggml-base-q5_1.bin', baseUrl: '', timeoutMs: 90_000, apiKeyConfigured: false });
    expect(value(await api.settings.transcriptionStatus()).state).toBe('not_ready');
    await api.settings.whisper('install');
    expect(value(await api.settings.transcriptionStatus()).state).toBe('ready');
    await api.settings.whisper('remove');
    expect(value(await api.settings.whisper('status')).state).toBe('disabled');
  });

  it('saves remote configuration, exposes compatible models and never tracks or returns a key', async () => {
    const api = make();
    const settings = { provider: 'openai' as const, model: 'gpt-transcribe', baseUrl: '', timeoutMs: 90_000 };
    const first = value(await api.settings.setTranscriptionSettings({ ...settings, apiKey: 'secret-write-only' }));
    expect(first.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(first)).not.toContain('secret-write-only');
    expect(value(await api.settings.transcriptionModels()).models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-transcribe' }), expect.objectContaining({ id: 'gpt-4o-transcribe', deprecated: true }),
    ]));
    expect(value(await api.settings.setTranscriptionSettings(settings)).apiKeyConfigured).toBe(true);
    const own = { ...settings, provider: 'custom' as const, model: 'own-asr', baseUrl: 'http://127.0.0.1:8000/v1' };
    expect(value(await api.settings.setTranscriptionSettings(own)).apiKeyConfigured).toBe(false);
    expect(value(await api.settings.transcriptionModels()).manual).toBe(true);
    expect(value(await api.settings.transcriptionStatus())).toEqual({ provider: 'custom', model: 'own-asr', state: 'ready' });
    expect(api.mock.calls.join('\\n')).not.toContain('secret-write-only');
  });

  it.each(['down', 'attached'] as const)('does not pretend transcription settings work in %s', async (scenario) => {
    expect(await make(scenario).settings.transcriptionSettings()).toMatchObject({ ok: false });
    expect(await make(scenario).settings.transcriptionModels()).toMatchObject({ ok: false });
  });
});
