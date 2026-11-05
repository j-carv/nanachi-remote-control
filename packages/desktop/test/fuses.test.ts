import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_FUSES, INSTALLER_FUSES } from '../scripts/builder-config.js';
import { assertNoDefaultApp, FUSE_NAMES, parseFuseWire, readFuses, verifyFuses } from '../scripts/fuses.js';
import { removeDir } from './remove-dir.js';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** A binary with some noise around a fuse wire: version 1, one state byte per fuse ('0', '1' or 'r'). */
function binaryWith(states: string, version = 1): Buffer {
  return Buffer.concat([Buffer.from('MZ....noise....'), Buffer.from(SENTINEL), Buffer.from([version, states.length]), Buffer.from(states, 'latin1'), Buffer.from('....more noise')]);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-fuses-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('parseFuseWire', () => {
  it('reads every fuse in wire order', () => {
    expect(parseFuseWire(binaryWith('01010r10'))).toEqual({
      runAsNode: 'disabled',
      enableCookieEncryption: 'enabled',
      enableNodeOptionsEnvironmentVariable: 'disabled',
      enableNodeCliInspectArguments: 'enabled',
      enableEmbeddedAsarIntegrityValidation: 'disabled',
      onlyLoadAppFromAsar: 'removed',
      loadBrowserProcessSpecificV8Snapshot: 'enabled',
      grantFileProtocolExtraPrivileges: 'disabled',
    });
  });

  it('reads a shorter wire (an older Electron) and marks unexpected bytes unknown', () => {
    expect(parseFuseWire(binaryWith('0x'))).toEqual({ runAsNode: 'disabled', enableCookieEncryption: 'unknown' });
  });

  it('rejects a binary with no fuse wire and a wire version it does not know', () => {
    expect(() => parseFuseWire(Buffer.from('just some bytes'))).toThrow(/fio de fuses/);
    expect(() => parseFuseWire(binaryWith('01', 2))).toThrow(/versão de fuses/);
  });
});

describe('verifyFuses', () => {
  function exeWith(states: string): string {
    const file = join(dir, 'Nanachi.exe');
    writeFileSync(file, binaryWith(states));
    return file;
  }

  it('passes when the exe has what the configuration asked for', () => {
    // runAsNode off, cookies (untouched), node options off, inspect off, asar integrity on, only asar on, then two defaults.
    const exe = exeWith('00001101');
    expect(() => verifyFuses(exe, APP_FUSES)).not.toThrow();
  });

  it('names every fuse that is not as configured', () => {
    const exe = exeWith('11110000');
    expect(() => verifyFuses(exe, APP_FUSES)).toThrow(/runAsNode: esperado desligado, está enabled/);
    expect(() => verifyFuses(exe, APP_FUSES)).toThrow(/enableNodeCliInspectArguments/);
    expect(() => verifyFuses(exe, APP_FUSES)).toThrow(/onlyLoadAppFromAsar: esperado ligado, está disabled/);
  });

  it('ignores fuses the configuration says nothing about', () => {
    const exe = exeWith('00001010');
    expect(() => verifyFuses(exe, INSTALLER_FUSES)).not.toThrow();
    expect(() => verifyFuses(exe, { enableCookieEncryption: undefined })).not.toThrow();
  });
});

describe('assertNoDefaultApp', () => {
  it('throws while resources/default_app.asar is there', () => {
    mkdirSync(join(dir, 'resources'), { recursive: true });
    expect(() => assertNoDefaultApp(dir)).not.toThrow();
    writeFileSync(join(dir, 'resources', 'default_app.asar'), 'x');
    expect(() => assertNoDefaultApp(dir)).toThrow(/default_app\.asar/);
  });
});

describe('the Electron in node_modules (what the tests and the smoke run use)', () => {
  const electronExe = ((): string | null => {
    try {
      const resolved: unknown = createRequire(import.meta.url)('electron');
      return typeof resolved === 'string' && existsSync(resolved) ? resolved : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(electronExe === null)('keeps the default fuses: it is not the packaged app, so RunAsNode and --inspect stay on', () => {
    const fuses = readFuses(electronExe ?? '');
    expect(Object.keys(fuses)).toEqual([...FUSE_NAMES]);
    expect(fuses.runAsNode).toBe('enabled');
    expect(fuses.enableNodeCliInspectArguments).toBe('enabled');
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe('enabled');
    expect(fuses.onlyLoadAppFromAsar).toBe('disabled');
  });
});
