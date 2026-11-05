// The chat components rendered in English. They are server-rendered to static markup, so effects do not run.
// Portuguese is covered by the component tests next to each file (the suite runs in pt-BR).
import type { AvailableCommand, Loop } from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import { setLanguage } from '../i18n/index.js';
import { AttachmentDrafts } from './AttachmentDrafts.js';
import { BackgroundPanel } from './BackgroundDrawer.js';
import { backgroundStateText } from './BackgroundStatus.js';
import type { BackgroundView } from './background.js';
import { ChatItemView } from './ChatItemView.js';
import { LoopChip } from './LoopChip.js';
import type { ChatNode } from './nesting.js';
import { PermissionCard } from './PermissionCard.js';
import { PlanCard } from './PlanCard.js';
import type { ChatItem, PendingPermission } from './reducer.js';
import { SlashMenu } from './SlashMenu.js';
import type { BackgroundEntry } from './background.js';

const api = {} as ApiClient;
const VIEW: BackgroundView = { active: true, turnEnds: 0 };
const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

function item(overrides: ChatItem): string {
  const node: ChatNode = { item: overrides, children: [] };
  return html(createElement(ChatItemView, { node, api, view: VIEW }));
}

describe('chat items in English', () => {
  it('names the loop round, the thought and the account switch', () => {
    setLanguage('en');
    expect(item({ id: 'u-1', kind: 'user_message', text: 'run the tests', loopIteration: 3 })).toContain('Loop #3');
    const thought = item({ id: 't-1', kind: 'agent_thought', text: 'abcde' });
    expect(thought).toContain('Thinking');
    expect(thought).toContain('· 5 characters');
    expect(item({ id: 't-2', kind: 'agent_thought', text: 'a' })).toContain('· 1 character<');
    expect(item({ id: 'a-1', kind: 'account_changed', label: 'Work' })).toContain('Switched to account Work');
  });

  it('writes the round note in English and leaves the agent text alone', () => {
    setLanguage('en');
    const rendered = item({ id: 'a-2', kind: 'agent_message', text: 'Leu arquivo\n[[nanachi-loop-next: 45s]]' });
    expect(rendered).toContain('Leu arquivo');
    expect(rendered).toContain('Next round in 45 s');
    expect(rendered).not.toContain('nanachi-loop-next');
  });

  it('summarizes a tool call: status, +/- line counts and the inner actions of a parent', () => {
    setLanguage('en');
    const tool: ChatItem = {
      id: 'tool-1',
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'Editar a.ts',
      toolKind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'a\nb', newText: 'a\nc\nd' }],
      locations: [],
    };
    const rendered = item(tool);
    expect(rendered).toContain('Completed');
    expect(rendered).toContain('aria-label="2 lines added, 1 removed"');

    const parent: ChatNode = {
      item: { ...tool, id: 'tool-2', toolCallId: 'call-2', content: [], background: { kind: 'subagent', state: 'running' } },
      children: [{ item: tool, children: [] }],
    };
    expect(html(createElement(ChatItemView, { node: parent, api, view: VIEW }))).toContain(
      '1 inner action · latest: Editar a.ts',
    );
  });
});

describe('chat cards in English', () => {
  it('labels the permission card and the plan', () => {
    setLanguage('en');
    const request: PendingPermission = {
      kind: 'permission_request',
      seq: 1,
      sessionId: 's-1',
      ts: 1,
      requestId: 'r-1',
      title: 'Executar npm test',
      content: [],
      options: [{ optionId: 'allow', name: 'Permitir', kind: 'allow_once' }],
    };
    const permission = html(createElement(PermissionCard, { api, request, onRespond: () => true }));
    expect(permission).toContain('aria-label="Permission request"');
    expect(permission).toContain('Executar npm test');
    expect(permission).toContain('Permitir');

    const plan = html(
      createElement(PlanCard, {
        entries: [
          { content: 'Ler o código', priority: 'medium', status: 'completed' },
          { content: 'Escrever o teste', priority: 'medium', status: 'in_progress' },
          { content: 'Rodar tudo', priority: 'medium', status: 'pending' },
        ],
      }),
    );
    expect(plan).toContain('aria-label="Plan"');
    expect(plan).toContain('aria-label="Completed"');
    expect(plan).toContain('aria-label="In progress"');
    expect(plan).toContain('aria-label="Pending"');
  });

  it('labels the slash menu and its empty states', () => {
    setLanguage('en');
    const command: AvailableCommand = { name: 'model', description: 'Troca o modelo', hint: null };
    const menu = (commands: AvailableCommand[], query: string) =>
      html(
        createElement(SlashMenu, {
          commands,
          query,
          search: { onChange: noop, onClose: noop },
          onPick: noop,
        }),
      );
    const withCommand = menu([command], '');
    expect(withCommand).toContain('aria-label="Agent commands"');
    expect(withCommand).toContain('aria-label="Search commands"');
    expect(withCommand).toContain('placeholder="Search commands"');
    expect(withCommand).toContain('aria-label="Close commands"');
    expect(withCommand).toContain('Troca o modelo');
    expect(menu([], '')).toContain('This agent hasn&#x27;t announced any commands.');
    expect(menu([command], ' zzz ')).toContain('No command matches “zzz”.');
  });

  it('labels the attachment drafts with the file name', () => {
    setLanguage('en');
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    const rendered = html(
      createElement(AttachmentDrafts, {
        drafts: [{ id: 'd-1', file, previewUrl: 'blob:preview' }],
        onRemove: noop,
        onCrop: noop,
      }),
    );
    expect(rendered).toContain('aria-label="Attachments"');
    expect(rendered).toContain('aria-label="Crop photo.png"');
    expect(rendered).toContain('aria-label="Remove photo.png"');
  });
});

describe('loop chip and background in English', () => {
  const loop: Loop = {
    sessionId: 's-1',
    prompt: 'run the tests',
    mode: 'interval',
    intervalMs: 300_000,
    maxIterations: null,
    iterations: 1,
    state: 'paused',
    nextRunAt: null,
    lastRunAt: null,
    lastError: null,
    createdAt: 1,
    revision: 1,
  };

  it('describes the chip and what a tap does', () => {
    setLanguage('en');
    expect(html(createElement(LoopChip, { loop, onOpen: noop }))).toContain('aria-label="Loop paused. Open Loop mode"');
  });

  it('writes the drawer sections, the state and the timing of a row', () => {
    setLanguage('en');
    const entry: BackgroundEntry = {
      id: 'tool-1',
      kind: 'subagent',
      state: 'running',
      label: 'Revisar parser',
      agentType: undefined,
      jobs: [],
      startedAt: 1_700_000_000_000 - 125_000,
      updatedAt: 1_700_000_000_000 - 125_000,
      startEnds: 0,
    };
    const rendered = html(createElement(BackgroundPanel, { entries: [entry], now: 1_700_000_000_000, onPick: noop }));
    expect(rendered).toContain('Subagents');
    expect(rendered).toContain('Running · Started 2 min ago');
    expect(html(createElement(BackgroundPanel, { entries: [], now: 0, onPick: noop }))).toContain(
      'Nothing running in the background.',
    );
    expect(backgroundStateText('unknown')).toBe('Unknown state');
  });
});
