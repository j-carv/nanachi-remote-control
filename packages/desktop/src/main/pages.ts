import type { DaemonStatus } from '../common/types.js';

/**
 * Small local pages (pairing window, "daemon not ready" page). Plain HTML and CSS in the monochrome style of
 * `docs/DESIGN.md`: the same `--ui-*` tokens, light and dark by `prefers-color-scheme`, no colour except the error
 * tone, no emoji, nothing loaded from the network.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_CSS = `
:root {
  color-scheme: light dark;
  --ui-background: oklch(0.985 0 0);
  --ui-foreground: oklch(0.145 0 0);
  --ui-card: oklch(1 0 0);
  --ui-muted: oklch(0.955 0 0);
  --ui-muted-foreground: oklch(0.47 0 0);
  --ui-border: oklch(0.9 0 0);
  --ui-destructive: oklch(0.5 0.15 27);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ui-background: oklch(0.145 0 0);
    --ui-foreground: oklch(0.985 0 0);
    --ui-card: oklch(0.19 0 0);
    --ui-muted: oklch(0.25 0 0);
    --ui-muted-foreground: oklch(0.72 0 0);
    --ui-border: oklch(0.3 0 0);
    --ui-destructive: oklch(0.74 0.13 25);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--ui-background);
  color: var(--ui-foreground);
  font: 15px/1.45 'Segoe UI', system-ui, -apple-system, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  -webkit-user-select: none;
  user-select: none;
}
main { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 16px; }
h1 { margin: 0; font-size: 14px; font-weight: 500; color: var(--ui-muted-foreground); }
.muted { color: var(--ui-muted-foreground); font-size: 14px; margin: 0; }
.card {
  background: var(--ui-card);
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  padding: 16px;
}
.mono { font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace; }
`;

function page(options: { title: string; csp: string; css: string; body: string; script?: string; nonce?: string }): string {
  const script =
    options.script !== undefined && options.nonce !== undefined
      ? `<script nonce="${escapeHtml(options.nonce)}">${options.script}</script>`
      : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${options.csp}">
<title>${escapeHtml(options.title)}</title>
<style>${BASE_CSS}${options.css}</style>
</head>
<body>
${options.body}
${script}
</body>
</html>`;
}

/** `123456` shown as `123 456`: easier to read aloud and to type. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export interface PairingPageInput {
  code: string;
  /** Epoch ms. */
  expiresAt: number;
  /** `data:image/png;base64,...` of the QR for the code. */
  qrDataUrl: string;
  /** Random per page: lets the countdown script run under a strict CSP. */
  nonce: string;
  now: number;
}

const PAIRING_CSS = `
.code {
  font-size: 40px; font-weight: 600; letter-spacing: 0.08em; text-align: center;
  font-variant-numeric: tabular-nums; margin: 4px 0;
}
.qr { display: flex; justify-content: center; }
.qr img { width: 184px; height: 184px; background: #fff; padding: 8px; border-radius: 12px; image-rendering: pixelated; }
.center { text-align: center; }
.expired .code, .expired .qr { opacity: 0.35; }
`;

/** Counts down to `expiresAt` once a second; at zero the page says the code expired. */
const PAIRING_SCRIPT = `
(function () {
  var root = document.getElementById('pairing');
  var label = document.getElementById('remaining');
  var expiresAt = Number(root.getAttribute('data-expires-at'));
  function tick() {
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left === 0) {
      root.classList.add('expired');
      label.textContent = 'Código expirado. Gere outro pelo ícone do Nanachi.';
      return;
    }
    var m = String(Math.floor(left / 60)).padStart(2, '0');
    var s = String(left % 60).padStart(2, '0');
    label.textContent = 'Expira em ' + m + ':' + s;
    setTimeout(tick, 1000);
  }
  tick();
})();
`;

export function formatRemaining(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  if (left === 0) return 'Código expirado. Gere outro pelo ícone do Nanachi.';
  const minutes = String(Math.floor(left / 60)).padStart(2, '0');
  const seconds = String(left % 60).padStart(2, '0');
  return `Expira em ${minutes}:${seconds}`;
}

/** The pairing window: code, countdown and QR. The QR image is the only thing that is not text. */
export function renderPairingHtml(input: PairingPageInput): string {
  if (!/^[0-9]{6}$/.test(input.code)) throw new Error('código de pareamento inválido');
  if (!input.qrDataUrl.startsWith('data:image/png;base64,')) throw new Error('QR inválido');
  const body = `<main id="pairing" data-expires-at="${Math.trunc(input.expiresAt)}">
  <h1>Nanachi · Código de pareamento</h1>
  <div class="card">
    <div class="code mono" aria-label="Código ${escapeHtml(input.code)}">${escapeHtml(groupCode(input.code))}</div>
    <p class="muted center" id="remaining">${escapeHtml(formatRemaining(input.expiresAt, input.now))}</p>
  </div>
  <div class="qr"><img src="${escapeHtml(input.qrDataUrl)}" alt="QR do código ${escapeHtml(input.code)}"></div>
  <p class="muted center">No outro aparelho, abra o Nanachi, adicione uma máquina e digite o código. Uso único.</p>
</main>`;
  return page({
    title: 'Código de pareamento',
    csp: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(input.nonce)}'`,
    css: PAIRING_CSS,
    body,
    script: PAIRING_SCRIPT,
    nonce: input.nonce,
  });
}

const STATUS_CSS = `
.error { color: var(--ui-destructive); }
.card > :first-child { margin-top: 0; }
.card > :last-child { margin-bottom: 0; }
pre {
  font-weight: 400; margin: 0; padding: 12px; max-height: 240px; overflow: auto; background: var(--ui-muted);
  border-radius: 8px; font-size: 12px; white-space: pre-wrap; word-break: break-word; user-select: text;
}
`;

/** Shown in the panel window while the daemon is not ready (starting, stopped, or gave up). No script at all. */
export function renderStatusPageHtml(
  status: Pick<DaemonStatus, 'state' | 'message' | 'logTail' | 'port'> & { restricted?: boolean },
): string {
  const headline: Record<DaemonStatus['state'], string> = {
    starting: 'Iniciando o daemon',
    running: 'Abrindo o painel',
    attached: 'Abrindo o painel',
    stopped: 'O daemon está parado',
    error: 'O daemon não conseguiu iniciar',
  };
  const restricted = status.restricted === true;
  const title = restricted ? 'O painel local não consegue usar este daemon' : headline[status.state];
  const detail =
    status.message ??
    (status.state === 'starting' ? `Aguardando o daemon responder na porta ${status.port}.` : 'Nada para mostrar ainda.');
  const log =
    status.logTail.length > 0
      ? `<div class="card"><p class="muted">Últimas linhas do log</p><pre class="mono">${escapeHtml(status.logTail.join('\n'))}</pre></div>`
      : '';
  const body = `<main>
  <h1>Nanachi</h1>
  <div class="card">
    <p${status.state === 'error' || restricted ? ' class="error"' : ''}>${escapeHtml(title)}</p>
    <p class="muted">${escapeHtml(detail)}</p>
  </div>
  ${log}
</main>`;
  return page({
    title: 'Nanachi',
    csp: `default-src 'none'; style-src 'unsafe-inline'`,
    css: STATUS_CSS,
    body,
  });
}

export function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
