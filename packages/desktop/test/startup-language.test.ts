import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSettingsStore,
  languageForSettingsFile,
  pendingPwaLanguage,
  resolveStartupLanguage,
  saveSettings,
  settingsFileExists,
} from '../src/main/settings.js';
import { removeDir } from './remove-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-startup-language-'));
});
afterEach(() => removeDir(dir));

describe('resolveStartupLanguage', () => {
  it('a language Desktop stored wins over everything else', () => {
    expect(resolveStartupLanguage({ stored: 'es', hadSettingsFile: true, locale: 'en-US' })).toEqual({ language: 'es', legacy: false });
    expect(resolveStartupLanguage({ stored: 'en', hadSettingsFile: false, locale: 'pt-BR' })).toEqual({ language: 'en', legacy: false });
  });

  it('a first run with no settings file takes the language of the system', () => {
    expect(resolveStartupLanguage({ stored: undefined, hadSettingsFile: false, locale: 'es-419' })).toEqual({ language: 'es', legacy: false });
    expect(resolveStartupLanguage({ stored: undefined, hadSettingsFile: false, locale: 'en-GB' })).toEqual({ language: 'en', legacy: false });
    expect(resolveStartupLanguage({ stored: undefined, hadSettingsFile: false, locale: 'pt-PT' })).toEqual({ language: 'pt-BR', legacy: false });
    expect(resolveStartupLanguage({ stored: undefined, hadSettingsFile: false, locale: undefined })).toEqual({ language: 'en', legacy: false });
  });

  it('an upgrade (a settings file from before the languages, with none stored) stays in Portuguese, whatever the system says', () => {
    for (const locale of ['en-US', 'es-419', 'de-DE', 'pt-BR', undefined]) {
      expect(resolveStartupLanguage({ stored: undefined, hadSettingsFile: true, locale }), String(locale)).toEqual({ language: 'pt-BR', legacy: true });
    }
  });
});

describe('settingsFileExists', () => {
  it('is true for a settings file Desktop wrote, and false for none, an unreadable one or something that is not an object', () => {
    const file = join(dir, 'desktop-settings.json');
    expect(settingsFileExists(file)).toBe(false);
    writeFileSync(file, '{ nope');
    expect(settingsFileExists(file)).toBe(false);
    writeFileSync(file, '[1]');
    expect(settingsFileExists(file)).toBe(false);
    writeFileSync(file, 'null');
    expect(settingsFileExists(file)).toBe(false);
    writeFileSync(file, '{"tailscaleEnabled":true}');
    expect(settingsFileExists(file)).toBe(true);
  });

  it('is false for a folder where the file should be', () => {
    mkdirSync(join(dir, 'desktop-settings.json'));
    expect(settingsFileExists(join(dir, 'desktop-settings.json'))).toBe(false);
  });
});

describe('an upgrade does not overwrite the language of the PWA', () => {
  it('records Portuguese as already written for the PWA, so its own choice stays; a first run has it written on the first load', () => {
    const upgrade = resolveStartupLanguage({ stored: undefined, hadSettingsFile: true, locale: 'en-US' });
    // What main stores for an upgrade: the language and the same value as "last written into the PWA".
    expect(pendingPwaLanguage(upgrade.language, upgrade.legacy ? upgrade.language : undefined)).toBeNull();
    const fresh = resolveStartupLanguage({ stored: undefined, hadSettingsFile: false, locale: 'en-US' });
    expect(pendingPwaLanguage(fresh.language, undefined)).toBe('en');
  });

  it('a later change in Desktop is handed to the PWA once, the way it always was', () => {
    const file = join(dir, 'desktop-settings.json');
    writeFileSync(file, JSON.stringify({ tailscaleEnabled: true }));
    const upgrade = resolveStartupLanguage({ stored: createSettingsStore(file).get().language, hadSettingsFile: settingsFileExists(file), locale: 'en-US' });
    const store = createSettingsStore(file);
    store.update({ language: upgrade.language, pwaLanguage: upgrade.language });
    expect(pendingPwaLanguage('pt-BR', store.get().pwaLanguage)).toBeNull();
    store.update({ language: 'es' });
    expect(pendingPwaLanguage('es', store.get().pwaLanguage)).toBe('es');
  });
});

describe('languageForSettingsFile (the installer and the uninstaller)', () => {
  const file = (): string => join(dir, 'desktop-settings.json');

  it('speaks the language Desktop is set to', () => {
    saveSettings(file(), { tailscaleEnabled: false, language: 'es' });
    expect(languageForSettingsFile(file(), 'en-US')).toBe('es');
    saveSettings(file(), { tailscaleEnabled: false, language: 'en' });
    expect(languageForSettingsFile(file(), 'pt-BR')).toBe('en');
  });

  it('speaks Portuguese for an upgrade whose Desktop never chose a language, as the Desktop itself will', () => {
    saveSettings(file(), { tailscaleEnabled: true });
    expect(languageForSettingsFile(file(), 'en-US')).toBe('pt-BR');
    writeFileSync(file(), JSON.stringify({ tailscaleEnabled: true, language: 'klingon' }));
    expect(languageForSettingsFile(file(), 'es-MX')).toBe('pt-BR');
  });

  it('takes the language of the system when there is no Desktop settings file yet (a first install)', () => {
    expect(languageForSettingsFile(join(dir, 'missing.json'), 'es-419')).toBe('es');
    expect(languageForSettingsFile(join(dir, 'missing.json'), 'en-US')).toBe('en');
    expect(languageForSettingsFile(join(dir, 'missing.json'), 'de-DE')).toBe('en');
    expect(languageForSettingsFile(join(dir, 'missing.json'), undefined)).toBe('en');
    writeFileSync(file(), '{not json');
    expect(languageForSettingsFile(file(), 'pt-PT')).toBe('pt-BR');
  });
});
