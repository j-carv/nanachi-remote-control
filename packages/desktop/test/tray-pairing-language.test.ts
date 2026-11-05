import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, translate, type Language } from '../src/common/i18n/index.js';
import { statusLabel } from '../src/common/status-label.js';
import type { DaemonState, DaemonStatus } from '../src/common/types.js';
import { formatRemaining, renderPairingHtml } from '../src/main/pages.js';
import { buildTrayMenu, trayTooltip, type TrayActions } from '../src/main/tray-menu.js';

afterEach(() => setLanguage('pt-BR'));

const OTHERS = ['en', 'es'] as const;

function status(state: DaemonState, patch: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    state,
    port: 7811,
    mode: 'none',
    pid: null,
    version: null,
    machineName: null,
    restricted: false,
    message: null,
    logTail: [],
    ...patch,
  };
}

function actions(): TrayActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openControl: () => void calls.push('control'),
    openSessions: () => void calls.push('sessions'),
    generatePairingCode: () => void calls.push('pair'),
    setAutostart: (enabled) => void calls.push(`autostart:${enabled}`),
    quit: () => void calls.push('quit'),
  };
}

const MENU: Record<(typeof OTHERS)[number], string[]> = {
  en: ['Nanachi · running', 'separator', 'Open Nanachi', 'Open sessions', 'Generate pairing code', 'Start with Windows', 'separator', 'Quit'],
  es: [
    'Nanachi · en ejecución',
    'separator',
    'Abrir Nanachi',
    'Abrir sesiones',
    'Generar código de emparejamiento',
    'Iniciar con Windows',
    'separator',
    'Salir',
  ],
};

const STATUS_LINES: Record<(typeof OTHERS)[number], Record<DaemonState, string>> = {
  en: {
    starting: 'Nanachi · starting',
    running: 'Nanachi · running',
    attached: 'Nanachi · connected to the existing daemon',
    stopped: 'Nanachi · stopped',
    error: 'Nanachi · error',
  },
  es: {
    starting: 'Nanachi · iniciando',
    running: 'Nanachi · en ejecución',
    attached: 'Nanachi · conectado al daemon existente',
    stopped: 'Nanachi · detenido',
    error: 'Nanachi · error',
  },
};

describe.each(OTHERS)('tray menu in %s', (language) => {
  const menuOf = (state: DaemonState, patch: { autostart?: boolean; autostartSupported?: boolean } = {}, a = actions()) =>
    buildTrayMenu({ status: status(state), autostart: patch.autostart ?? false, autostartSupported: patch.autostartSupported ?? true, actions: a }, language);

  it('has every item of the contract, in order, in that language', () => {
    expect(menuOf('running').map((item) => item.label ?? item.type)).toEqual(MENU[language]);
  });

  it('writes the status line of every state in that language', () => {
    for (const state of Object.keys(STATUS_LINES[language]) as DaemonState[]) {
      expect(statusLabel({ state }, language), state).toBe(STATUS_LINES[language][state]);
      expect(menuOf(state)[0], state).toMatchObject({ label: STATUS_LINES[language][state], enabled: false });
    }
  });

  it('keeps no label of the Portuguese menu', () => {
    const portuguese = buildTrayMenu({ status: status('running'), autostart: false, autostartSupported: true, actions: actions() }, 'pt-BR');
    const labels = new Set(menuOf('running').map((item) => item.label));
    for (const item of portuguese) {
      if (item.label === 'Abrir Nanachi' && language === 'es') continue;
      if (item.label !== undefined) expect(labels.has(item.label), item.label).toBe(false);
    }
  });

  it('still offers a pairing code only while a daemon answers', () => {
    const label = translate(language, 'main.tray.pairingCode');
    const enabled = (state: DaemonState): boolean | undefined => menuOf(state).find((item) => item.label === label)?.enabled;
    expect(enabled('running')).toBe(true);
    expect(enabled('attached')).toBe(true);
    for (const state of ['starting', 'stopped', 'error'] as const) expect(enabled(state), state).toBe(false);
  });

  it('wires every click to its action and keeps the autostart checkbox state', () => {
    const a = actions();
    const menu = menuOf('attached', { autostart: true }, a);
    const click = (label: string, checked?: boolean): void => {
      const item = menu.find((entry) => entry.label === label);
      (item?.click as ((i: unknown) => void) | undefined)?.({ checked });
    };
    click(translate(language, 'main.tray.open'));
    click(translate(language, 'main.tray.openSessions'));
    click(translate(language, 'main.tray.pairingCode'));
    click(translate(language, 'main.tray.startWithWindows'), false);
    click(translate(language, 'main.tray.quit'));
    expect(a.calls).toEqual(['control', 'sessions', 'pair', 'autostart:false', 'quit']);
    expect(menu.find((item) => item.label === translate(language, 'main.tray.startWithWindows'))).toMatchObject({ type: 'checkbox', checked: true, enabled: true });
    expect(menuOf('running', { autostartSupported: false }).find((item) => item.type === 'checkbox')?.enabled).toBe(false);
  });

  it('the tooltip is the status line, with the reason on error, capped at 127 characters', () => {
    expect(trayTooltip(status('running'), language)).toBe(STATUS_LINES[language].running);
    expect(trayTooltip(status('error', { message: 'port 7811 busy' }), language)).toBe(`${STATUS_LINES[language].error}: port 7811 busy`);
    expect(trayTooltip(status('error', { message: 'x'.repeat(500) }), language)).toHaveLength(127);
  });
});

