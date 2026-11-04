import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileInfoSchema } from '@nanachi/shared';
import { MAX_FILE_BYTES } from './file-names.js';

/*
 * `phone-send`: manda um arquivo (ou uma captura da tela) do PC para o celular, pela sessão que chamou.
 * Roda como CLI em dist/phone-send.js (pelos launchers em bin/) e recebe do daemon, no env do agente:
 * AGENT_SESSION_ID, NANACHI_URL e NANACHI_AGENT_TOKEN.
 */

export interface PhoneSendIO {
  out(line: string): void;
  err(line: string): void;
}

export interface PhoneSendDeps {
  fetch: typeof fetch;
  platform: NodeJS.Platform;
  /** Grava uma captura de todos os monitores em PNG no caminho dado. Só Windows. */
  captureScreenshot(target: string): Promise<void>;
}

export const NO_SESSION_MESSAGE = 'phone-send só funciona dentro de uma sessão do Nanachi Remote';
const USAGE = 'uso: phone-send <arquivo> [--caption "texto"]   ou   phone-send --screenshot [--caption "texto"]';
const TOO_LARGE_MESSAGE = 'arquivo maior que 50 MiB';
const UPLOAD_TIMEOUT_MS = 120_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;

const MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.zip', 'application/zip'],
]);

export type PhoneSendArgs = { kind: 'file'; path: string; caption?: string } | { kind: 'screenshot'; caption?: string };

export type ParseResult = { ok: true; value: PhoneSendArgs } | { ok: false; error: string };

/** Lê `<arquivo> [--caption texto]` ou `--screenshot [--caption texto]`. Nunca lança. */
export function parsePhoneSendArgs(argv: readonly string[]): ParseResult {
  const pending = [...argv];
  const positional: string[] = [];
  let screenshot = false;
  let caption: string | undefined;

  while (pending.length > 0) {
    const arg = pending.shift();
    if (arg === undefined) break;
    if (arg === '--screenshot') {
      screenshot = true;
    } else if (arg === '--caption') {
      const value = pending.shift();
      if (value === undefined) return { ok: false, error: '--caption precisa de um texto' };
      caption = value;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `opção desconhecida: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const withCaption = caption !== undefined && caption.length > 0 ? { caption } : {};
  if (screenshot) {
    if (positional.length > 0) return { ok: false, error: '--screenshot não recebe arquivo' };
    return { ok: true, value: { kind: 'screenshot', ...withCaption } };
  }
  if (positional.length === 0) return { ok: false, error: 'falta o arquivo a enviar' };
  if (positional.length > 1) return { ok: false, error: 'envie um arquivo por vez' };
  return { ok: true, value: { kind: 'file', path: positional[0] ?? '', ...withCaption } };
}

/** Tipo MIME pela extensão. Desconhecida → application/octet-stream. */
export function mimeFromName(name: string): string {
  return MIME_BY_EXTENSION.get(extname(name).toLowerCase()) ?? 'application/octet-stream';
}

interface Upload {
  name: string;
  mime: string;
  bytes: Buffer;
}

class PhoneSendError extends Error {}

function checkSize(size: number): void {
  if (size > MAX_FILE_BYTES) throw new PhoneSendError(TOO_LARGE_MESSAGE);
}

async function readArgFile(path: string): Promise<Upload> {
  const absolute = resolve(path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    throw new PhoneSendError(`arquivo não encontrado: ${path}`);
  }
  if (!info.isFile()) throw new PhoneSendError(`não é um arquivo: ${path}`);
  checkSize(info.size);

  const name = basename(absolute);
  return { name, mime: mimeFromName(name), bytes: await readFile(absolute) };
}

async function takeScreenshot(deps: PhoneSendDeps): Promise<Upload> {
  if (deps.platform !== 'win32') throw new PhoneSendError('--screenshot só funciona no Windows');
  const target = join(tmpdir(), `nanachi-captura-${randomUUID()}.png`);
  try {
    await deps.captureScreenshot(target);
    const bytes = await readFile(target);
    checkSize(bytes.length);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return { name: `captura-${stamp}.png`, mime: 'image/png', bytes };
  } finally {
    await rm(target, { force: true });
  }
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PNG de todos os monitores (SystemInformation.VirtualScreen) via PowerShell. Usa -EncodedCommand para não
 * depender de aspas no caminho. Tempo limite de 30 s.
 */
export function captureVirtualScreen(target: string): Promise<void> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save(${psString(target)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), SCREENSHOT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`não foi possível capturar a tela: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      const detail = stderr.trim().slice(0, 300);
      reject(new Error(`não foi possível capturar a tela${detail.length > 0 ? `: ${detail}` : ''}`));
    });
  });
}

function messageForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'o Nanachi Remote não reconhece o token desta sessão';
    case 403:
      return 'esta sessão não está mais ativa no Nanachi Remote';
    case 413:
      return TOO_LARGE_MESSAGE;
    case 400:
      return 'o Nanachi Remote recusou o arquivo (dados inválidos)';
    default:
      return `falha ao enviar (HTTP ${status})`;
  }
}

/** Executa o `phone-send` e devolve o código de saída (0 enviado, 1 erro). */
export async function runPhoneSend(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: PhoneSendIO,
  deps: PhoneSendDeps = defaultDeps(),
): Promise<number> {
  const baseUrl = env.NANACHI_URL;
  const sessionId = env.AGENT_SESSION_ID;
  const token = env.NANACHI_AGENT_TOKEN;
  if (!baseUrl || !sessionId || !token) {
    io.err(NO_SESSION_MESSAGE);
    return 1;
  }

  const parsed = parsePhoneSendArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.error);
    io.err(USAGE);
    return 1;
  }
  const args = parsed.value;

  let upload: Upload;
  try {
    upload = args.kind === 'file' ? await readArgFile(args.path) : await takeScreenshot(deps);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const headers: Record<string, string> = {
    'X-Nanachi-Session': sessionId,
    'X-Nanachi-Agent-Token': token,
    'X-File-Name': encodeURIComponent(upload.name),
    'Content-Type': upload.mime,
  };
  if (args.caption !== undefined) headers['X-Caption'] = encodeURIComponent(args.caption);

  let response: Response;
  try {
    response = await deps.fetch(`${baseUrl}/api/agent/files`, {
      method: 'POST',
      headers,
      body: upload.bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    io.err(`não foi possível falar com o Nanachi Remote (${baseUrl})`);
    return 1;
  }

  if (response.status !== 201) {
    io.err(messageForStatus(response.status));
    return 1;
  }
  const info = FileInfoSchema.safeParse(await response.json().catch(() => undefined));
  if (!info.success) {
    io.err('resposta inesperada do Nanachi Remote');
    return 1;
  }
  io.out(`enviado: ${info.data.name}`);
  return 0;
}

function defaultDeps(): PhoneSendDeps {
  return { fetch: globalThis.fetch, platform: process.platform, captureScreenshot: captureVirtualScreen };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  runPhoneSend(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then((code) => {
    process.exitCode = code;
  });
}
