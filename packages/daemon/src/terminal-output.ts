import { StringDecoder } from 'node:string_decoder';

/** Janela de agregação da saída do terminal: o que chega dentro dela vira um evento só. */
export const TERMINAL_WINDOW_MS = 50;
/** Teto de bytes (UTF-8) por evento `terminal_output`. */
export const TERMINAL_CHUNK_BYTES = 16 * 1024;
/** Saída guardada por sessão de terminal (bytes de `data`). Passou disso, apaga-se a mais antiga. */
export const TERMINAL_RETENTION_BYTES = 8 * 1024 * 1024;

export interface OutputBatcherOptions {
  /** Recebe cada pedaço pronto, em ordem. Nunca é chamado com texto vazio. */
  onFlush(data: string): void;
  windowMs?: number;
  maxBytes?: number;
}

/** Pega o maior prefixo de `text` com até `maxBytes` bytes UTF-8, sem partir um caractere. */
function takePrefix(text: string, maxBytes: number): { head: string; rest: string; headBytes: number } {
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += char.length;
  }
  return { head: text.slice(0, index), rest: text.slice(index), headBytes: bytes };
}

/**
 * Agrega a saída de um PTY: emite um evento por janela de 50 ms ou por 16 KiB, o que vier antes.
 * Bytes UTF-8 são decodificados em modo streaming, então um caractere partido entre dois chunks sai inteiro.
 * `end()` descarrega tudo e para; chegadas depois disso são descartadas.
 */
export class OutputBatcher {
  private readonly decoder = new StringDecoder('utf8');
  private readonly windowMs: number;
  private readonly maxBytes: number;
  private pending = '';
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;

  constructor(private readonly options: OutputBatcherOptions) {
    this.windowMs = options.windowMs ?? TERMINAL_WINDOW_MS;
    this.maxBytes = options.maxBytes ?? TERMINAL_CHUNK_BYTES;
  }

  push(chunk: string | Buffer): void {
    if (this.ended) return;
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (text.length === 0) return;

    this.pending += text;
    this.pendingBytes += Buffer.byteLength(text, 'utf8');
    while (this.pendingBytes >= this.maxBytes) {
      const { head, rest, headBytes } = takePrefix(this.pending, this.maxBytes);
      this.pending = rest;
      this.pendingBytes -= headBytes;
      this.options.onFlush(head);
    }

    if (this.pending.length === 0) {
      this.clearTimer();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
    }
  }

  /** Descarrega o pendente e encerra. Bytes UTF-8 incompletos viram U+FFFD. */
  end(): void {
    if (this.ended) return;
    this.push(this.decoder.end());
    this.flush();
    this.ended = true;
  }

  private flush(): void {
    this.clearTimer();
    if (this.pending.length === 0) return;
    const data = this.pending;
    this.pending = '';
    this.pendingBytes = 0;
    this.options.onFlush(data);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
