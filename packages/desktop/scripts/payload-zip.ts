import { createWriteStream, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { PAYLOAD_META, PAYLOAD_ZIP } from '../src/install/constants.js';
import { buildPayloadMeta, type PayloadMeta } from '../src/install/payload.js';

/**
 * Zips an unpacked app folder (`release\win-unpacked`) into the installer's payload with `yazl`: `payload.zip` with the
 * folder's contents at its root, plus `payload.json` with what the installer needs for its progress bar. Written to a
 * `.part` file and renamed, so a half-written zip is never mistaken for a payload.
 */

interface Entry {
  /** Absolute path on disk. */
  path: string;
  /** Path inside the zip, with forward slashes. */
  name: string;
  directory: boolean;
}

/** Every file and every empty folder below `root`, sorted, so two runs over the same folder give the same zip. */
export function listEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  function walk(dir: string, prefix: string): void {
    const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (children.length === 0 && prefix !== '') entries.push({ path: dir, name: prefix, directory: true });
    for (const child of children) {
      const path = join(dir, child.name);
      const name = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (child.isDirectory()) walk(path, name);
      else entries.push({ path, name, directory: false });
    }
  }
  walk(root, '');
  return entries;
}

export interface PayloadResult {
  zipPath: string;
  metaPath: string;
  meta: PayloadMeta;
  /** Size of the zip on disk. */
  zipBytes: number;
}

export async function createPayload(
  sourceDir: string,
  outDir: string,
  version: string,
  log: (line: string) => void = () => undefined,
): Promise<PayloadResult> {
  const entries = listEntries(sourceDir);
  const files = entries.filter((entry) => !entry.directory);
  if (files.length === 0) throw new Error(`nada para empacotar em ${sourceDir}`);
  if (!files.some((entry) => entry.name === 'Nanachi.exe')) throw new Error(`${sourceDir} não tem Nanachi.exe`);

  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, PAYLOAD_ZIP);
  const metaPath = join(outDir, PAYLOAD_META);
  const partial = `${zipPath}.part`;
  rmSync(partial, { force: true });
  rmSync(metaPath, { force: true });

  const zip = new yazl.ZipFile();
  let bytes = 0;
  for (const entry of entries) {
    if (entry.directory) {
      zip.addEmptyDirectory(entry.name);
      continue;
    }
    const stats = lstatSync(entry.path);
    if (stats.isSymbolicLink()) throw new Error(`link simbólico no payload: ${entry.path}`);
    bytes += stats.size;
    zip.addFile(entry.path, entry.name, { mtime: stats.mtime, mode: stats.mode });
  }
  zip.end();
  log(`  zipando ${files.length} arquivos (${(bytes / (1024 * 1024)).toFixed(0)} MiB sem compressão)…`);
  await pipeline(zip.outputStream, createWriteStream(partial));
  rmSync(zipPath, { force: true });
  renameSync(partial, zipPath);

  const meta = buildPayloadMeta({ version, files: files.length, uncompressedBytes: bytes });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { zipPath, metaPath, meta, zipBytes: statSync(zipPath).size };
}
