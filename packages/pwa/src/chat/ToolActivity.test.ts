import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import { setLanguage } from '../i18n/index.js';
import { ChatItemView } from './ChatItemView.js';
import type { ChatNode } from './nesting.js';
import { nestItems } from './nesting.js';
import type { ChatItem } from './reducer.js';
import { ToolActivity } from './ToolActivity.js';
import { activitySegments, groupToolRuns, hasToolFailure, toolActivityState } from './activityGrouping.js';
import type { ToolItem } from './toolSummary.js';

const api = {} as ApiClient;
const view = { active: true, turnEnds: 0 };
function tool(id: string, overrides: Partial<ToolItem> = {}): ToolItem {
  return { id, kind: 'tool_call', toolCallId: id, title: id, status: 'completed', toolKind: null, content: [], locations: [], ...overrides };
}
function render(nodes: readonly ChatNode[]): string {
  return renderToStaticMarkup(createElement(ToolActivity, {
    nodes, view,
    renderNode: (node) => createElement(ChatItemView, { node, api, view, nested: true }),
  }));
}

it('groups consecutive top-level tools but never crosses non-tool boundaries', () => {
  const boundaries: ChatItem[] = [
    { id: 'agent', kind: 'agent_message', text: 'Continue' },
    { id: 'user', kind: 'user_message', text: 'Continue' },
    { id: 'thought', kind: 'agent_thought', text: 'Thinking' },
    { id: 'error', kind: 'error', message: 'Failed' },
    { id: 'plan', kind: 'plan', entries: [] },
    { id: 'question', kind: 'user_question', requestId: 'request', question: 'Continue?', options: [], expiresAt: 100, result: null, unavailable: false },
  ];
  for (const boundary of boundaries) {
    const roots = nestItems([tool('one'), tool('two'), boundary, tool('three')]).roots;
    expect(groupToolRuns(roots).map((run) => run.map((node) => node.item.id))).toEqual([
      ['one', 'two'], [boundary.id], ['three'],
    ]);
  }
});

it('keeps the run anchored to its first call as a singleton grows and statuses complete', () => {
  const first = tool('one', { status: 'in_progress' });
  const initial = groupToolRuns(nestItems([first]).roots)[0];
  const appended = groupToolRuns(nestItems([{ ...first, status: 'completed' }, tool('two')]).roots)[0];
  expect(initial?.[0]?.item.id).toBe(appended?.[0]?.item.id);
  expect(appended).toHaveLength(2);
});

it('splits around failures in chronology, retaining parent nesting and the enclosing run identity', () => {
  const items = [tool('before'), tool('parent'), tool('child', { parentToolCallId: 'parent', status: 'failed' }), tool('after')];
  const roots = nestItems(items).roots;
  const runs = groupToolRuns(roots);
  expect(runs).toHaveLength(1);
  expect(activitySegments(roots).map((segment) => segment.map((node) => node.item.id))).toEqual([
    ['before'], ['parent'], ['after'],
  ]);
  const markup = render(roots);
  const exception = markup.indexOf('data-slot="tool-activity-exception"');
  expect(exception).toBeGreaterThan(markup.indexOf('</details>'));
  expect(markup.indexOf('data-item-id="parent"')).toBeLessThan(markup.indexOf('data-item-id="child"'));
  expect(markup.indexOf('data-item-id="child"')).toBeLessThan(markup.indexOf('data-item-id="after"'));
  expect(markup).toContain('data-slot="tool-exceptions"');
});

it('does not collapse failed tools, nested background failures or failed jobs', () => {
  const failed = tool('failed', { status: 'failed' });
  const jobs = tool('jobs', { background: { kind: 'job', state: 'running', jobs: [{ id: 'job', status: 'errored' }] } });
  const nested = tool('nested', { parentToolCallId: 'parent', background: { kind: 'subagent', state: 'failed' } });
  const roots = nestItems([failed, jobs, tool('parent'), nested]).roots;
  expect(roots.every(hasToolFailure)).toBe(true);
  const markup = render(roots);
  expect(markup).not.toContain('data-slot="tool-activity"');
  expect(markup).toContain('data-job-state="failed"');
  expect(markup).toContain('data-item-id="nested"');
});

it('uses effective background states, never reporting unknown or stopped work as completed', () => {
  const running = tool('background', {
    background: { kind: 'shell', state: 'running' },
    timing: { startedAt: 1, updatedAt: 1, startEnds: 0, seenEnds: 0 },
  });
  expect(toolActivityState(running, view)).toBe('running');
  expect(toolActivityState(running, { active: false, turnEnds: 0 })).toBe('unknown');
  expect(toolActivityState(running, { active: true, turnEnds: 1 })).toBe('unknown');
  expect(toolActivityState(tool('stopped', { background: { kind: 'job', state: 'stopped' } }), view)).toBe('stopped');
});

describe.each([
  ['pt-BR', '2 ações concluídas', '2 ações'],
  ['en', '2 actions completed', '2 actions'],
  ['es', '2 acciones completadas', '2 acciones'],
] as const)('activity summaries in %s', (language, completed, actions) => {
  it('starts collapsed and summarizes completion once for the group', () => {
    setLanguage(language);
    const markup = render(nestItems([tool('one'), tool('two')]).roots);
    expect(markup).toContain(completed);
    expect(markup).toMatch(/<details data-slot="tool-activity"(?![^>]*\sopen)[^>]*>/);
    expect(markup).toContain('data-slot="tool-activity-rows"');
    expect(markup).not.toContain('data-slot="badge"');
  });

  it('shows the current action and total while running, not merely the latest completed action', () => {
    setLanguage(language);
    const markup = render(nestItems([tool('Reading parser.ts', { status: 'in_progress' }), tool('Finished lookup')]).roots);
    const summary = markup.slice(0, markup.indexOf('</summary>'));
    expect(summary).toContain('Reading parser.ts');
    expect(summary).toContain(actions);
    expect(summary).not.toContain('Finished lookup');
    expect(summary).toContain('data-state="running"');
  });
});
