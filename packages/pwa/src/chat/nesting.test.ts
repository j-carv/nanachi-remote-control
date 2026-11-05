import { describe, expect, it } from 'vitest';
import type { ChatItem } from './reducer.js';
import { nestItems, type ChatNode } from './nesting.js';

type ToolItem = Extract<ChatItem, { kind: 'tool_call' }>;

function tool(id: string, parentToolCallId?: string): ToolItem {
  return {
    id: `tool-${id}`,
    kind: 'tool_call',
    toolCallId: id,
    title: `Tool ${id}`,
    toolKind: null,
    status: 'completed',
    content: [],
    locations: [],
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  };
}

const text = (id: string): ChatItem => ({ id: `agent-${id}`, kind: 'agent_message', text: id });

function ids(nodes: readonly ChatNode[]): string[] {
  return nodes.map((node) => (node.item.kind === 'tool_call' ? node.item.toolCallId : node.item.id));
}

describe('nestItems', () => {
  it('moves a child under the known tool call that made it', () => {
    const { roots } = nestItems([tool('parent'), tool('child', 'parent'), tool('other')]);
    expect(ids(roots)).toEqual(['parent', 'other']);
    expect(ids(roots[0]?.children ?? [])).toEqual(['child']);
  });

  it('nests a child of a child, so a subagent can be a parent too', () => {
    const { roots } = nestItems([tool('a'), tool('b', 'a'), tool('c', 'b')]);
    expect(ids(roots)).toEqual(['a']);
    const [b] = roots[0]?.children ?? [];
    expect(ids(b?.children ?? [])).toEqual(['c']);
  });

  it('renders children of an unknown parent at the top level, in order', () => {
    const { roots } = nestItems([tool('x', 'missing'), text('1'), tool('y')]);
    expect(ids(roots)).toEqual(['x', 'agent-1', 'y']);
  });

  it('keeps text and other items at the top level and in place', () => {
    const { roots } = nestItems([tool('parent'), text('between'), tool('child', 'parent')]);
    expect(ids(roots)).toEqual(['parent', 'agent-between']);
  });

  it('a tool call that names itself, or forms a cycle, stays at the top level', () => {
    const { roots } = nestItems([tool('self', 'self'), tool('a', 'b'), tool('b', 'a')]);
    expect(ids(roots)).toEqual(['self', 'a', 'b']);
  });

  it('returns the same node objects for unchanged items, so memoized rows skip rendering', () => {
    const parent = tool('parent');
    const child = tool('child', 'parent');
    const other = tool('other');
    const first = nestItems([parent, child, other]);

    // A new item at the end; the parent, its child and the other tool call are the same objects.
    const next = nestItems([parent, child, other, text('new')], first.nodes);
    expect(next.roots[0]).toBe(first.roots[0]);
    expect(next.roots[1]).toBe(first.roots[1]);
  });

  it('a changed child gives its parent a new node too', () => {
    const parent = tool('parent');
    const child = tool('child', 'parent');
    const first = nestItems([parent, child]);
    const changedChild: ToolItem = { ...child, status: 'failed' };
    const next = nestItems([parent, changedChild], first.nodes);
    expect(next.roots[0]).not.toBe(first.roots[0]);
    expect(next.roots[0]?.children[0]?.item).toBe(changedChild);
  });
});
