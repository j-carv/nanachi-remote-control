import type { ChatItem } from './reducer.js';

/** A chat item and the tool calls it made (subagent children). Children are in chat order. */
export interface ChatNode {
  readonly item: ChatItem;
  readonly children: readonly ChatNode[];
}

export interface NestedItems {
  /** Items that render at the top level, in chat order. */
  readonly roots: readonly ChatNode[];
  /** Every node by item id, to pass to the next call. */
  readonly nodes: ReadonlyMap<string, ChatNode>;
}

const NO_CHILDREN: readonly ChatNode[] = [];

function sameNodes(a: readonly ChatNode[], b: readonly ChatNode[]): boolean {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}

/** True when following the parents from `item` comes back to `item`. */
function inLoop(item: ChatItem, parentOf: ReadonlyMap<ChatItem, ChatItem>): boolean {
  let steps = 0;
  for (let current = parentOf.get(item); current !== undefined && steps <= parentOf.size; current = parentOf.get(current)) {
    if (current === item) return true;
    steps += 1;
  }
  return false;
}

/**
 * Nests tool calls under the tool call that made them (`parentToolCallId`). A child whose parent is not in `items`
 * (not loaded yet, or never seen) stays at the top level. `previous` is the `nodes` of the last call: a node whose
 * item and children are the same objects is reused, so a memoized row does not re-render for an unrelated update.
 */
export function nestItems(
  items: readonly ChatItem[],
  previous: ReadonlyMap<string, ChatNode> = new Map(),
): NestedItems {
  const byToolCallId = new Map<string, ChatItem>();
  for (const item of items) {
    if (item.kind === 'tool_call') byToolCallId.set(item.toolCallId, item);
  }

  const parentOf = new Map<ChatItem, ChatItem>();
  for (const item of items) {
    if (item.kind !== 'tool_call' || item.parentToolCallId === undefined) continue;
    const parent = byToolCallId.get(item.parentToolCallId);
    if (parent !== undefined && parent !== item) parentOf.set(item, parent);
  }
  // A loop of parents has no top level to hang from, so every member stays at the top level.
  const looped = [...parentOf.keys()].filter((item) => inLoop(item, parentOf));
  for (const item of looped) parentOf.delete(item);

  const childrenOf = new Map<ChatItem, ChatItem[]>();
  for (const item of items) {
    const parent = parentOf.get(item);
    if (parent === undefined) continue;
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) childrenOf.set(parent, [item]);
    else siblings.push(item);
  }

  const nodes = new Map<string, ChatNode>();
  const build = (item: ChatItem): ChatNode => {
    const children = (childrenOf.get(item) ?? []).map(build);
    const prior = previous.get(item.id);
    const node: ChatNode =
      prior !== undefined && prior.item === item && sameNodes(prior.children, children)
        ? prior
        : { item, children: children.length === 0 ? NO_CHILDREN : children };
    nodes.set(item.id, node);
    return node;
  };

  const roots = items.filter((item) => !parentOf.has(item)).map(build);
  return { roots, nodes };
}
