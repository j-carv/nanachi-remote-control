import { resolve } from 'node:path';
import extract from 'extract-zip';

/**
 * Unzips the payload into `dir` with `extract-zip` (yauzl underneath: zip-slip safe, streams, zip64). `onBytes`
 * receives the uncompressed bytes of the entries started so far, which the installer turns into the progress bar.
 */
export async function extractPayload(zipPath: string, dir: string, onBytes: (done: number) => void): Promise<void> {
  let done = 0;
  await extract(zipPath, {
    dir: resolve(dir),
    onEntry: (entry) => {
      done += entry.uncompressedSize;
      onBytes(done);
    },
  });
}
