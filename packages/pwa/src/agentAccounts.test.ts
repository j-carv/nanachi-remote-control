import type { AgentAccount, AgentProfile } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import {
  accountChangeLocked,
  accountLockedHint,
  accountOptionLabel,
  accountSelectorFor,
  accountView,
  checkedText,
  createLoginReloads,
  loginHelp,
  newSessionAccount,
  profileActions,
  profileView,
  removeAccountText,
  sessionAccount,
  sessionAccountInfo,
  validateAccountLabel,
} from './agentAccounts.js';

describe('accountView', () => {
  it('logado: "Logado", verde, sem ajuda', () => {
    expect(accountView({ status: 'logged_in' })).toEqual({ statusLabel: 'Logado', tone: 'ok', help: null });
  });

  it('deslogado: "Deslogado", amarelo, com a ajuda de login no terminal', () => {
    expect(accountView({ status: 'logged_out' })).toEqual({
      statusLabel: 'Deslogado',
      tone: 'warn',
      help: 'Faça login no terminal do PC (ex.: claude, codex login, agy acp --login).',
    });
    expect(loginHelp()).toBe('Faça login no terminal do PC (ex.: claude, codex login, agy acp --login).');
  });

  it('não verificado: cinza, sem ajuda (o detalhe da conta explica o motivo)', () => {
    expect(accountView({ status: 'unknown' })).toEqual({ statusLabel: 'Não verificado', tone: 'muted', help: null });
  });
});

describe('checkedText', () => {
  const now = 1_700_000_000_000;

  it('usa o tempo relativo do app', () => {
    expect(checkedText(now - 2 * 60_000, now)).toBe('Verificado há 2 min');
    expect(checkedText(now, now)).toBe('Verificado agora');
  });
});

const PRINCIPAL: AgentProfile = {
  id: 'default',
  label: 'Principal',
  isDefault: true,
  active: true,
  status: 'logged_in',
  account: 'eu@exemplo.com',
  detail: 'Pro',
  checkedAt: 1_700_000_000_000,
};

const WORK: AgentProfile = {
  id: 'a-1',
  label: 'Trabalho',
  isDefault: false,
  active: false,
  status: 'logged_in',
  account: 'trabalho@exemplo.com',
  detail: null,
  checkedAt: 1_700_000_000_000,
};

const NEW_ONE: AgentProfile = { ...WORK, id: 'a-2', label: 'Casa', status: 'logged_out', account: null };

function entry(agentId: string, profiles: AgentProfile[], supportsAccounts = true): AgentAccount {
  return {
    agentId,
    label: agentId,
    status: 'logged_in',
    account: 'eu@exemplo.com',
    detail: null,
    checkedAt: 1_700_000_000_000,
    supportsAccounts,
    profiles,
  };
}

describe('profileView', () => {
  it('logado: e-mail e detalhe numa linha, ponto verde', () => {
    expect(profileView(PRINCIPAL)).toEqual({
      statusLabel: 'Logado',
      tone: 'ok',
      subtitle: 'eu@exemplo.com · Pro',
    });
  });

  it('logado sem e-mail nem detalhe: cai no rótulo do estado', () => {
    expect(profileView({ ...WORK, account: null, detail: null }).subtitle).toBe('Logado');
  });

  it('deslogado: "Deslogado" e ponto amarelo', () => {
    expect(profileView(NEW_ONE)).toEqual({ statusLabel: 'Deslogado', tone: 'warn', subtitle: 'Deslogado' });
  });

  it('não verificado: usa o detalhe que explica o motivo', () => {
    expect(profileView({ ...WORK, status: 'unknown', account: null, detail: 'Sem verificação' })).toEqual({
      statusLabel: 'Não verificado',
      tone: 'muted',
      subtitle: 'Sem verificação',
    });
    expect(profileView({ ...WORK, status: 'unknown', account: null, detail: null }).subtitle).toBe('Não verificado');
  });
});

describe('profileActions', () => {
  it('conta extra que não está em uso: usar, entrar, renomear e remover', () => {
    expect(profileActions(WORK)).toEqual(['use', 'login', 'rename', 'remove']);
  });

  it('conta em uso não oferece "usar" de novo', () => {
    expect(profileActions({ ...WORK, active: true })).toEqual(['login', 'rename', 'remove']);
  });

  it('a principal nunca é renomeada nem removida (o daemon recusa)', () => {
    expect(profileActions(PRINCIPAL)).toEqual(['login']);
    expect(profileActions({ ...PRINCIPAL, active: false })).toEqual(['use', 'login']);
  });
});

