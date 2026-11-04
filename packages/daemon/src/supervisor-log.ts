import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

export interface RotatingLogOptions {
  file: string;
  /** Ao passar deste tamanho, o arquivo vira `<file>.1` (substituindo o anterior) e começa de novo. */
  maxBytes: number;
  /** Recebe cada linha também (o supervisor usa isso quando roda num console). */
  echo?: ((line: string) => void) | undefined;
  clock?: () => Date;
}

export interface RotatingLog {
  /** Grava o texto linha a linha, cada uma com horário e origem (`[daemon]`, `[supervisor]`...). */
  write(source: string, text: string): void;
}

export function createRotatingLog(options: RotatingLogOptions): RotatingLog {
  const clock = options.clock ?? (() => new Date());
  let size = existsSync(options.file) ? statSync(options.file).size : 0;

  return {
    write(source, text) {
      for (const raw of text.split(/\r?\n/)) {
        if (raw === '') continue;
        const line = `${clock().toISOString()} [${source}] ${raw}`;
        const bytes = Buffer.byteLength(`${line}\n`);
        if (size > 0 && size + bytes > options.maxBytes) {
          renameSync(options.file, `${options.file}.1`);
          size = 0;
        }
        appendFileSync(options.file, `${line}\n`);
        size += bytes;
        options.echo?.(line);
      }
    },
  };
}
