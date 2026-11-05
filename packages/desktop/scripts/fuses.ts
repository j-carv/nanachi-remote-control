import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads the Electron fuses back out of a packaged exe, so the packaging script (and its tests) can check that what
 * electron-builder was asked to flip is what shipped. The fuse wire is a sentinel string in the binary followed by a
 * version byte, a length byte and one state byte per fuse ('0' off, '1' on, 'r' removed); this is the same format
 * `@electron/fuses` reads and writes, parsed here so the check needs no extra dependency.
 */

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** Fuse V1, in wire order. The names are the keys of electron-builder's `electronFuses`. */
export const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
] as const;

export type FuseName = (typeof FUSE_NAMES)[number];
export type FuseState = 'enabled' | 'disabled' | 'removed' | 'unknown';
export type FuseReading = Partial<Record<FuseName, FuseState>>;

function stateOf(byte: number): FuseState {
  switch (byte) {
    case 0x31:
      return 'enabled';
    case 0x30:
      return 'disabled';
    case 0x72:
      return 'removed';
    default:
      return 'unknown';
  }
}

/** The fuse states of an Electron binary. Throws when the binary has no fuse wire or a version this reader does not know. */
export function parseFuseWire(binary: Buffer): FuseReading {
  const at = binary.indexOf(SENTINEL);
  if (at === -1) throw new Error('o binário não tem o fio de fuses do Electron (é um Electron 12 ou mais novo?)');
  const position = at + SENTINEL.length;
  const version = binary[position];
  const length = binary[position + 1];
  if (version !== 1 || length === undefined) throw new Error(`versão de fuses não suportada: ${String(version)}`);
  const reading: FuseReading = {};
  FUSE_NAMES.forEach((name, index) => {
    if (index >= length) return;
    const byte = binary[position + 2 + index];
    if (byte !== undefined) reading[name] = stateOf(byte);
  });
  return reading;
}

export function readFuses(exePath: string): FuseReading {
  return parseFuseWire(readFileSync(exePath));
}

/** Throws, naming every fuse that is not as expected (`true` = enabled, `false` = disabled). */
export function verifyFuses(exePath: string, expected: Partial<Record<FuseName, boolean | undefined>>): void {
  const actual = readFuses(exePath);
  const wrong: string[] = [];
  for (const name of FUSE_NAMES) {
    const wanted = expected[name];
    if (wanted === undefined) continue;
    const state = actual[name];
    if (state !== (wanted ? 'enabled' : 'disabled')) {
      wrong.push(`${name}: esperado ${wanted ? 'ligado' : 'desligado'}, está ${state ?? 'ausente'}`);
    }
  }
  if (wrong.length > 0) throw new Error(`fuses do Electron diferentes do configurado em ${exePath}\n  ${wrong.join('\n  ')}`);
}

/** The unpacked app must not carry Electron's own "default app" (it runs when no app is found). */
export function assertNoDefaultApp(appOutDir: string): void {
  if (existsSync(join(appOutDir, 'resources', 'default_app.asar'))) {
    throw new Error(`resources/default_app.asar ficou em ${appOutDir}`);
  }
}