describe('accountSelectorFor', () => {
  it('só aparece com suporte a contas e mais de um perfil', () => {
    const accounts = [entry('claude', [PRINCIPAL, WORK]), entry('omp', [], false)];
    expect(accountSelectorFor(accounts, 'claude')).toEqual({ profiles: [PRINCIPAL, WORK], activeId: 'default' });
    expect(accountSelectorFor(accounts, 'omp')).toBeNull();
    expect(accountSelectorFor(accounts, 'nao-existe')).toBeNull();
  });

  it('só com a principal não há o que escolher', () => {
    expect(accountSelectorFor([entry('claude', [PRINCIPAL])], 'claude')).toBeNull();
  });

  it('daemon sem o recurso (supportsAccounts false) não mostra seletor, mesmo com perfis', () => {
    expect(accountSelectorFor([entry('claude', [PRINCIPAL, WORK], false)], 'claude')).toBeNull();
  });

  it('lista ainda não carregada: sem seletor', () => {
    expect(accountSelectorFor(null, 'claude')).toBeNull();
  });

  it('a conta ativa é a que sessões novas usam', () => {
    const selector = accountSelectorFor([entry('claude', [{ ...PRINCIPAL, active: false }, { ...WORK, active: true }])], 'claude');
    expect(selector?.activeId).toBe('a-1');
  });

  it('sem nenhuma marcada como ativa, vale a principal', () => {
    const selector = accountSelectorFor([entry('claude', [{ ...PRINCIPAL, active: false }, WORK])], 'claude');
    expect(selector?.activeId).toBe('default');
  });
});

describe('contas escolhidas', () => {
  const selector = { profiles: [PRINCIPAL, WORK], activeId: 'a-1' };

  it('nova sessão: sem escolha vale a conta ativa; escolha que não existe mais também', () => {
    expect(newSessionAccount(selector, null)).toBe('a-1');
    expect(newSessionAccount(selector, 'default')).toBe('default');
    expect(newSessionAccount(selector, 'sumiu')).toBe('a-1');
  });

  it('sessão: accountId null é a principal; conta removida cai na principal', () => {
    expect(sessionAccount(selector, null)).toBe('default');
    expect(sessionAccount(selector, 'a-1')).toBe('a-1');
    expect(sessionAccount(selector, 'sumiu')).toBe('default');
  });

  it('o seletor da sessão trava enquanto o agente começa, trabalha ou espera permissão', () => {
    expect(accountChangeLocked('starting')).toBe(true);
    expect(accountChangeLocked('running')).toBe(true);
    expect(accountChangeLocked('awaiting_permission')).toBe(true);
    expect(accountChangeLocked('idle')).toBe(false);
    expect(accountChangeLocked('stopped')).toBe(false);
    expect(accountChangeLocked('error')).toBe(false);
    expect(accountLockedHint()).toBe('Troque quando o agente terminar');
  });
});

describe('sessionAccountInfo', () => {
  const accounts = [entry('claude', [PRINCIPAL, WORK]), entry('omp', [], false)];

  it('rótulo e e-mail da conta da sessão', () => {
    expect(sessionAccountInfo(accounts, 'claude', 'a-1')).toEqual({ label: 'Trabalho', email: 'trabalho@exemplo.com' });
  });

  it('accountId null é a principal', () => {
    expect(sessionAccountInfo(accounts, 'claude', null)).toEqual({ label: 'Principal', email: 'eu@exemplo.com' });
  });

  it('conta sem e-mail conhecido devolve email null', () => {
    expect(sessionAccountInfo([entry('claude', [PRINCIPAL, NEW_ONE])], 'claude', 'a-2')).toEqual({ label: 'Casa', email: null });
  });

  it('agente sem contas, lista não carregada ou conta desconhecida: nada a mostrar', () => {
    expect(sessionAccountInfo(accounts, 'omp', null)).toBeNull();
    expect(sessionAccountInfo(null, 'claude', null)).toBeNull();
    expect(sessionAccountInfo(accounts, 'claude', 'sumiu')).toBeNull();
  });
});

