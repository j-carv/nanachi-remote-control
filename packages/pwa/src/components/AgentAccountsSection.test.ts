import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentAccount, AgentProfile } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { AgentAccountGroup } from './AgentAccountsSection.js';

const NOW = 1_700_000_000_000;

const PRINCIPAL: AgentProfile = {
  id: 'default',
  label: 'Principal',
  isDefault: true,
  active: false,
  status: 'logged_in',
  account: 'eu@exemplo.com',
  detail: 'Pro',
  checkedAt: NOW,
};
const WORK: AgentProfile = {
  id: 'a-1',
  label: 'Trabalho',
  isDefault: false,
  active: true,
  status: 'logged_in',
  account: 'trabalho@exemplo.com',
  detail: null,
  checkedAt: NOW,
};
const NEW_ONE: AgentProfile = {
  id: 'a-2',
  label: 'Casa',
  isDefault: false,
  active: false,
  status: 'logged_out',
  account: null,
  detail: null,
  checkedAt: NOW,
};

const AGENT: AgentAccount = {
  agentId: 'claude',
  label: 'Claude Code',
  status: 'logged_in',
  account: 'eu@exemplo.com',
  detail: null,
  checkedAt: NOW,
  supportsAccounts: true,
  profiles: [PRINCIPAL, WORK, NEW_ONE],
};

const noop = () => undefined;
const render = (agent: AgentAccount = AGENT): string =>
  renderToStaticMarkup(createElement(AgentAccountGroup, { agent, now: NOW, onOpen: noop, onAdd: noop }));

/** The `<button>` of one account row, by its account id. */
function rowOf(html: string, accountId: string): string {
  const match = new RegExp(`<button[^>]*data-slot="account-row"[^>]*data-account="${accountId}"[\\s\\S]*?</button>`).exec(html);
  if (match === null) throw new Error(`no row for ${accountId}`);
  return match[0];
}

describe('AgentAccountGroup', () => {
  it('o nome do agente e quando foi verificado', () => {
    const html = render();
    expect(html).toContain('aria-label="Claude Code"');
    expect(html).toContain('<h3');
    expect(html).toContain('Verificado agora');
  });

  it('uma linha por conta, a principal primeiro, e a linha "Adicionar conta" no fim', () => {
    const html = render();
    const ids = [...html.matchAll(/data-slot="account-row"[^>]*data-account="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(['default', 'a-1', 'a-2']);
    const addAt = html.indexOf('data-slot="add-account"');
    expect(addAt).toBeGreaterThan(html.lastIndexOf('data-slot="account-row"'));
    expect(html).toContain('Adicionar conta');
  });

  it('só a conta em uso ganha o selo "Em uso"', () => {
    const html = render();
    expect(html.match(/Em uso/g)).toHaveLength(1);
    expect(rowOf(html, 'a-1')).toContain('Em uso');
    expect(rowOf(html, 'a-1')).toContain('data-active="true"');
    expect(rowOf(html, 'default')).not.toContain('Em uso');
    expect(rowOf(html, 'default')).toContain('data-active="false"');
  });

  it('cada linha mostra o nome, o e-mail ou o estado, e o ponto do estado', () => {
    const html = render();
    expect(rowOf(html, 'default')).toContain('Principal');
    expect(rowOf(html, 'default')).toContain('eu@exemplo.com · Pro');
    expect(rowOf(html, 'default')).toContain('bg-success');
    expect(rowOf(html, 'a-1')).toContain('trabalho@exemplo.com');
    expect(rowOf(html, 'a-2')).toContain('Casa');
    expect(rowOf(html, 'a-2')).toContain('Deslogado');
    expect(rowOf(html, 'a-2')).toContain('bg-attention');
  });

  it('a linha abre uma folha (aria-haspopup) e não usa emoji', () => {
    const html = render();
    expect(rowOf(html, 'a-1')).toContain('aria-haspopup="dialog"');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('o nome da conta vai como texto, nunca como HTML', () => {
    const html = render({ ...AGENT, profiles: [PRINCIPAL, { ...WORK, label: '<b>x</b>' }] });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
