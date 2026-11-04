import { describe, expect, it } from 'vitest';
import { AgentTokens } from '../src/agent-tokens.js';

describe('AgentTokens', () => {
  it('emite um token base64url de 32 bytes por sessão e aceita só o token dela', () => {
    const tokens = new AgentTokens();
    const token = tokens.issue('sessao-a');

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.verify('sessao-a', token)).toBe(true);
    expect(tokens.verify('sessao-b', token)).toBe(false);
  });

  it('recusa token errado, ausente ou de sessão sem token', () => {
    const tokens = new AgentTokens();
    tokens.issue('sessao-a');

    expect(tokens.verify('sessao-a', 'errado')).toBe(false);
    expect(tokens.verify('sessao-a', undefined)).toBe(false);
    expect(tokens.verify('nunca-existiu', 'qualquer')).toBe(false);
  });

  it('revogar invalida o token da sessão', () => {
    const tokens = new AgentTokens();
    const token = tokens.issue('sessao-a');
    tokens.revoke('sessao-a');

    expect(tokens.verify('sessao-a', token)).toBe(false);
  });

  it('emitir de novo troca o token: o antigo deixa de valer', () => {
    const tokens = new AgentTokens();
    const first = tokens.issue('sessao-a');
    const second = tokens.issue('sessao-a');

    expect(second).not.toBe(first);
    expect(tokens.verify('sessao-a', first)).toBe(false);
    expect(tokens.verify('sessao-a', second)).toBe(true);
  });
});