describe('validateAccountLabel', () => {
  it('aceita de 1 a 40 caracteres depois de recortar', () => {
    expect(validateAccountLabel('Trabalho')).toBeNull();
    expect(validateAccountLabel('  x  ')).toBeNull();
    expect(validateAccountLabel('x'.repeat(40))).toBeNull();
  });

  it('recusa vazio e longo demais, com o motivo', () => {
    expect(validateAccountLabel('')).toBe('Digite um nome.');
    expect(validateAccountLabel('   ')).toBe('Digite um nome.');
    expect(validateAccountLabel('x'.repeat(41))).toBe('Nome longo demais (máx. 40 caracteres).');
  });
});

describe('removeAccountText', () => {
  it('diz o que acontece com a conta e com as sessões dela', () => {
    expect(removeAccountText('Claude Code', 'Trabalho')).toBe(
      'Remover "Trabalho" de Claude Code? O login desta conta neste PC é apagado e as sessões que a usavam voltam para a conta principal. A conta em si não é afetada.',
    );
  });
});

describe('accountOptionLabel', () => {
  it('o nome da conta, sozinho quando é único', () => {
    expect(accountOptionLabel(WORK, [PRINCIPAL, WORK])).toBe('Trabalho');
  });

  it('nomes repetidos ganham o e-mail para a pessoa distinguir', () => {
    const twin: AgentProfile = { ...WORK, id: 'a-9', account: 'outro@exemplo.com' };
    expect(accountOptionLabel(WORK, [PRINCIPAL, WORK, twin])).toBe('Trabalho · trabalho@exemplo.com');
    expect(accountOptionLabel(twin, [PRINCIPAL, WORK, twin])).toBe('Trabalho · outro@exemplo.com');
  });

  it('nome repetido sem e-mail conhecido fica só com o nome', () => {
    const twin: AgentProfile = { ...WORK, id: 'a-9', account: null };
    expect(accountOptionLabel(twin, [PRINCIPAL, WORK, twin])).toBe('Trabalho');
  });
});

describe('createLoginReloads', () => {
  function setup() {
    let count = 0;
    const reloads = createLoginReloads(() => {
      count += 1;
    });
    return { reloads, count: () => count };
  }

  it('um login que deu certo lê a lista uma vez só, na hora, e fechar a folha depois não lê de novo', () => {
    const { reloads, count } = setup();
    reloads.started();
    reloads.succeeded();
    expect(count()).toBe(1);
    reloads.closed();
    expect(count()).toBe(1);
  });

  it('fechar sem sucesso (cancelado ou falhou) lê a lista uma vez', () => {
    const { reloads, count } = setup();
    reloads.started();
    reloads.closed();
    expect(count()).toBe(1);
  });

  it('o próximo login começa do zero: fechar sem sucesso lê de novo', () => {
    const { reloads, count } = setup();
    reloads.started();
    reloads.succeeded();
    reloads.closed();
    reloads.started();
    reloads.closed();
    expect(count()).toBe(2);
  });
});

describe('account texts in English', () => {
  it('accountView names the states and tells how to sign in', () => {
    setLanguage('en');
    expect(accountView({ status: 'logged_in' })).toEqual({ statusLabel: 'Signed in', tone: 'ok', help: null });
    expect(accountView({ status: 'logged_out' })).toEqual({
      statusLabel: 'Signed out',
      tone: 'warn',
      help: "Sign in from the PC's terminal (e.g. claude, codex login, agy acp --login).",
    });
    expect(accountView({ status: 'unknown' })).toEqual({ statusLabel: 'Not checked', tone: 'muted', help: null });
  });

  it('checkedText uses the relative time of the language', () => {
    setLanguage('en');
    const now = 1_700_000_000_000;
    expect(checkedText(now, now)).toBe('Checked now');
    expect(checkedText(now - 2 * 60_000, now)).toBe('Checked 2 min ago');
  });

  it('removeAccountText, the label rules and the locked hint', () => {
    setLanguage('en');
    expect(removeAccountText('Claude Code', 'Work')).toBe(
      'Remove "Work" from Claude Code? The login for this account on this PC is deleted, and the sessions that used it go back to the main account. The account itself is not affected.',
    );
    expect(validateAccountLabel('  ')).toBe('Enter a name.');
    expect(validateAccountLabel('x'.repeat(41))).toBe('Name too long (max 40 characters).');
    expect(validateAccountLabel('Work')).toBeNull();
    expect(accountLockedHint()).toBe('Switch when the agent is done');
  });
});
