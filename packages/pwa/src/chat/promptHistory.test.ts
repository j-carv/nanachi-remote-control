import { describe, expect, it } from 'vitest';
import type { ChatItem } from './reducer.js';
import { IDLE_PROMPT_CURSOR, promptHistoryOf, recallNewer, recallOlder, type PromptCursor } from './promptHistory.js';

function user(id: string, text: string): ChatItem {
  return { id, kind: 'user_message', text };
}

function agent(id: string, text: string): ChatItem {
  return { id, kind: 'agent_message', text };
}

describe('promptHistoryOf', () => {
  it('pega só as mensagens do usuário, da mais antiga para a mais nova', () => {
    const items = [user('u1', 'primeira'), agent('a1', 'resposta'), user('u2', 'segunda')];
    expect(promptHistoryOf(items)).toEqual(['primeira', 'segunda']);
  });

  it('repetida logo após a anterior no histórico conta uma vez só', () => {
    const items = [user('u1', 'oi'), user('u2', 'oi'), agent('a1', 'ok'), user('u3', 'oi'), user('u4', 'tchau')];
    expect(promptHistoryOf(items)).toEqual(['oi', 'tchau']);
  });

  it('mensagem só com anexo (texto vazio) não entra', () => {
    const items = [user('u1', 'antes'), user('u2', '   '), user('u3', 'depois')];
    expect(promptHistoryOf(items)).toEqual(['antes', 'depois']);
  });

  it('sem mensagens do usuário, histórico vazio', () => {
    expect(promptHistoryOf([agent('a1', 'oi')])).toEqual([]);
  });
});

describe('recallOlder (seta para cima)', () => {
  const history = ['um', 'dois', 'três'];

  it('sem histórico não faz nada', () => {
    expect(recallOlder([], IDLE_PROMPT_CURSOR, 'rascunho')).toBeNull();
  });

  it('primeira vez mostra a mais nova e guarda o rascunho atual', () => {
    expect(recallOlder(history, IDLE_PROMPT_CURSOR, 'rascunho')).toEqual({
      cursor: { index: 2, draft: 'rascunho' },
      text: 'três',
    });
  });

  it('sobe uma entrada por vez e mantém o rascunho guardado', () => {
    const first = recallOlder(history, IDLE_PROMPT_CURSOR, 'rascunho');
    const second = recallOlder(history, first?.cursor ?? IDLE_PROMPT_CURSOR, 'três');
    expect(second).toEqual({ cursor: { index: 1, draft: 'rascunho' }, text: 'dois' });
  });

  it('na mais antiga não sai do lugar', () => {
    const oldest: PromptCursor = { index: 0, draft: 'rascunho' };
    expect(recallOlder(history, oldest, 'um')).toBeNull();
  });
});

describe('recallNewer (seta para baixo)', () => {
  const history = ['um', 'dois', 'três'];

  it('fora do histórico não faz nada', () => {
    expect(recallNewer(history, IDLE_PROMPT_CURSOR)).toBeNull();
  });

  it('desce uma entrada por vez', () => {
    expect(recallNewer(history, { index: 0, draft: 'rascunho' })).toEqual({
      cursor: { index: 1, draft: 'rascunho' },
      text: 'dois',
    });
  });

  it('passando da mais nova restaura o rascunho de antes e sai do histórico', () => {
    expect(recallNewer(history, { index: 2, draft: 'rascunho' })).toEqual({
      cursor: IDLE_PROMPT_CURSOR,
      text: 'rascunho',
    });
  });

  it('subir e descer volta ao mesmo ponto', () => {
    const up = recallOlder(history, IDLE_PROMPT_CURSOR, 'rascunho');
    expect(up).not.toBeNull();
    const down = recallNewer(history, up?.cursor ?? IDLE_PROMPT_CURSOR);
    expect(down).toEqual({ cursor: IDLE_PROMPT_CURSOR, text: 'rascunho' });
  });
});
