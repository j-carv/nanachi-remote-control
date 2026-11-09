import type { SessionEvent } from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import type { BackgroundView } from './background.js';
import { ChatItemView } from './ChatItemView.js';
import type { ChatNode } from './nesting.js';
import { applyEvents, createChatState, type ChatItem } from './reducer.js';

const api = {} as ApiClient;
const VIEW: BackgroundView = { active: true, turnEnds: 0 };

type Body = DistributiveOmit<SessionEvent, 'seq' | 'sessionId' | 'ts'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function ev(seq: number, body: Body): SessionEvent {
  return { seq, sessionId: 's-1', ts: 1_700_000_000_000 + seq, ...body } as SessionEvent;
}

/** Items the reducer builds from these events (the stored text, not the rendered one). */
function itemsOf(events: SessionEvent[]): readonly ChatItem[] {
  return applyEvents(createChatState('idle'), events).items;
}

function render(item: ChatItem | undefined): string {
  if (item === undefined) throw new Error('item esperado');
  const node: ChatNode = { item, children: [] };
  return renderToStaticMarkup(createElement(ChatItemView, { node, api, view: VIEW }));
}

const LOOP_INSTRUCTION = [
  '[Nanachi Remote] Esta execução faz parte de um loop que se repete. No fim da sua resposta, em linha própria, escreva um destes marcadores:',
  '[[nanachi-loop-next: <duração>]] para o tempo até a próxima execução, por exemplo 90s, 10m ou 2h (mínimo 30s, máximo 24h).',
  '[[nanachi-loop-stop]] se a tarefa estiver concluída e o loop não precisa continuar.',
  'Sem marcador, a próxima execução acontece em 10 minutos.',
].join('\n');

describe('ChatItemView: texto do agente com marcadores de loop', () => {
  it('o reducer guarda o texto cru, com o marcador; a renderização é que esconde', () => {
    const items = itemsOf([
      ev(1, { kind: 'agent_message_chunk', text: 'Passo feito. [[nanachi-loop-' }),
      ev(2, { kind: 'agent_message_chunk', text: 'next: 45s]]' }),
    ]);

    expect(items[0]).toEqual({
      id: 'agent_message-1',
      kind: 'agent_message',
      lastSeq: 2,
      text: 'Passo feito. [[nanachi-loop-next: 45s]]',
    });
    const html = render(items[0]);
    expect(html).toContain('Passo feito.');
    expect(html).toContain('Próxima rodada em 45 s');
    expect(html).not.toContain('nanachi');
    expect(html).toContain('data-slot="loop-note"');
  });

  it('enquanto o marcador chega em pedaços, a tela não mostra nada dele', () => {
    const items = itemsOf([ev(1, { kind: 'agent_message_chunk', text: 'Feito. [[nanachi-loo' })]);

    const html = render(items[0]);
    expect(html).toContain('Feito.');
    expect(html).not.toContain('nanachi');
    expect(html).not.toContain('data-slot="loop-note"');
  });

  it('marcador de parada vira a nota de encerramento', () => {
    const items = itemsOf([ev(1, { kind: 'agent_message_chunk', text: 'Tudo pronto.\n[[nanachi-loop-stop]]' })]);

    const html = render(items[0]);
    expect(html).toContain('Loop encerrado pelo agente');
    expect(html).not.toContain('nanachi');
  });

  it('mensagem sem marcador não ganha nota', () => {
    const items = itemsOf([ev(1, { kind: 'agent_message_chunk', text: 'Oi, tudo bem?' })]);

    const html = render(items[0]);
    expect(html).toContain('Oi, tudo bem?');
    expect(html).not.toContain('data-slot="loop-note"');
  });
});

describe('ChatItemView: mensagem do usuário', () => {
  it('replay com a instrução do loop mostra só o prompt', () => {
    const items = itemsOf([ev(1, { kind: 'user_message', text: `revise os testes\n\n${LOOP_INSTRUCTION}` })]);

    const html = render(items[0]);
    expect(html).toContain('revise os testes');
    expect(html).not.toContain('faz parte de um loop');
    expect(html).not.toContain('nanachi-loop');
  });

  it('o rótulo da rodada continua aparecendo', () => {
    const items = itemsOf([ev(1, { kind: 'user_message', text: 'revise', loop: true, loopIteration: 2 })]);

    expect(render(items[0])).toContain('Loop #2');
  });
});

describe('ChatItemView: troca de conta', () => {
  it('mostra "Conta trocada para <nome>" como linha centralizada e discreta', () => {
    const items = itemsOf([ev(1, { kind: 'account_changed', accountId: 'a-1', label: 'Trabalho' })]);
    const html = render(items[0]);
    expect(html).toContain('data-slot="account-changed"');
    expect(html).toContain('Conta trocada para Trabalho');
    expect(html).toContain('text-center');
    expect(html).toContain('text-muted-foreground');
  });

  it('o nome da conta vai como texto, nunca como HTML', () => {
    const items = itemsOf([ev(1, { kind: 'account_changed', accountId: 'a-1', label: '<b>x</b>' })]);
    const html = render(items[0]);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
