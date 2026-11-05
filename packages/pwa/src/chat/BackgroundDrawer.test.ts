import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackgroundPanel } from './BackgroundDrawer.js';
import { type BackgroundEntry } from './background.js';

const NOW = 1_700_000_000_000;
const noop = () => undefined;

function entry(overrides: Partial<BackgroundEntry>): BackgroundEntry {
  return {
    id: 'tool-1',
    kind: 'subagent',
    state: 'running',
    label: 'Revisar parser',
    agentType: undefined,
    jobs: [],
    startedAt: NOW - 125_000,
    updatedAt: NOW - 125_000,
    startEnds: 0,
    ...overrides,
  };
}

function render(entries: BackgroundEntry[]): string {
  return renderToStaticMarkup(createElement(BackgroundPanel, { entries, now: NOW, onPick: noop }));
}

describe('BackgroundPanel', () => {
  it('shows the empty state when nothing ran in the background', () => {
    expect(render([])).toContain('Nada rodando em segundo plano.');
  });

  it('groups the items as Subagentes, Comandos and Jobs, and leaves out empty groups', () => {
    const html = render([
      entry({ id: 'tool-job', kind: 'job', label: 'Lote' }),
      entry({ id: 'tool-sh', kind: 'shell', label: 'npm test' }),
      entry({ id: 'tool-sub', kind: 'subagent', label: 'Revisar parser' }),
    ]);

    expect(html.indexOf('Subagentes')).toBeGreaterThan(-1);
    expect(html.indexOf('Subagentes')).toBeLessThan(html.indexOf('Comandos'));
    expect(html.indexOf('Comandos')).toBeLessThan(html.indexOf('>Jobs<'));
  });

  it('omits a group that has no items', () => {
    const html = render([entry({ kind: 'subagent' })]);
    expect(html).toContain('Subagentes');
    expect(html).not.toContain('Comandos');
    expect(html).not.toContain('>Jobs<');
  });

  it('a row shows its label, agent type, state and how long it has run', () => {
    const html = render([entry({ agentType: 'Explore', state: 'running', startedAt: NOW - 125_000 })]);
    expect(html).toContain('Revisar parser');
    expect(html).toContain('Explore');
    expect(html).toContain('Em andamento');
    expect(html).toContain('Iniciado há 2 min');
  });

  it('a finished row shows how long it took, not how long ago it started', () => {
    const html = render([
      entry({ state: 'completed', startedAt: NOW - 600_000, updatedAt: NOW - 555_000 }),
    ]);
    expect(html).toContain('Concluído');
    expect(html).toContain('Durou 45 s');
  });

  it('a row whose turn has ended says "Estado desconhecido" and keeps its state on the glyph', () => {
    const html = render([entry({ state: 'unknown' })]);
    expect(html).toContain('Estado desconhecido');
    expect(html).toContain('data-state="unknown"');
  });

  it('each row is a button carrying its item id, so a tap can reveal the card', () => {
    const html = render([entry({ id: 'tool-sub' })]);
    expect(html).toContain('data-item-id="tool-sub"');
    expect(html).toContain('<button');
  });

  it('lists the jobs under their item, each with its own status', () => {
    const html = render([
      entry({
        kind: 'job',
        label: 'Compilar e testar',
        jobs: [
          { id: 'j1', label: 'Compilar pacote', status: 'completed' },
          { id: 'j2', label: 'Testes unitários', status: 'running' },
        ],
        state: 'unknown',
      }),
    ]);
    expect(html).toContain('Compilar pacote');
    expect(html).toContain('Testes unitários');
    expect(html).toContain('data-job-state="completed"');
    expect(html).toContain('data-job-state="unknown"');
  });
});
