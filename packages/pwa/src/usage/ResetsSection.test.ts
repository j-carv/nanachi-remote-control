import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResetEntry } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import type { RedeemState, ResetsListState } from './resetsFlow.js';
import { RedeemResultNotice, ResetConfirmActions, ResetsSection } from './ResetsSection.js';

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const noop = () => undefined;

function entry(overrides: Partial<ResetEntry> = {}): ResetEntry {
  return {
    target: 'anthropic/1',
    accountLabel: 'fake@example.com · Org',
    providerLabel: 'Anthropic',
    available: 2,
    usable: 1,
    expiresAt: 'in 3 days',
    note: null,
    active: true,
    ...overrides,
  };
}

const IDLE: RedeemState = { status: 'idle' };

function render(list: ResetsListState, redeem: RedeemState = IDLE): string {
  return renderToStaticMarkup(createElement(ResetsSection, { list, redeem, now: NOW, onRedeem: noop }));
}

function ready(entries: ResetEntry[], message: string | null = null): ResetsListState {
  return { status: 'ready', entries, message };
}

/** True when the button tag has the `disabled` attribute (the class list also holds `disabled:` utilities). */
function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=|\s|>)/.test(tag);
}

/** The `<button ...>` tag of the row button whose label names `account`. */
function rowButton(html: string, account: string): string {
  const match = new RegExp(`<button[^>]*aria-label="Usar reset de ${account}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no row button for ${account}`);
  return match[0];
}

describe('ResetsSection: rows', () => {
  it('has the "Resets salvos" heading', () => {
    const html = render(ready([entry()]));
    expect(html).toContain('Resets salvos');
    expect(html).toContain('aria-labelledby="usage-resets"');
  });

  it('shows account, provider chip, counts, expiry and the note of a row', () => {
    const html = render(ready([entry({ note: 'not constrained' })]));
    expect(html).toContain('fake@example.com · Org');
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain('Anthropic');
    expect(html).toContain('2 salvos · 1 disponível agora');
    expect(html).toContain('expira in 3 days');
    expect(html).toContain('not constrained');
  });

  it('leaves out the chip, the expiry and the note when the row has none', () => {
    const html = render(ready([entry({ providerLabel: null, expiresAt: null, note: null })]));
    expect(html).not.toContain('data-slot="badge"');
    expect(html).not.toContain('expira');
    expect(html).not.toContain('text-muted-foreground break-words');
  });

  it('renders one row per entry, in order', () => {
    const html = render(
      ready([entry({ target: 'a/1', accountLabel: 'first@example.com' }), entry({ target: 'b/2', accountLabel: 'second@example.com' })]),
    );
    expect(html.match(/data-slot="reset-row"/g)).toHaveLength(2);
    expect(html.indexOf('first@example.com')).toBeLessThan(html.indexOf('second@example.com'));
  });

  it('turns an ISO expiry into relative text', () => {
    const iso = new Date(NOW + 3 * 86_400_000 + 3_600_000).toISOString();
    expect(render(ready([entry({ expiresAt: iso })]))).toContain('expira em 3 dias');
  });
});

describe('ResetsSection: the button', () => {
  it('is enabled only when a reset is usable now', () => {
    const html = render(
      ready([
        entry({ target: 'a/1', accountLabel: 'usable@example.com', usable: 1 }),
        entry({ target: 'b/2', accountLabel: 'none@example.com', usable: 0 }),
      ]),
    );
    expect(isDisabled(rowButton(html, 'usable@example.com'))).toBe(false);
    expect(isDisabled(rowButton(html, 'none@example.com'))).toBe(true);
  });

  it('says "Usar reset" and carries no confirmation sheet until a row is tapped', () => {
    const html = render(ready([entry()]));
    expect(html).toContain('Usar reset');
    expect(html).not.toContain('Usar 1 reset?');
    expect(html).not.toContain('Cancelar');
  });

  it('while a redeem runs every button is disabled and only the running row has the spinner', () => {
    const html = render(
      ready([
        entry({ target: 'a/1', accountLabel: 'one@example.com', usable: 1 }),
        entry({ target: 'b/2', accountLabel: 'two@example.com', usable: 2 }),
      ]),
      { status: 'running', target: 'a/1' },
    );
    expect(isDisabled(rowButton(html, 'one@example.com'))).toBe(true);
    expect(rowButton(html, 'one@example.com')).toContain('aria-busy="true"');
    expect(isDisabled(rowButton(html, 'two@example.com'))).toBe(true);
    expect(rowButton(html, 'two@example.com')).not.toContain('aria-busy');
    expect(html.match(/animate-spin/g)).toHaveLength(1);
  });

  it('without a redeem running there is no spinner', () => {
    expect(render(ready([entry()]))).not.toContain('animate-spin');
  });
});

