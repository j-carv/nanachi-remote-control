import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../common/i18n/index.js';
import { EXE_NAME, PAYLOAD_META, PAYLOAD_ZIP } from './constants.js';

/** `payload.json` next to `payload.zip`: written when the zip is built, read by the installer. */
export interface PayloadMeta {
  schema: 1;
  version: string;
  /** The app's executable inside the zip. */
  exe: string;
  /** Number of files in the zip. */
  files: number;
  /** Sum of the uncompressed sizes; the installer's progress bar is measured against it. */
  uncompressedBytes: number;
}

export interface Payload {
  zipPath: string;
  meta: PayloadMeta;
}

export function parsePayloadMeta(raw: unknown): PayloadMeta {
  if (typeof raw !== 'object' || raw === null) throw new Error(t('installer.payload.invalid'));
  const record = raw as Record<string, unknown>;
  const { schema, version, exe, files, uncompressedBytes } = record;
  if (schema !== 1) throw new Error(t('installer.payload.unknownSchema'));
  if (typeof version !== 'string' || version === '') throw new Error(t('installer.payload.noVersion'));
  if (typeof exe !== 'string' || exe === '' || exe.includes('/') || exe.includes('\\')) throw new Error(t('installer.payload.badExe'));
  if (typeof files !== 'number' || !Number.isInteger(files) || files < 1) throw new Error(t('installer.payload.badFiles'));
  if (typeof uncompressedBytes !== 'number' || !Number.isFinite(uncompressedBytes) || uncompressedBytes < 1) {
    throw new Error(t('installer.payload.badBytes'));
  }
  return { schema: 1, version, exe, files, uncompressedBytes };
}

export function buildPayloadMeta(input: { version: string; files: number; uncompressedBytes: number }): PayloadMeta {
  return { schema: 1, version: input.version, exe: EXE_NAME, files: input.files, uncompressedBytes: input.uncompressedBytes };
}

/** Reads the payload folder (`payload.zip` + `payload.json`). Throws a readable error when it is missing or broken. */
export function readPayload(dir: string): Payload {
  const zipPath = join(dir, PAYLOAD_ZIP);
  const metaPath = join(dir, PAYLOAD_META);
  if (!existsSync(zipPath) || !existsSync(metaPath)) {
    throw new Error(t('installer.errors.payloadMissing', { path: zipPath }));
  }
  const meta = parsePayloadMeta(JSON.parse(readFileSync(metaPath, 'utf8')));
  return { zipPath, meta };
}
