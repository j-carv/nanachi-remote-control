import { createHash } from 'node:crypto';

export const PREVIEW_OPEN_PATH = '/__nanachi_preview/open';
export const PREVIEW_REDEEM_PATH = '/__nanachi_preview/redeem';

const SCRIPT = `(() => {
  const language = navigator.language.toLowerCase().startsWith('pt') ? 'pt' : navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
  const messages = {
    pt: { title: 'Prévia do projeto', loading: 'Abrindo prévia…', failed: 'Não foi possível abrir a prévia. Volte ao Nanachi e toque em Abrir prévia novamente.' },
    en: { title: 'Project preview', loading: 'Opening preview…', failed: 'The preview could not be opened. Return to Nanachi and tap Open preview again.' },
    es: { title: 'Vista previa del proyecto', loading: 'Abriendo vista previa…', failed: 'No se pudo abrir la vista previa. Vuelve a Nanachi y pulsa Abrir vista previa de nuevo.' },
  }[language];
  document.title = messages.title;
  const status = document.getElementById('status');
  status.textContent = messages.loading;
  const ticket = location.hash.slice(1);
  history.replaceState(null, '', '${PREVIEW_OPEN_PATH}');
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) { status.textContent = messages.failed; return; }
  fetch('${PREVIEW_REDEEM_PATH}', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ ticket }), redirect: 'error',
  }).then(async response => {
    if (!response.ok) throw new Error();
    const result = await response.json();
    const target = new URL(result.path, location.origin);
    if (target.origin !== location.origin) throw new Error();
    location.replace(target.href);
  }).catch(() => { status.textContent = messages.failed; });
})();`;

export const PREVIEW_BOOTSTRAP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nanachi preview</title><style>:root{color-scheme:light dark;font:16px system-ui}body{margin:0;padding:32px;line-height:1.5}main{max-width:36rem;margin:auto}</style></head><body><main><p id="status" role="status">Nanachi preview</p><noscript>JavaScript is required to open this preview.</noscript></main><script>${SCRIPT}</script></body></html>`;
export const PREVIEW_BOOTSTRAP_CSP = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