describe('ResetsSection: list states', () => {
  it('shows a skeleton while loading', () => {
    const html = render({ status: 'loading' });
    expect(html).toContain('aria-label="Carregando resets"');
    expect(html).not.toContain('data-slot="reset-row"');
  });

  it('shows nothing under the heading while idle', () => {
    const html = render({ status: 'idle' });
    expect(html).toContain('Resets salvos');
    expect(html).not.toContain('data-slot="reset-row"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('shows the agent message in muted text when there are no entries', () => {
    const html = render(ready([], 'No provider accounts found. Use /login to add one.'));
    expect(html).toContain('data-slot="reset-message"');
    expect(html).toContain('No provider accounts found. Use /login to add one.');
    expect(html).toContain('text-muted-foreground');
  });

  it('has a fixed text when there are no entries and no message', () => {
    expect(render(ready([], null))).toContain('Nenhum reset salvo.');
  });

  it('shows a list error as an ErrorNotice with the reset text', () => {
    const html = render({ status: 'error', error: new ApiError('invalid_input', 400, null, 'resets_unsupported') });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Este agente não tem resets salvos');
  });

  it('a list timeout reads like the usage timeout', () => {
    const html = render({ status: 'error', error: new ApiError('agent_timeout', 504, null, 'agent_timeout') });
    expect(html).toContain('O agente demorou para responder. Tente de novo.');
  });
});

describe('ResetsSection: the reply of a redeem', () => {
  it('shows the agent line with success styling for a spent reset, above the rows', () => {
    const html = render(ready([entry()]), {
      status: 'done',
      result: { tone: 'success', message: 'Reset applied for fake@example.com (Anthropic).' },
    });
    expect(html).toContain('data-slot="reset-result"');
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('lucide-circle-check');
    expect(html).toContain('bg-muted');
    expect(html).not.toContain('bg-success');
    expect(html).toContain('Reset applied for fake@example.com (Anthropic).');
    expect(html.indexOf('data-slot="reset-result"')).toBeLessThan(html.indexOf('data-slot="reset-row"'));
  });

  it('shows the reply of a reset that spent nothing in neutral styling', () => {
    const html = render(ready([entry()]), {
      status: 'done',
      result: { tone: 'neutral', message: 'that reset was already redeemed.' },
    });
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain('bg-muted');
    expect(html).toContain('lucide-info');
    expect(html).not.toContain('role="alert"');
  });

  it('keeps the reply while the list is reloading', () => {
    const html = render(
      { status: 'loading' },
      { status: 'done', result: { tone: 'success', message: 'Reset applied.' } },
    );
    expect(html).toContain('Reset applied.');
    expect(html).toContain('aria-label="Carregando resets"');
  });

  it('shows a failed request as an error block', () => {
    const html = render(ready([entry()]), {
      status: 'done',
      result: {
        tone: 'error',
        message: 'Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.',
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.');
    expect(html).not.toContain('data-slot="reset-result"');
  });

  it('a notice with onDismiss has a labelled close button, and one without has none', () => {
    const result = { tone: 'success', message: 'ok' } as const;
    const withClose = renderToStaticMarkup(createElement(RedeemResultNotice, { result, onDismiss: noop }));
    expect(withClose).toContain('data-slot="reset-result-dismiss"');
    expect(withClose).toContain('aria-label="Dispensar aviso"');
    expect(renderToStaticMarkup(createElement(RedeemResultNotice, { result }))).not.toContain('reset-result-dismiss');
  });

  it('a failed request also gets the close button', () => {
    const result = { tone: 'error', message: 'Não deu para confirmar.' } as const;
    const html = renderToStaticMarkup(createElement(RedeemResultNotice, { result, onDismiss: noop }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-slot="reset-result-dismiss"');
  });

  it('the section shows the close button on the reply only when it is given onDismissRedeem', () => {
    const done: RedeemState = { status: 'done', result: { tone: 'success', message: 'Reset applied.' } };
    const withClose = renderToStaticMarkup(
      createElement(ResetsSection, { list: ready([entry()]), redeem: done, now: NOW, onRedeem: noop, onDismissRedeem: noop }),
    );
    expect(withClose).toContain('reset-result-dismiss');
    expect(render(ready([entry()]), done)).not.toContain('reset-result-dismiss');
  });

  it('a success notice uses the check icon, a neutral one the info icon', () => {
    const success = renderToStaticMarkup(createElement(RedeemResultNotice, { result: { tone: 'success', message: 'ok' } }));
    const neutral = renderToStaticMarkup(createElement(RedeemResultNotice, { result: { tone: 'neutral', message: 'ok' } }));
    expect(success).toContain('lucide-circle-check');
    expect(neutral).toContain('lucide-info');
  });
});

describe('ResetConfirmActions', () => {
  it('has "Cancelar" first and "Usar reset" second', () => {
    const html = renderToStaticMarkup(createElement(ResetConfirmActions, { onCancel: noop, onConfirm: noop }));
    expect(html).toContain('data-slot="reset-cancel"');
    expect(html).toContain('data-slot="reset-confirm"');
    expect(html.indexOf('Cancelar')).toBeLessThan(html.indexOf('Usar reset'));
  });
});
