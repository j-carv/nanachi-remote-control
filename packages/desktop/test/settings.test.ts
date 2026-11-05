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
