import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import type { ChatItem } from './reducer.js';
import { summarizeTool } from './toolSummary.js';

type ToolItem = Extract<ChatItem, { kind: 'tool_call' }>;

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    id: 'tool-1',
    kind: 'tool_call',
    toolCallId: 'call-1',
    title: 'Editar a.ts',
    toolKind: 'edit',
    status: 'completed',
    content: [],
    locations: [],
    ...overrides,
  };
}

describe('summarizeTool', () => {
  it('conta as linhas acrescentadas e removidas do diff', () => {
    const summary = summarizeTool(
      tool({
        content: [{ type: 'diff', path: 'a.ts', oldText: 'a\nb', newText: 'a\nc\nd' }],
      }),
    );

    expect(summary.added).toBe(2);
    expect(summary.removed).toBe(1);
  });

  it('arquivo novo conta tudo como acrescentado', () => {
    const summary = summarizeTool(
      tool({ content: [{ type: 'diff', path: 'novo.ts', oldText: null, newText: 'x\ny' }] }),
    );

    expect(summary.added).toBe(2);
    expect(summary.removed).toBe(0);
  });

  it('saída de texto não conta como diff', () => {
    const summary = summarizeTool(tool({ content: [{ type: 'text', text: 'ok\nfeito' }] }));

    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
  });

  it('mostra o arquivo quando o título não o contém', () => {
    const summary = summarizeTool(tool({ title: 'Ler arquivo', locations: ['src/x.ts'] }));

    expect(summary.file).toBe('x.ts');
  });

  it('não repete o arquivo quando o título já o traz', () => {
    const summary = summarizeTool(tool({ title: 'Editar src/x.ts', locations: ['src/x.ts'] }));

    expect(summary.file).toBeNull();
  });

  it('sem título usa o arquivo como título', () => {
    const summary = summarizeTool(tool({ title: '', locations: ['src/x.ts'] }));

    expect(summary.title).toBe('x.ts');
  });

  it('rótulo de status: sem status vira Ferramenta', () => {
    expect(summarizeTool(tool({ status: null })).statusText).toBe('Ferramenta');
    expect(summarizeTool(tool({ status: 'in_progress' })).statusText).toBe('Em andamento');
    expect(summarizeTool(tool({ status: 'failed' })).statusText).toBe('Falhou');
  });

  it('shortens Windows locations in titles without changing the received data', () => {
    const item = tool({ title: 'Read C:\\project\\src\\parser.ts', locations: ['C:\\project\\src\\parser.ts'] });
    expect(summarizeTool(item).title).toBe('Read parser.ts');
    expect(summarizeTool(item).file).toBeNull();
    expect(item.locations).toEqual(['C:\\project\\src\\parser.ts']);
  });
});

describe('summarizeTool in English', () => {
  it('writes the status and the fallback title in English', () => {
    setLanguage('en');
    expect(summarizeTool(tool({ status: 'completed' })).statusText).toBe('Completed');
    expect(summarizeTool(tool({ status: 'in_progress' })).statusText).toBe('In progress');
    expect(summarizeTool(tool({ status: 'failed' })).statusText).toBe('Failed');
    expect(summarizeTool(tool({ status: null })).statusText).toBe('Tool');
    expect(summarizeTool(tool({ title: '', locations: [] })).title).toBe('Tool');
  });

  it('keeps the title the agent sent', () => {
    setLanguage('en');
    expect(summarizeTool(tool({ title: 'Leu arquivo' })).title).toBe('Leu arquivo');
  });
});
