import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_CONTROL_EVENT_CHANNELS,
  ALLOWED_CONTROL_INVOKE_CHANNELS,
  CONTROL_EVENT_CHANNELS,
  CONTROL_INVOKE_CHANNELS,
} from '../src/common/channels.js';
import { createControlBridge } from '../src/preload/control-bridge.js';
import type { BridgeIpc } from '../src/preload/bridge.js';

interface FakeIpc extends BridgeIpc {
  invoked: Array<{ channel: string; args: unknown[] }>;
  listeners: Map<string, Set<(event: unknown, ...args: unknown[]) => void>>;
  emit(channel: string, payload: unknown): void;
}

function fakeIpc(): FakeIpc {
  const listeners: FakeIpc['listeners'] = new Map();
  const invoked: FakeIpc['invoked'] = [];
  return {
    invoked,
    listeners,
    invoke(channel, ...args) {
      invoked.push({ channel, args });
      return Promise.resolve({ echoed: channel });
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener({ sender: 'secret-ipc-event' }, payload);
    },
  };
}

describe('control bridge', () => {
  it('exposes exactly the ControlApi surface and nothing else', () => {
    const bridge = createControlBridge(fakeIpc(), '0.2.0', 'pt-BR');
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'accounts',
        'devices',
        'folders',
        'language',
        'logs',
        'onDaemonStatus',
        'onLanguage',
        'onNavigate',
        'openDataFolder',
        'overview',
        'restartDaemon',
        'sessions',
        'settings',
        'tailscale',
        'version',
        'window',
      ].sort(),
    );
    expect(Object.keys(bridge.window).sort()).toEqual(['close', 'minimize', 'onState', 'state', 'toggleMaximize']);
    expect(Object.keys(bridge.folders).sort()).toEqual(['get', 'pick', 'reveal', 'save']);
    expect(Object.keys(bridge.devices).sort()).toEqual(['list', 'pairingCode', 'revoke']);
    expect(Object.keys(bridge.accounts).sort()).toEqual(['list', 'setActive']);
    expect(Object.keys(bridge.tailscale).sort()).toEqual(['onStatus', 'openLogin', 'start', 'status', 'stop']);
    expect(Object.keys(bridge.logs).sort()).toEqual(['get', 'openFolder']);
    expect(Object.keys(bridge.sessions).sort()).toEqual(['onState', 'setViewport']);
    expect(Object.keys(bridge.settings).sort()).toEqual([
      'checkForUpdate',
      'getAutostart',
      'openUpdate',
      'setAutostart',
      'setLanguage',
      'setTranscriptionSettings',
      'transcriptionModels',
      'transcriptionSettings',
      'transcriptionStatus',
      'uninstall',
      'whisper',
    ]);
    expect(bridge.version).toBe('0.2.0');
    expect(bridge.language).toBe('pt-BR');
  });

  it('maps every method to its own control channel, and uses every channel of the allowlist', async () => {
    const ipc = fakeIpc();
    const bridge = createControlBridge(ipc, '0.2.0', 'pt-BR');

    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.close();
    await bridge.window.state();
    await bridge.overview();
    await bridge.restartDaemon();
    await bridge.openDataFolder();
    await bridge.sessions.setViewport({ x: 232, y: 40, width: 948, height: 720, active: true, covered: false });
    await bridge.folders.get();
    await bridge.folders.pick();
    await bridge.folders.save(['C:\\Projetos'], true);
    await bridge.folders.reveal('C:\\Projetos');
    await bridge.devices.list();
    await bridge.devices.revoke('device-1');
    await bridge.devices.pairingCode();
    await bridge.accounts.list();
    await bridge.accounts.list(true);
    await bridge.accounts.setActive('claude', 'work');
    await bridge.tailscale.status();
    await bridge.tailscale.start();
    await bridge.tailscale.stop();
    await bridge.tailscale.openLogin('https://login.tailscale.com/a/abc');
    await bridge.logs.get();
    await bridge.logs.openFolder();
    await bridge.settings.setLanguage('es');
    await bridge.settings.getAutostart();
    await bridge.settings.setAutostart(true);
    await bridge.settings.checkForUpdate();
    await bridge.settings.openUpdate('https://github.com/j-carv/nanachi-remote-control/releases/tag/v1.0.0');
    await bridge.settings.uninstall();
    await bridge.settings.whisper('status');
    await bridge.settings.transcriptionSettings();
    await bridge.settings.setTranscriptionSettings({ provider: 'openai', model: 'gpt-transcribe', baseUrl: '', timeoutMs: 90_000, apiKey: 'write-only' });
    await bridge.settings.transcriptionStatus();
    await bridge.settings.transcriptionModels();

    const channels = ipc.invoked.map((call) => call.channel);
    expect(channels).toEqual([
      CONTROL_INVOKE_CHANNELS.windowMinimize,
      CONTROL_INVOKE_CHANNELS.windowToggleMaximize,
      CONTROL_INVOKE_CHANNELS.windowClose,
      CONTROL_INVOKE_CHANNELS.windowState,
      CONTROL_INVOKE_CHANNELS.overview,
      CONTROL_INVOKE_CHANNELS.restartDaemon,
      CONTROL_INVOKE_CHANNELS.openDataFolder,
      CONTROL_INVOKE_CHANNELS.sessionsViewport,
      CONTROL_INVOKE_CHANNELS.foldersGet,
      CONTROL_INVOKE_CHANNELS.foldersPick,
      CONTROL_INVOKE_CHANNELS.foldersSave,
      CONTROL_INVOKE_CHANNELS.foldersReveal,
      CONTROL_INVOKE_CHANNELS.devicesList,
      CONTROL_INVOKE_CHANNELS.devicesRevoke,
      CONTROL_INVOKE_CHANNELS.devicesPairingCode,
      CONTROL_INVOKE_CHANNELS.accountsList,
      CONTROL_INVOKE_CHANNELS.accountsList,
      CONTROL_INVOKE_CHANNELS.accountsSetActive,
      CONTROL_INVOKE_CHANNELS.tailscaleStatus,
      CONTROL_INVOKE_CHANNELS.tailscaleStart,
      CONTROL_INVOKE_CHANNELS.tailscaleStop,
      CONTROL_INVOKE_CHANNELS.tailscaleOpenLogin,
      CONTROL_INVOKE_CHANNELS.logsGet,
      CONTROL_INVOKE_CHANNELS.logsOpenFolder,
      CONTROL_INVOKE_CHANNELS.settingsSetLanguage,
      CONTROL_INVOKE_CHANNELS.settingsGetAutostart,
      CONTROL_INVOKE_CHANNELS.settingsSetAutostart,
      CONTROL_INVOKE_CHANNELS.settingsCheckForUpdate,
      CONTROL_INVOKE_CHANNELS.settingsOpenUpdate,
      CONTROL_INVOKE_CHANNELS.settingsUninstall,
      CONTROL_INVOKE_CHANNELS.settingsWhisper,
      CONTROL_INVOKE_CHANNELS.settingsTranscriptionGet,
      CONTROL_INVOKE_CHANNELS.settingsTranscriptionUpdate,
      CONTROL_INVOKE_CHANNELS.settingsTranscriptionStatus,
      CONTROL_INVOKE_CHANNELS.settingsTranscriptionModels,
    ]);
    for (const channel of channels) expect(ALLOWED_CONTROL_INVOKE_CHANNELS.has(channel)).toBe(true);
    // Nothing on the allowlist is dead: every channel is reachable from the bridge.
    expect(new Set(channels)).toEqual(ALLOWED_CONTROL_INVOKE_CHANNELS);
  });

  it('forwards the page arguments untouched, and only those', async () => {
    const ipc = fakeIpc();
    const bridge = createControlBridge(ipc, '0.2.0', 'pt-BR');
    await bridge.folders.save(['C:\\A', 'D:\\'], false);
    await bridge.folders.save(['C:\\A'], true, 2);
    await bridge.devices.revoke('d-1');
    await bridge.accounts.setActive('codex', 'default');
    await bridge.accounts.list();
    await bridge.accounts.list(true);
    await bridge.settings.setAutostart(false);
    await bridge.settings.setLanguage('en');
    expect(ipc.invoked.map((call) => call.args)).toEqual([
      [['C:\\A', 'D:\\'], false],
      [['C:\\A'], true, 2],
      ['d-1'],
      ['codex', 'default'],
      [],
      [true],
      [false],
      ['en'],
    ]);
  });

  it('subscribes only to control event channels and hands the page the payload, never the IPC event', () => {
    const ipc = fakeIpc();
    const bridge = createControlBridge(ipc, '0.2.0', 'pt-BR');
    const onState = vi.fn();
    const onDaemon = vi.fn();
    const onTailscale = vi.fn();
    const onNavigate = vi.fn();
    const onLanguage = vi.fn();
    const offState = bridge.window.onState(onState);
    bridge.onDaemonStatus(onDaemon);
    bridge.tailscale.onStatus(onTailscale);
    bridge.onNavigate(onNavigate);
    bridge.onLanguage(onLanguage);
    const onSessionsView = vi.fn();
    bridge.sessions.onState(onSessionsView);

    expect([...ipc.listeners.keys()].sort()).toEqual(Object.values(CONTROL_EVENT_CHANNELS).sort());
    for (const channel of ipc.listeners.keys()) expect(ALLOWED_CONTROL_EVENT_CHANNELS.has(channel)).toBe(true);

    ipc.emit(CONTROL_EVENT_CHANNELS.windowState, { maximized: true, focused: false });
    expect(onState).toHaveBeenCalledWith({ maximized: true, focused: false });
    expect(onDaemon).not.toHaveBeenCalled();
    expect(onTailscale).not.toHaveBeenCalled();

    ipc.emit(CONTROL_EVENT_CHANNELS.daemonStatus, { state: 'running' });
    expect(onDaemon).toHaveBeenCalledWith({ state: 'running' });
    ipc.emit(CONTROL_EVENT_CHANNELS.tailscaleStatus, { state: 'off' });
    expect(onTailscale).toHaveBeenCalledWith({ state: 'off' });
    ipc.emit(CONTROL_EVENT_CHANNELS.navigate, 'sessions');
    expect(onNavigate).toHaveBeenCalledWith('sessions');
    ipc.emit(CONTROL_EVENT_CHANNELS.language, 'es');
    expect(onLanguage).toHaveBeenCalledWith('es');
    ipc.emit(CONTROL_EVENT_CHANNELS.sessionsView, 'crashed');
    expect(onSessionsView).toHaveBeenCalledWith('crashed');
    expect(onNavigate).toHaveBeenCalledTimes(1);

    offState();
    ipc.emit(CONTROL_EVENT_CHANNELS.windowState, { maximized: false, focused: true });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(ipc.listeners.get(CONTROL_EVENT_CHANNELS.windowState)?.size).toBe(0);
  });

  it('refuses a callback that is not a function', () => {
    const bridge = createControlBridge(fakeIpc(), '0.2.0', 'pt-BR');
    expect(() => bridge.onDaemonStatus('nope' as never)).toThrow(TypeError);
    expect(() => bridge.window.onState(undefined as never)).toThrow(TypeError);
    expect(() => bridge.tailscale.onStatus(1 as never)).toThrow(TypeError);
    expect(() => bridge.onNavigate(null as never)).toThrow(TypeError);
    expect(() => bridge.onLanguage('es' as never)).toThrow(TypeError);
  });
});

describe('transcription preload producer', () => {
  it('forwards write-only credentials only in the explicit update invocation', async () => {
    const ipc = fakeIpc();
    const bridge = createControlBridge(ipc, '0.2.0', 'en');
    const settings = { provider: 'custom' as const, model: 'own-asr', baseUrl: 'http://127.0.0.1:8000/v1', timeoutMs: 90_000, apiKey: 'write-only' };
    await bridge.settings.setTranscriptionSettings(settings);
    await bridge.settings.transcriptionSettings();
    await bridge.settings.transcriptionStatus();
    await bridge.settings.transcriptionModels();
    expect(ipc.invoked).toEqual([
      { channel: CONTROL_INVOKE_CHANNELS.settingsTranscriptionUpdate, args: [settings] },
      { channel: CONTROL_INVOKE_CHANNELS.settingsTranscriptionGet, args: [] },
      { channel: CONTROL_INVOKE_CHANNELS.settingsTranscriptionStatus, args: [] },
      { channel: CONTROL_INVOKE_CHANNELS.settingsTranscriptionModels, args: [] },
    ]);
  });
});
