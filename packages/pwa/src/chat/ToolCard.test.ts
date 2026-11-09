import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import type { BackgroundView } from './background.js';
import { historyOf } from './liveItems.js';
import type { ChatNode } from './nesting.js';
import { ToolCard } from './ToolCard.js';
import type { ToolItem } from './toolSummary.js';

const api = {} as ApiClient;
const ACTIVE: BackgroundView = { active: true, turnEnds: 0 };

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    id: 'tool-call-1',
    kind: 'tool_call',
    toolCallId: 'call-1',
    title: 'Ler parser.ts',
    toolKind: 'read',
    status: 'completed',
    content: [],
    locations: [],
    ...overrides,
  };
}

function leaf(item: ToolItem): ChatNode {
  return { item, children: [] };
}

/** Child rows are rendered by the caller; here a span with the title stands in for a ChatItemView. */
function render(item: ToolItem, nested: ChatNode[] = [], view: BackgroundView = ACTIVE): string {
  return renderToStaticMarkup(
    createElement(ToolCard, {
      api,
      item,
      nested,
      view,
      renderNested: (child: ChatNode) =>
        createElement('span', { 'data-child': 'true' }, child.item.kind === 'tool_call' ? child.item.title : ''),
    }),
  );
}

const SUBAGENT = tool({
  id: 'tool-sub',
  toolCallId: 'sub',
  title: 'Agent',
  status: 'in_progress',
  background: { kind: 'subagent', state: 'running', label: 'Revisar parser', agentType: 'Explore' },
  timing: { startedAt: 1, updatedAt: 1, startEnds: 0, seenEnds: 0 },
});

describe('ToolCard with background work', () => {
  it('shows the label, the agent type and the count of inner actions with the last title', () => {
    const html = render(SUBAGENT, [
      leaf(tool({ id: 'tool-c1', toolCallId: 'c1', title: 'Ler parser.ts' })),
      leaf(tool({ id: 'tool-c2', toolCallId: 'c2', title: 'Buscar tokens' })),
      leaf(tool({ id: 'tool-c3', toolCallId: 'c3', title: 'Ler testes' })),
    ]);

    expect(html).toContain('Revisar parser');
    expect(html).toContain('Explore');
    expect(html).toContain('3 ações internas · última: Ler testes');
  });

  it('uses the singular for one inner action', () => {
    const html = render(SUBAGENT, [leaf(tool({ id: 'tool-c1', toolCallId: 'c1', title: 'Ler' }))]);
    expect(html).toContain('1 ação interna · última: Ler');
  });

  it('renders the children inside the card, each with its item id for the reveal', () => {
    const html = render(SUBAGENT, [leaf(tool({ id: 'tool-c1', toolCallId: 'c1', title: 'Ler parser.ts' }))]);
    expect(html).toContain('data-item-id="tool-c1"');
    expect(html).toContain('>Ler parser.ts</span>');
  });

  it('a subagent card starts collapsed, even while it runs', () => {
    const html = render(SUBAGENT);
    expect(html).toMatch(/<details(?![^>]*\sopen)[^>]*>/);
  });

  it('a running item shows no unknown state while its turn is active', () => {
    const html = render(SUBAGENT, [], ACTIVE);
    expect(html).toContain('data-state="running"');
    expect(html).not.toContain('Estado desconhecido');
  });

  it('a running item shows "Estado desconhecido" once its turn has ended', () => {
    const html = render(SUBAGENT, [], { active: true, turnEnds: 1 });
    expect(html).toContain('data-state="unknown"');
    expect(html).toContain('Estado desconhecido');
  });

  it('lists the jobs of a job card with their own status', () => {
    const job = tool({
      id: 'tool-task',
      toolCallId: 'task',
      title: 'Compilar e testar',
      status: 'in_progress',
      background: {
        kind: 'job',
        state: 'running',
        jobs: [
          { id: 'j1', label: 'Compilar pacote', status: 'completed' },
          { id: 'j2', label: 'Testes unitários', status: 'running' },
        ],
      },
      timing: { startedAt: 1, updatedAt: 1, startEnds: 0, seenEnds: 0 },
    });
    const html = render(job, [], { active: false, turnEnds: 1 });
    expect(html).toContain('Compilar pacote');
    expect(html).toContain('Testes unitários');
    expect(html).toContain('Concluído');
    expect(html).toContain('Estado desconhecido');
  });
});

describe('ToolCard child rows and motion', () => {
  it('a child from the history is still, a child that arrived live enters with motion', () => {
    const fromHistory = leaf(tool({ id: 'tool-old', toolCallId: 'old', title: 'Ler antigo' }));
    const arrived = leaf(tool({ id: 'tool-new', toolCallId: 'new', title: 'Ler novo' }));
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        api,
        item: SUBAGENT,
        nested: [fromHistory, arrived],
        history: historyOf([fromHistory.item]),
        view: ACTIVE,
        renderNested: (child: ChatNode) =>
          createElement('span', { 'data-child': 'true' }, child.item.kind === 'tool_call' ? child.item.title : ''),
      }),
    );

    expect(html).toMatch(/<li data-item-id="tool-old"(?![^>]*animate-enter)[^>]*>/);
    expect(html).toMatch(/<li data-item-id="tool-new"[^>]*animate-enter[^>]*>/);
  });
});

describe('ToolCard without background work', () => {
  it('uses an accessible status icon instead of a repeated status badge', () => {
    const html = render(tool({ status: 'completed' }));
    expect(html).toContain('role="img" aria-label="Concluído"');
    expect(html).not.toContain('data-slot="badge"');
    expect(html).not.toContain('ações internas');
  });

  it('starts flat running rows collapsed so each action can be inspected separately', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, {
      api, item: tool({ status: 'in_progress' }), view: ACTIVE, flat: true, renderNested: () => null,
    }));
    expect(html).toMatch(/<details(?![^>]*\sopen)[^>]*>/);
    expect(html).toContain('data-state="running"');
    expect(html).not.toContain('border border-border bg-card');
  });

  it('keeps the full location and original title in expanded inspection', () => {
    const html = render(tool({ title: 'Read src/parser.ts', locations: ['src/parser.ts'] }));
    expect(html).toContain('>Read parser.ts</span>');
    expect(html).toContain('>Read src/parser.ts</p>');
    expect(html).toContain('>src/parser.ts</li>');
  });

  it('places nested failures after the parent disclosure rather than inside its closed body', () => {
    const failure = leaf(tool({ id: 'failed-child', status: 'failed' }));
    const html = render(SUBAGENT, [failure]);
    expect(html.indexOf('data-slot="tool-exceptions"')).toBeGreaterThan(html.indexOf('</details>'));
    expect(html.indexOf('data-item-id="failed-child"')).toBeGreaterThan(html.indexOf('</details>'));
  });
});
