/**
 * The small local page of the pairing window. Plain HTML and CSS in the monochrome style of
 * `docs/DESIGN.md`: the same `--ui-*` tokens, light and dark by `prefers-color-scheme`, no colour except the error
 * tone, no emoji, nothing loaded from the network.
 */

import { readFileSync } from 'node:fs';
import { getLanguage, translate, type Language, type MessageKey, type Params } from '../common/i18n/index.js';

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

function page(options: {
  language: Language;
  title: string;
  csp: string;
  css: string;
  body: string;
  script?: string;
  nonce?: string;
}): string {
  const script =
    options.script !== undefined && options.nonce !== undefined
      ? `<script nonce="${escapeHtml(options.nonce)}">${options.script}</script>`
      : '';
  return `<!doctype html>
<html lang="${options.language}">
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
  /** The language of the page; Desktop's current one when absent. */
  language?: Language;
  code: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The QR image of the pairing link, when this PC has an address reachable from the phone. */
  qrDataUrl?: string | undefined;
  /** `data:image/png;base64,...` of the app mark (see `pngDataUrl`); the page has no mark without it. */
  logoDataUrl?: string | undefined;
  /** Random per page: lets the countdown script run under a strict CSP. */
  nonce: string;
  now: number;
}

const PAIRING_CSS = `
.logo { display: block; width: 36px; height: 36px; margin: 0 auto; border-radius: 8px; user-select: none; }
.code {
  font-size: 40px; font-weight: 600; letter-spacing: 0.08em; text-align: center;
  font-variant-numeric: tabular-nums; margin: 4px 0;
}
.qr { display: flex; justify-content: center; }
.qr img { width: 184px; height: 184px; background: #fff; padding: 8px; border-radius: 12px; image-rendering: pixelated; }
.center { text-align: center; }
.expired .code, .expired .qr { opacity: 0.35; }
`;

/**
 * Counts down to `expiresAt` once a second; at zero the page says the code expired. The words come from the page itself
 * (`data-expires-in`, with `{{time}}` where the clock goes, and `data-expired`), written by the main process in the page's
 * language, so the script holds no text of its own.
 */
const PAIRING_SCRIPT = `
(function () {
  var root = document.getElementById('pairing');
  var label = document.getElementById('remaining');
  var expiresAt = Number(root.getAttribute('data-expires-at'));
  var expiresIn = root.getAttribute('data-expires-in') || '';
  var expired = root.getAttribute('data-expired') || '';
  function tick() {
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left === 0) {
      root.classList.add('expired');
      label.textContent = expired;
      return;
    }
    var m = String(Math.floor(left / 60)).padStart(2, '0');
    var s = String(left % 60).padStart(2, '0');
    label.textContent = expiresIn.replace('{{time}}', m + ':' + s);
    setTimeout(tick, 1000);
  }
  tick();
})();
`;

/** The countdown line for `expiresAt` as seen at `now`, in `language` (Desktop's by default). */
export function formatRemaining(expiresAt: number, now: number, language: Language = getLanguage()): string {
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  if (left === 0) return translate(language, 'main.pairingWindow.expired');
  const minutes = String(Math.floor(left / 60)).padStart(2, '0');
  const seconds = String(left % 60).padStart(2, '0');
  return translate(language, 'main.pairingWindow.expiresIn', { time: `${minutes}:${seconds}` });
}

/** `data:image/png;base64,...` of a PNG file, or undefined when it cannot be read (the page then has no mark). */
export function pngDataUrl(path: string): string | undefined {
  try {
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** The pairing window: code, countdown and QR, with the app mark above the title. The images are the only things that are not text. */
export function renderPairingHtml(input: PairingPageInput): string {
  if (!/^[0-9]{6}$/.test(input.code)) throw new Error('código de pareamento inválido');
  if (input.qrDataUrl !== undefined && !input.qrDataUrl.startsWith('data:image/png;base64,')) throw new Error('QR inválido');
  if (input.logoDataUrl !== undefined && !input.logoDataUrl.startsWith('data:image/png;base64,')) throw new Error('logo inválido');
  const language = input.language ?? getLanguage();
  const text = (key: MessageKey, params?: Params): string => escapeHtml(translate(language, key, params));
  // `{{time}}` stays in the text the script reads: the script puts the clock there.
  const expiresIn = escapeHtml(translate(language, 'main.pairingWindow.expiresIn', { time: '{{time}}' }));
  // Decorative: the title beside it says what the window is, so the alt text is empty.
  const logo = input.logoDataUrl === undefined ? '' : `<img class="logo" src="${escapeHtml(input.logoDataUrl)}" alt="">\n  `;
  const qr = input.qrDataUrl === undefined
    ? ''
    : `<div class="qr"><img src="${escapeHtml(input.qrDataUrl)}" alt="${text('main.pairingWindow.qrAlt', { code: input.code })}"></div>`;
  const body = `<main id="pairing" data-expires-at="${Math.trunc(input.expiresAt)}" data-expires-in="${expiresIn}" data-expired="${text('main.pairingWindow.expired')}">
  ${logo}<h1>${text('main.pairingWindow.windowTitle')}</h1>
  <div class="card">
    <div class="code mono" aria-label="${text('main.pairingWindow.codeLabel', { code: input.code })}">${escapeHtml(groupCode(input.code))}</div>
    <p class="muted center" id="remaining">${escapeHtml(formatRemaining(input.expiresAt, input.now, language))}</p>
  </div>
  ${qr}
  <p class="muted center">${text(input.qrDataUrl === undefined ? 'main.pairingWindow.qrSetupHint' : 'main.pairingWindow.qrHint')}</p>
  <p class="muted center">${text('main.pairingWindow.hint')}</p>
</main>`;
  return page({
    language,
    title: translate(language, 'main.pairingWindow.pageTitle'),
    csp: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(input.nonce)}'`,
    css: PAIRING_CSS,
    body,
    script: PAIRING_SCRIPT,
    nonce: input.nonce,
  });
}

export function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
