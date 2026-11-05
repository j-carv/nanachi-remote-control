import * as nodeFs from 'node:fs';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { extractPayload } from '../src/install/extract.js';
import type { InstallDeps, InstallProgress } from '../src/install/install.js';
import { buildPayloadMeta, type Payload } from '../src/install/payload.js';
import { removeTree } from '../src/install/safe-remove.js';

/** What a tiny `win-unpacked` looks like to the installer, including a non-ASCII folder and an `app.asar`. */
export const SAMPLE_FILES: Record<string, string> = {
  'Nanachi.exe': 'MZ fake exe',
  'resources/app.asar': 'fake asar archive',
  'resources/runtime/node.exe': 'MZ fake node',
  'resources/runtime/packages/daemon/dist/main.js': 'console.log("daemon")',
  'resources/bin/nanachi-tsnet.exe': 'MZ fake sidecar',
  'locales/Área de Trabalho.pak': 'accented name',
};

export async function writeZip(zipPath: string, files: Record<string, string>): Promise<{ files: number; bytes: number }> {
  const zip = new yazl.ZipFile();
  let bytes = 0;
  for (const [name, content] of Object.entries(files)) {
    const buffer = Buffer.from(content, 'utf8');
    bytes += buffer.length;
    zip.addBuffer(buffer, name);
  }
  zip.end();
  mkdirSync(dirname(zipPath), { recursive: true });
  await pipeline(zip.outputStream, createWriteStream(zipPath));
  return { files: Object.keys(files).length, bytes };
}

/**
 * A zip with an entry named `../escaped.txt` (a zip-slip attempt). yazl refuses to write such a name, so the entry is
 * written as `zz/escaped.txt` and the two bytes are patched in the local header and the central directory.
 */
export async function writeSlipZip(zipPath: string): Promise<void> {
  const plain = join(dirname(zipPath), 'slip-plain.zip');
  await writeZip(plain, { 'Nanachi.exe': 'MZ', 'zz/escaped.txt': 'pwned' });
  const bytes = readFileSync(plain);
  const needle = Buffer.from('zz/escaped.txt');
  const patched = Buffer.from('../escaped.txt');
  let at = bytes.indexOf(needle);
  let count = 0;
  while (at !== -1) {
    patched.copy(bytes, at);
    count += 1;
    at = bytes.indexOf(needle, at + 1);
  }
  if (count < 2) throw new Error('slip zip: entry name not found twice');
  writeFileSync(zipPath, bytes);
}

export async function makePayload(dir: string, files: Record<string, string> = SAMPLE_FILES, version = '1.2.3'): Promise<Payload> {
  const zipPath = join(dir, 'payload.zip');
  const { files: count, bytes } = await writeZip(zipPath, files);
  const meta = buildPayloadMeta({ version, files: count, uncompressedBytes: bytes });
  writeFileSync(join(dir, 'payload.json'), `${JSON.stringify(meta)}\n`);
  return { zipPath, meta };
}

export interface Sandbox {
  root: string;
  profile: string;
  /** Desktop's own data folder (`.nanachi-desktop`). */
  desktopHome: string;
  /** The standalone daemon's data folder (`.nanachi-remote`), which Desktop never touches. */
  standaloneHome: string;
  startMenuDir: string;
  desktopDir: string;
  target: string;
  cleanup(): void;
}

/** A fake user profile in a temp folder: nothing here is the real profile, Start Menu or data folder. */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'nanachi-install-test-'));
  const profile = join(root, 'profile');
  const sandbox: Sandbox = {
    root,
    profile,
    desktopHome: join(profile, '.nanachi-desktop'),
    standaloneHome: join(profile, '.nanachi-remote'),
    startMenuDir: join(profile, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    desktopDir: join(profile, 'Desktop'),
    target: join(root, 'Programs', 'Nanachi'),
    // A sandbox can hold junctions to other sandbox folders: never delete through them.
    cleanup: () => void removeTree(root, nodeFs),
  };
  mkdirSync(profile, { recursive: true });
  return sandbox;
}

export interface Recorder {
  events: InstallProgress[];
  shortcuts: Array<Parameters<InstallDeps['writeShortcut']>[0]>;
  startup: Array<{ enabled: boolean; exe: string }>;
  reg: string[][];
  stopped: number[][];
}

/** Install deps with the OS integration faked and the file work real (zip extraction into a temp folder). */
export function makeInstallDeps(
  sandbox: Sandbox,
  payload: Payload,
  overrides: Partial<InstallDeps> = {},
): { deps: InstallDeps; recorder: Recorder } {
  const recorder: Recorder = { events: [], shortcuts: [], startup: [], reg: [], stopped: [] };
  const deps: InstallDeps = {
    payload,
    profile: sandbox.profile,
    desktopHome: sandbox.desktopHome,
    startMenuDir: sandbox.startMenuDir,
    desktopDir: sandbox.desktopDir,
    extract: extractPayload,
    findRunning: () => Promise.resolve([]),
    stopProcesses: (pids) => {
      recorder.stopped.push(pids);
      return Promise.resolve();
    },
    confirmClose: () => Promise.resolve(true),
    writeShortcut: (spec) => {
      recorder.shortcuts.push(spec);
      return true;
    },
    setStartup: (enabled, exe) => void recorder.startup.push({ enabled, exe }),
    runReg: (args) => {
      recorder.reg.push(args);
      return Promise.resolve(0);
    },
    emit: (progress) => void recorder.events.push(progress),
    sleep: () => Promise.resolve(),
    removeOptions: { sleep: () => undefined },
    ...overrides,
  };
  return { deps, recorder };
}

/** A directory junction at `link` pointing to `target` (no admin needed on Windows). */
export function makeJunction(target: string, link: string): void {
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(target, link, 'junction');
}
