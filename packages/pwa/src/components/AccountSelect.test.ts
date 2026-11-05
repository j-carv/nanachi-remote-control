import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentProfile } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { AccountSelect } from './AccountSelect.js';

const PRINCIPAL: AgentProfile = {
  id: 'default',
  label: 'Principal',
  isDefault: true,
  active: true,
  status: 'logged_in',
  account: 'eu@exemplo.com',
  detail: null,
  checkedAt: 1_700_000_000_000,
};
const WORK: AgentProfile = { ...PRINCIPAL, id: 'a-1', label: 'Trabalho', isDefault: false, active: false, account: 'trabalho@exemplo.com' };

const noop = () => undefined;

const render = (props: { value: string; disabled?: boolean; showHint?: boolean; busy?: boolean }): string =>
  renderToStaticMarkup(createElement(AccountSelect, { profiles: [PRINCIPAL, WORK], onChange: noop, ...props }));

describe('AccountSelect', () => {
  it('mostra o nome e o e-mail da conta escolhida e uma opção por conta', () => {
    const html = render({ value: 'a-1' });
    expect(html).toContain('data-slot="account-select"');
    expect(html).toContain('aria-label="Conta"');
    expect(html).toContain('Trabalho');
    expect(html).toContain('trabalho@exemplo.com');
    expect(html).toMatch(/<option value="default">Principal<\/option>/);
    expect(html).toMatch(/<option value="a-1" selected="">Trabalho<\/option>/);
  });

  it('valor que não está na lista: mostra "Conta removida", sem inventar uma conta, e a opção segue o valor', () => {
    const html = render({ value: 'sumiu' });
    expect(html).toContain('Conta removida');
    expect(html).not.toContain('eu@exemplo.com');
    expect(html).not.toContain('trabalho@exemplo.com');
    expect(html).toMatch(/<option value="sumiu"[^>]*selected=""[^>]*>Conta removida<\/option>/);
    // The accounts that exist are still there to pick.
    expect(html).toMatch(/<option value="default">Principal<\/option>/);
    expect(html).toMatch(/<option value="a-1">Trabalho<\/option>/);
  });

  it('valor que está na lista não ganha a opção "Conta removida"', () => {
    expect(render({ value: 'a-1' })).not.toContain('Conta removida');
    expect(render({ value: 'default' })).not.toContain('Conta removida');
  });

  it('com a troca em andamento o ícone vira um spinner pequeno; sem ela, as setas', () => {
    const busy = render({ value: 'a-1', disabled: true, busy: true });
    expect(busy).toContain('data-slot="account-busy"');
    expect(busy).toContain('animate-spin');
    expect(busy).not.toContain('lucide-chevrons-up-down');
    const idle = render({ value: 'a-1' });
    expect(idle).not.toContain('data-slot="account-busy"');
    expect(idle).toContain('lucide-chevrons-up-down');
  });

  it('habilitado: sem trava e sem dica', () => {
    const html = render({ value: 'default', showHint: true });
    expect(html).not.toMatch(/<select[^>]* disabled=""/);
    expect(html).not.toContain('Troque quando o agente terminar');
  });

  it('travado com a dica: select desabilitado e o texto "Troque quando o agente terminar", ligado ao select', () => {
    const html = render({ value: 'default', disabled: true, showHint: true });
    expect(html).toMatch(/<select[^>]* disabled=""/);
    expect(html).toContain('data-slot="account-hint"');
    expect(html).toContain('Troque quando o agente terminar');
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy}"`);
  });

  it('travado sem pedir a dica (troca em andamento): desabilitado, sem texto', () => {
    const html = render({ value: 'default', disabled: true });
    expect(html).toMatch(/<select[^>]* disabled=""/);
    expect(html).not.toContain('Troque quando o agente terminar');
  });
});

describe('AccountSelect in English', () => {
  it('names the row, the removed account and the hint', () => {
    setLanguage('en');
    const html = render({ value: 'sumiu', disabled: true, showHint: true });
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('Removed account');
    expect(html).toContain('Switch when the agent is done');
  });
});
