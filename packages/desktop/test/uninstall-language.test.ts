import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSettings } from '../src/main/settings.js';
import { readUninstallLanguage } from '../src/main/uninstall-language.js';
import { removeDir } from './remove-dir.js';

describe('readUninstallLanguage', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanachi-uninstall-language-'));
  });
  afterEach(() => removeDir(dir));

  it('reads the language from Desktop\'s settings file', () => {
    const file = join(dir, 'desktop-settings.json');
    saveSettings(file, { tailscaleEnabled: false, language: 'es' });
    expect(readUninstallLanguage(file, 'pt-BR')).toBe('es');
  });

  it('falls back to the locale when there is no usable settings file: it is missing or is not JSON', () => {
    expect(readUninstallLanguage(join(dir, 'missing.json'), 'en-GB')).toBe('en');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{not json', 'utf8');
    expect(readUninstallLanguage(broken, 'pt-PT')).toBe('pt-BR');
    expect(readUninstallLanguage(broken, 'es-419')).toBe('es');
  });

  it('is Portuguese for a Desktop from before the languages: its settings file holds no valid language (the Desktop starts in Portuguese too)', () => {
    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ tailscaleEnabled: true, language: 'klingon' }), 'utf8');
    expect(readUninstallLanguage(invalid, 'es-419')).toBe('pt-BR');

    const without = join(dir, 'without.json');
    writeFileSync(without, JSON.stringify({ tailscaleEnabled: true }), 'utf8');
    expect(readUninstallLanguage(without, 'en-US')).toBe('pt-BR');
  });
});
