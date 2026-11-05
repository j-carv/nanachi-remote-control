import type { SessionStatus } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { sessionStatusText, sessionTitle } from './sessionText.js';

describe('sessionStatusText', () => {
  it('sessão ACP em execução diz "Trabalhando"', () => {
    expect(sessionStatusText('running', 'acp')).toBe('Trabalhando');
  });

  it('sessão de terminal (PTY) em execução diz "Em execução"', () => {
    expect(sessionStatusText('running', 'pty')).toBe('Em execução');
  });

  it.each<[SessionStatus, string]>([
    ['starting', 'Iniciando'],
    ['idle', 'Pronta'],
    ['awaiting_permission', 'Aguarda permissão'],
    ['error', 'Erro'],
  ])('%s tem o mesmo texto nos dois tipos', (status, text) => {
    expect(sessionStatusText(status, 'acp')).toBe(text);
    expect(sessionStatusText(status, 'pty')).toBe(text);
  });
});

describe('sessionStatusText, sessão encerrada', () => {
  it('terminal encerrado diz "Encerrado"; sessão ACP segue "Encerrada"', () => {
    expect(sessionStatusText('stopped', 'pty')).toBe('Encerrado');
    expect(sessionStatusText('stopped', 'acp')).toBe('Encerrada');
  });
});

describe('sessionTitle', () => {
  it('sessão de terminal sem título mostra "<agente> · terminal"', () => {
    expect(sessionTitle({ title: 'Nova sessão', kind: 'pty' }, 'Antigravity')).toBe(
      'Antigravity · terminal',
    );
  });

  it('sessão de terminal com título próprio mantém o título', () => {
    expect(sessionTitle({ title: 'Corrigir build', kind: 'pty' }, 'Antigravity')).toBe(
      'Corrigir build',
    );
  });

  it('sessão ACP sem título mantém "Nova sessão" (só terminal ganha o rótulo)', () => {
    expect(sessionTitle({ title: 'Nova sessão', kind: 'acp' }, 'Oh My Pi')).toBe('Nova sessão');
  });
});
