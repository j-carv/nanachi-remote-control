import { effectiveState, jobStateOf, type BackgroundState, type BackgroundView } from './background.js';
import type { ChatNode } from './nesting.js';
import type { ToolItem } from './toolSummary.js';

/** Use the same effective state in activity summaries and individual tool rows. */
export function toolActivityState(item: ToolItem, view: BackgroundView): BackgroundState {
  if (item.background !== undefined) return effectiveState({ background: item.background, timing: item.timing }, view);
  switch (item.status) {
    case 'pending':
    case 'in_progress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case null: return 'unknown';
  }
}

/** Failed descendants and jobs must not disappear inside any automatic disclosure. */
export function hasToolFailure(node: ChatNode): boolean {
  const { item } = node;
  if (item.kind === 'tool_call') {
    const background = item.background;
    if (item.status === 'failed' || background?.state === 'failed' ||
      background?.jobs?.some((job) => jobStateOf(job, background.state) === 'failed') === true) return true;
  }
  return node.children.some(hasToolFailure);
}

/** Consecutive root tools share a stable run, including when the first singleton gains more calls. */
export function groupToolRuns(nodes: readonly ChatNode[]): readonly (readonly ChatNode[])[] {
  const runs: ChatNode[][] = [];
  for (const node of nodes) {
    const last = runs.at(-1);
    if (node.item.kind === 'tool_call' && last?.[0]?.item.kind === 'tool_call') last.push(node);
    else runs.push([node]);
  }
  return runs;
}

/** Split around failures without changing the identity of their enclosing chronological run. */
export function activitySegments(nodes: readonly ChatNode[]): readonly (readonly ChatNode[])[] {
  const segments: ChatNode[][] = [];
  let previousFailed = true;
  for (const node of nodes) {
    const last = segments.at(-1);
    const failed = hasToolFailure(node);
    if (!failed && !previousFailed && last !== undefined) last.push(node);
    else segments.push([node]);
    previousFailed = failed;
  }
  return segments;
}