describe('tray menu follows the language of the process when none is given', () => {
  it('builds in pt-BR by default and in the language set with setLanguage', () => {
    const labels = () => buildTrayMenu({ status: status('running'), autostart: false, autostartSupported: true, actions: actions() }).map((item) => item.label ?? item.type);
    expect(labels()[2]).toBe('Abrir Nanachi');
    setLanguage('en');
    expect(labels()).toEqual(MENU.en);
    expect(trayTooltip(status('stopped'))).toBe('Nanachi · stopped');
    setLanguage('es');
    expect(labels()).toEqual(MENU.es);
    expect(trayTooltip(status('stopped'))).toBe('Nanachi · detenido');
  });
});

const NONCE = 'bm9uY2UxMjM0NTY3OA==';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/** The attributes of `<main id="pairing" ...>`, with the HTML entities of the page undone. */
function pageData(html: string): Record<string, string> {
  const tag = /<main id="pairing"([^>]*)>/.exec(html)?.[1] ?? '';
  const unescape = (text: string): string => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((match) => [match[1] ?? '', unescape(match[2] ?? '')]));
}

const PAIRING_TEXT: Record<(typeof OTHERS)[number], { title: string; page: string; label: string; qr: string; hint: string; expiresIn: string; expired: string }> = {
  en: {
    title: 'Nanachi · Pairing code',
    page: 'Pairing code',
    label: 'Code 004217',
    qr: 'QR code for 004217',
    hint: 'On the other device, open Nanachi, add a machine and type the code. Single use.',
    expiresIn: 'Expires in {{time}}',
    expired: 'Code expired. Generate another from the Nanachi icon.',
  },
  es: {
    title: 'Nanachi · Código de emparejamiento',
    page: 'Código de emparejamiento',
    label: 'Código 004217',
    qr: 'QR del código 004217',
    hint: 'En el otro dispositivo, abre Nanachi, agrega una máquina y escribe el código. De un solo uso.',
    expiresIn: 'Expira en {{time}}',
    expired: 'Código expirado. Genera otro desde el ícono de Nanachi.',
  },
};

