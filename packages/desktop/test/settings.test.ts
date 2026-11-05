import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettingsStore, DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/main/settings.js';
import { removeDir } from './remove-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-desktop-settings-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('desktop settings', () => {
  it('defaults when the file does not exist', () => {
    expect(loadSettings(join(dir, 'missing.json'))).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.tailscaleEnabled).toBe(false);
  });

  it('round-trips and creates the folder', () => {
    const file = join(dir, 'a', 'b', 'settings.json');
    saveSettings(file, { tailscaleEnabled: true });
    expect(loadSettings(file)).toEqual({ tailscaleEnabled: true });
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('falls back to the defaults for corrupt or wrongly typed content', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ nope');
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    writeFileSync(file, '[1]');
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    writeFileSync(file, '{"tailscaleEnabled":"yes"}');
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it('the store persists every update and hands out copies', () => {
    const file = join(dir, 'settings.json');
    const store = createSettingsStore(file);
    expect(store.get().tailscaleEnabled).toBe(false);
    expect(store.update({ tailscaleEnabled: true })).toEqual({ tailscaleEnabled: true });

    const snapshot = store.get();
    snapshot.tailscaleEnabled = false;
    expect(store.get().tailscaleEnabled).toBe(true);
    expect(createSettingsStore(file).get().tailscaleEnabled).toBe(true);
  });
});

describe('control center window bounds in the settings', () => {
  const bounds = { x: 120, y: 80, width: 1300, height: 820, maximized: false };

  it('are absent by default, so the defaults stay exactly as before', () => {
    expect(loadSettings(join(dir, 'missing.json'))).toEqual({ tailscaleEnabled: false });
    expect('controlWindow' in loadSettings(join(dir, 'missing.json'))).toBe(false);
  });

  it('round-trip with the other settings and survive an update of another key', () => {
    const file = join(dir, 'settings.json');
    const store = createSettingsStore(file);
    store.update({ controlWindow: bounds });
    store.update({ tailscaleEnabled: true });
    expect(createSettingsStore(file).get()).toEqual({ tailscaleEnabled: true, controlWindow: bounds });
  });

  it('keep the maximized flag and a missing position', () => {
    const file = join(dir, 'settings.json');
    saveSettings(file, { tailscaleEnabled: false, controlWindow: { width: 1000, height: 700, maximized: true } });
    expect(loadSettings(file).controlWindow).toEqual({ width: 1000, height: 700, maximized: true });
  });

  it.each([
    ['a size that is not a number', { ...bounds, width: '1300' }],
    ['a size that is not finite', { ...bounds, height: null }],
    ['a size that is tiny', { ...bounds, width: 10 }],
    ['a size that is absurd', { ...bounds, height: 1e9 }],
    ['a fractional size', { ...bounds, width: 1300.5 }],
    ['a maximized flag that is not a boolean', { ...bounds, maximized: 'sim' }],
    ['something that is not an object', 'janela'],
  ])('are dropped for %s, without losing the other settings', (_label, bad) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ tailscaleEnabled: true, controlWindow: bad }));
    expect(loadSettings(file)).toEqual({ tailscaleEnabled: true });
  });

  it('drop only the position when x or y is unusable', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ controlWindow: { ...bounds, x: 'a' } }));
    expect(loadSettings(file).controlWindow).toEqual({ width: 1300, height: 820, maximized: false });
    writeFileSync(file, JSON.stringify({ controlWindow: { ...bounds, y: 1e12 } }));
    expect(loadSettings(file).controlWindow).toEqual({ width: 1300, height: 820, maximized: false });
    writeFileSync(file, JSON.stringify({ controlWindow: { width: 1300, height: 820, maximized: false, x: 5 } }));
    expect(loadSettings(file).controlWindow).toEqual({ width: 1300, height: 820, maximized: false });
  });

  it('are handed out as copies', () => {
    const store = createSettingsStore(join(dir, 'settings.json'));
    store.update({ controlWindow: bounds });
    const snapshot = store.get();
    if (snapshot.controlWindow !== undefined) snapshot.controlWindow.width = 1;
    expect(store.get().controlWindow?.width).toBe(1300);
  });
});
