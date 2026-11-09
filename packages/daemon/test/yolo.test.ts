import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { realpathSync } from 'node:fs';
import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { yoloApproval } from '../src/yolo.js';
import { removeTempDir } from './temp.js';

const options: RequestPermissionRequest['options'] = [
  { kind: 'allow_once', name: 'Allow once', optionId: 'once' },
  { kind: 'allow_always', name: 'Always allow', optionId: 'always' },
];

const edit = (path: string): RequestPermissionRequest['toolCall'] => ({
  toolCallId: 'tool',
  name: 'Edit',
  kind: 'edit',
  rawInput: { file_path: path, old_string: 'before', new_string: 'after' },
});

let base: string;
let workspace: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-yolo-')));
  workspace = join(base, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'example.ts'), 'before');
});

afterEach(async () => removeTempDir(base));

function approve(toolCall: RequestPermissionRequest['toolCall'], choices = options): string | undefined {
  return yoloApproval(workspace, { sessionId: 'session', toolCall, options: choices });
}

describe('YOLO permission policy', () => {
  it('selects only a unique one-time grant for a recognized workspace operation', () => {
    expect(approve(edit(join(workspace, 'example.ts')))).toBe('once');
    expect(approve({ toolCallId: 'read', name: 'Read', kind: 'read', rawInput: { file_path: 'example.ts' } })).toBe('once');
    expect(approve({ toolCallId: 'write', name: 'Write', kind: 'edit', rawInput: { file_path: 'new.ts', content: 'new' } })).toBe('once');
    expect(approve(edit('example.ts'), options.filter((option) => option.kind === 'allow_always'))).toBeUndefined();
    expect(approve(edit('example.ts'), [...options, { kind: 'allow_once', name: 'Other', optionId: 'other' }])).toBeUndefined();
  });

  it('asks for deletions, shell commands, ambiguous edits, databases and paths outside the workspace', async () => {
    await writeFile(join(workspace, 'storage.sqlite'), 'synthetic');
    await writeFile(join(base, 'outside.ts'), 'synthetic');
    const unsafe = [
      { ...edit('example.ts'), name: 'Delete', kind: 'delete' as const },
      { ...edit('example.ts'), name: 'Bash', kind: 'execute' as const, rawInput: { command: 'DROP DATABASE example' } },
      { ...edit('example.ts'), name: null },
      { ...edit('example.ts'), rawInput: { file_path: 'example.ts', old_string: 'before', new_string: '', replace_all: true } },
      { ...edit('example.ts'), name: 'Write', rawInput: { file_path: 'example.ts', content: 'overwrite' } },
      { ...edit('example.ts'), locations: [{ path: join(base, 'outside.ts') }] },
      edit('storage.sqlite'),
      edit(workspace),
      edit(join(base, 'outside.ts')),
      edit('../outside.ts'),
    ];
    for (const toolCall of unsafe) expect(approve(toolCall)).toBeUndefined();
  });

  it('asks when a junction or hard link aliases another target', async () => {
    await symlink(base, join(workspace, 'junction'), 'junction');
    await link(join(workspace, 'example.ts'), join(workspace, 'hardlink.ts'));
    expect(approve(edit('hardlink.ts'))).toBeUndefined();
    expect(approve(edit('junction/workspace/example.ts'))).toBeUndefined();
    expect(approve({
      toolCallId: 'write',
      name: 'Write',
      kind: 'edit',
      rawInput: { file_path: 'junction/new.ts', content: 'new' },
    })).toBeUndefined();
  });
});