describe.each(OTHERS)('pairing page in %s', (language) => {
  const html = renderPairingHtml({ language, code: '004217', expiresAt: 1_000_000 + 125_000, qrDataUrl: PNG, nonce: NONCE, now: 1_000_000 });
  const text = PAIRING_TEXT[language];

  it('declares its language and writes its texts in it', () => {
    expect(html).toContain(`<html lang="${language}">`);
    expect(html).toContain(`<title>${text.page}</title>`);
    expect(html).toContain(`<h1>${text.title}</h1>`);
    expect(html).toContain(`aria-label="${text.label}"`);
    expect(html).toContain(`alt="${text.qr}"`);
    expect(html).toContain(`<p class="muted center">${text.hint}</p>`);
    expect(html).toContain('004 217');
    expect(html).toContain('data-expires-at="1125000"');
  });

  it('shows the countdown in that language and gives the script its words as data', () => {
    expect(html).toContain(language === 'en' ? '>Expires in 02:05<' : '>Expira en 02:05<');
    expect(formatRemaining(61_000, 0, language)).toBe(language === 'en' ? 'Expires in 01:01' : 'Expira en 01:01');
    expect(formatRemaining(1_000, 5_000, language)).toBe(text.expired);
    const data = pageData(html);
    expect(data['data-expires-in']).toBe(text.expiresIn);
    expect(data['data-expired']).toBe(text.expired);
  });

  it('holds no Portuguese of the default page', () => {
    for (const word of ['Código de pareamento', 'Expira em', 'Gere outro', 'No outro aparelho', 'lang="pt-BR"']) expect(html).not.toContain(word);
    const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
    expect(script).not.toMatch(/[áàâãéêíóôõúç]/i);
  });

  it('is still a local page: strict CSP, nonce script, no network, no emoji, no innerHTML', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${NONCE}'`);
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(EMOJI.test(html)).toBe(false);
    const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('fetch');
  });

  it('has its texts escaped: the attributes of the page stay well formed', () => {
    const tag = /<main id="pairing"([^>]*)>/.exec(html)?.[1] ?? '';
    expect(tag.replace(/\s+[a-z-]+="[^"]*"/g, '').trim()).toBe('');
    expect(Object.keys(pageData(html)).sort()).toEqual(['data-expired', 'data-expires-at', 'data-expires-in']);
  });

  it('the page script counts down with the words of the page and says the code expired', () => {
    const script = html.slice(html.indexOf('>', html.indexOf('<script')) + 1, html.indexOf('</script>'));
    const data = pageData(html);
    let now = 1_000_000;
    const timer: { next: (() => void) | null } = { next: null };
    const label = { textContent: '' };
    const classes = new Set<string>();
    const root = { getAttribute: (name: string): string | null => data[name] ?? null, classList: { add: (name: string) => void classes.add(name) } };
    const document = { getElementById: (id: string) => (id === 'pairing' ? root : id === 'remaining' ? label : null) };
    runInNewContext(script, { document, Date: { now: () => now }, setTimeout: (run: () => void) => void (timer.next = run), Math, Number, String });

    expect(label.textContent).toBe(language === 'en' ? 'Expires in 02:05' : 'Expira en 02:05');
    now += 65_000;
    timer.next?.();
    expect(label.textContent).toBe(language === 'en' ? 'Expires in 01:00' : 'Expira en 01:00');
    expect(classes.has('expired')).toBe(false);
    now += 60_000;
    timer.next?.();
    expect(label.textContent).toBe(text.expired);
    expect(classes.has('expired')).toBe(true);
  });
});

describe('pairing page in the default language', () => {
  it('stays in pt-BR with its words as data for the script', () => {
    const html = renderPairingHtml({ code: '004217', expiresAt: 1_125_000, qrDataUrl: PNG, nonce: NONCE, now: 1_000_000 });
    expect(html).toContain('<html lang="pt-BR">');
    expect(pageData(html)['data-expires-in']).toBe('Expira em {{time}}');
    expect(pageData(html)['data-expired']).toBe('Código expirado. Gere outro pelo ícone do Nanachi.');
  });

  it('follows setLanguage when the page is not given a language', () => {
    setLanguage('es' satisfies Language);
    expect(renderPairingHtml({ code: '004217', expiresAt: 1_125_000, qrDataUrl: PNG, nonce: NONCE, now: 1_000_000 })).toContain('<html lang="es">');
  });
});
