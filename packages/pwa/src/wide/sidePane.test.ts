import { describe, expect, it } from 'vitest';
import type { Session, Workspace } from '@nanachi/shared';
import type { Route } from '../navigation.js';
import {
  activeSideRoute,
  backSidePane,
  openSidePane,
  opensInSidePane,
  pushSidePane,
  replaceSidePane,
  sideBackAffordance,
  sideOwnerKey,
} from './sidePane.js';

const workspace: Workspace = { id: 'w1', name: 'nanachi', path: 'C:\\Projects\\nanachi', muted: false, createdAt: 1 };
const agentSession: Session = {
  id: 's1',
  workspaceId: 'w1',
  agent: 'claude',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  accountId: null,
  worktree: null,
  createdAt: 1,
  updatedAt: 1,
};
const shellSession: Session = { ...agentSession, id: 's2', agent: 'shell', kind: 'pty' };

const chat: Route = { kind: 'chat', workspace, session: agentSession };
const terminalChat: Route = { kind: 'chat', workspace, session: shellSession };
const changes: Route = { kind: 'changes', workspace, session: agentSession };
const commits: Route = { kind: 'commits', workspace, session: agentSession };
const commit: Route = { kind: 'commit', workspace, session: agentSession, hash: 'af9384ef96648594f13a8bd80ae53aa3e830a8ae' };
const files: Route = { kind: 'files', workspace, path: '' };
const editor: Route = { kind: 'editor', workspace, path: 'src/a.ts' };

describe('who owns the third pane', () => {
  it('a conversation or a terminal does, nothing else', () => {
    expect(sideOwnerKey(chat)).toBe('chat:s1');
    expect(sideOwnerKey(terminalChat)).toBe('chat:s2');
    expect(sideOwnerKey({ kind: 'home' })).toBeNull();
    expect(sideOwnerKey({ kind: 'sessions', workspace })).toBeNull();
    expect(sideOwnerKey(files)).toBeNull();
  });
});

describe('what opens beside the conversation', () => {
  it('changes, files and the editor do', () => {
    expect(opensInSidePane(changes, chat)).toBe(true);
    expect(opensInSidePane(files, chat)).toBe(true);
    expect(opensInSidePane(editor, chat)).toBe(true);
  });

  it('the commit history and one of its commits do, as the changes do', () => {
    expect(opensInSidePane(commits, chat)).toBe(true);
    expect(opensInSidePane(commit, chat)).toBe(true);
  });

  it('a terminal does from an agent chat, but not from another terminal', () => {
    expect(opensInSidePane(terminalChat, chat)).toBe(true);
    expect(opensInSidePane(terminalChat, terminalChat)).toBe(false);
  });

  it('another conversation, the sessions list and the app screens take the main pane', () => {
    const other: Route = { kind: 'chat', workspace, session: { ...agentSession, id: 's9' } };
    expect(opensInSidePane(other, chat)).toBe(false);
    expect(opensInSidePane({ kind: 'sessions', workspace }, chat)).toBe(false);
    expect(opensInSidePane({ kind: 'settings' }, chat)).toBe(false);
    expect(opensInSidePane({ kind: 'pair', baseUrl: null }, chat)).toBe(false);
  });
});

describe('the pane stack', () => {
  it('is closed until something opens it, and shows its screen only for its own conversation', () => {
    expect(activeSideRoute(null, 'chat:s1')).toBeNull();
    const pane = openSidePane('chat:s1', files);
    expect(activeSideRoute(pane, 'chat:s1')).toEqual(files);
    expect(activeSideRoute(pane, 'chat:s2')).toBeNull();
    expect(activeSideRoute(pane, null)).toBeNull();
  });

  it('a screen opened from the pane goes on top, and back returns to the one under it', () => {
    const pane = pushSidePane(openSidePane('chat:s1', files), editor);
    expect(pane === null ? null : activeSideRoute(pane, 'chat:s1')).toEqual(editor);
    expect(sideBackAffordance(pane)).toBe('back');
    const back = backSidePane(pane);
    expect(back === null ? null : activeSideRoute(back, 'chat:s1')).toEqual(files);
    expect(sideBackAffordance(back)).toBe('close');
  });

  it('the working tree opened from the commit history in the pane goes back to the history', () => {
    const pane = pushSidePane(openSidePane('chat:s1', commits), changes);
    expect(pane === null ? null : activeSideRoute(pane, 'chat:s1')).toEqual(changes);
    expect(sideBackAffordance(pane)).toBe('back');
    const back = backSidePane(pane);
    expect(back === null ? null : activeSideRoute(back, 'chat:s1')).toEqual(commits);
    expect(sideBackAffordance(back)).toBe('close');
  });

  it('back from the first screen closes the pane', () => {
    expect(backSidePane(openSidePane('chat:s1', changes))).toBeNull();
    expect(backSidePane(null)).toBeNull();
  });

  it('replace swaps the screen on top (the explorer climbing to a parent folder)', () => {
    const parent: Route = { kind: 'files', workspace, path: 'src' };
    const pane = replaceSidePane(openSidePane('chat:s1', { kind: 'files', workspace, path: 'src/deep' }), parent);
    expect(pane === null ? null : activeSideRoute(pane, 'chat:s1')).toEqual(parent);
    expect(pane?.nav.index).toBe(0);
  });

  it('opening another screen from the chat starts a new stack instead of piling on', () => {
    const first = openSidePane('chat:s1', files);
    const second = openSidePane('chat:s1', changes);
    expect(activeSideRoute(second, 'chat:s1')).toEqual(changes);
    expect(second.nav.routes).toHaveLength(1);
    expect(first.nav.routes).toEqual([files]);
  });

  it('push, replace and back on a closed pane stay closed', () => {
    expect(pushSidePane(null, files)).toBeNull();
    expect(replaceSidePane(null, files)).toBeNull();
    expect(sideBackAffordance(null)).toBe('close');
  });
});
