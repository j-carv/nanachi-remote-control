import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Session, Workspace } from '@nanachi/shared';
import type { Route } from '../navigation.js';
import {
  allowsSidePane,
  enterSends,
  escapeClosesSidePane,
  hasListPane,
  keepsBackOnWide,
  ENTER_SENDS_QUERY,
  layoutModeForViewport,
  layoutModeFromMatches,
  THREE_PANE_MIN_WIDTH,
  THREE_PANE_QUERY,
  WIDE_MIN_HEIGHT,
  WIDE_MIN_WIDTH,
  WIDE_QUERY,
} from './layout.js';

const workspace: Workspace = { id: 'w1', name: 'nanachi', path: 'C:\\Projects\\nanachi', muted: false, createdAt: 1 };
const session: Session = {
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

/** Evaluates the `(min-width: Npx) and (min-height: Npx)` queries of layout.ts, so the real strings are what the tests exercise. */
function matches(query: string, width: number, height: number): boolean {
  return query.split(' and ').every((part) => {
    const found = /^\(min-(width|height): (\d+)px\)$/.exec(part);
    if (!found) throw new Error(`unsupported media feature: ${part}`);
    return (found[1] === 'width' ? width : height) >= Number(found[2]);
  });
}

function modeFromQueries(width: number, height: number) {
  return layoutModeFromMatches(matches(WIDE_QUERY, width, height), matches(THREE_PANE_QUERY, width, height));
}

describe('layout by viewport', () => {
  it('is the phone layout below 900 px wide, including the iPhones in portrait and the iPad in portrait', () => {
    for (const width of [320, 375, 390, 430, 599, 768, 820, 899]) {
      expect(layoutModeForViewport(width, 1000)).toBe('phone');
    }
  });

  it('is the phone layout for the largest iPhones turned to landscape (the viewport is wide but short)', () => {
    // iPhone 15 Pro Max / 16 Plus: 932 x 430. iPhone 16 Pro Max: 956 x 440. Both are wider than 900 px.
    for (const [width, height] of [
      [844, 390],
      [852, 393],
      [926, 428],
      [932, 430],
      [956, 440],
      [1000, 499],
    ] as const) {
      expect(layoutModeForViewport(width, height)).toBe('phone');
      expect(modeFromQueries(width, height)).toBe('phone');
    }
  });

  it('is two panes from 900 px wide up to 1279 px, when the window is tall enough', () => {
    for (const width of [900, 1024, 1180, 1279]) expect(layoutModeForViewport(width, WIDE_MIN_HEIGHT)).toBe('two-pane');
  });

  it('is three panes from 1280 px, when the window is tall enough', () => {
    for (const width of [1280, 1440, 1920, 3840]) {
      expect(layoutModeForViewport(width, WIDE_MIN_HEIGHT)).toBe('three-pane');
    }
  });

  it('is the phone layout for a short window at any width', () => {
    expect(layoutModeForViewport(1440, WIDE_MIN_HEIGHT - 1)).toBe('phone');
    expect(modeFromQueries(1440, WIDE_MIN_HEIGHT - 1)).toBe('phone');
  });

  it('gives the same answer through the media queries as through the numbers', () => {
    for (const width of [320, 899, 900, 932, 1279, 1280, 1920]) {
      for (const height of [300, 430, 499, 500, 800]) {
        expect(modeFromQueries(width, height), `${width}x${height}`).toBe(layoutModeForViewport(width, height));
      }
    }
  });

  it('agrees with the two media queries the hook reads', () => {
    expect(layoutModeFromMatches(false, false)).toBe('phone');
    expect(layoutModeFromMatches(true, false)).toBe('two-pane');
    expect(layoutModeFromMatches(true, true)).toBe('three-pane');
    // The wider query cannot match without the narrower one, but the answer must still not claim a third pane alone.
    expect(layoutModeFromMatches(false, true)).toBe('phone');
    expect(WIDE_QUERY).toBe('(min-width: 900px) and (min-height: 500px)');
    expect(THREE_PANE_QUERY).toBe('(min-width: 1280px) and (min-height: 500px)');
  });

  it('keeps the list pane for both wide modes and the third pane for the wider one only', () => {
    expect(hasListPane('phone')).toBe(false);
    expect(hasListPane('two-pane')).toBe(true);
    expect(hasListPane('three-pane')).toBe(true);
    expect(allowsSidePane('phone')).toBe(false);
    expect(allowsSidePane('two-pane')).toBe(false);
    expect(allowsSidePane('three-pane')).toBe(true);
  });

  it('uses the same two media queries as the `wide:` and `wider:` variants of styles.css', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toContain(`@custom-variant wide (@media ${WIDE_QUERY});`);
    expect(css).toContain(`@custom-variant wider (@media ${THREE_PANE_QUERY});`);
    // The old width-only theme variables would define the same variants a second time, without the height.
    expect(css).not.toContain('--breakpoint-wide');
    expect(css).not.toContain('--breakpoint-wider');
    expect(WIDE_MIN_WIDTH).toBe(900);
    expect(THREE_PANE_MIN_WIDTH).toBe(1280);
  });
});

describe('back button next to the list pane', () => {
  const routes: Array<[Route, boolean]> = [
    [{ kind: 'home' }, false],
    [{ kind: 'settings' }, false],
    [{ kind: 'workspaces' }, false],
    [{ kind: 'sessions', workspace }, false],
    [{ kind: 'chat', workspace, session }, false],
    [{ kind: 'changes', workspace, session }, true],
    [{ kind: 'commits', workspace, session }, true],
    [{ kind: 'commit', workspace, session, hash: 'af9384e' }, true],
    [{ kind: 'files', workspace, path: '' }, true],
    [{ kind: 'editor', workspace, path: 'a.ts' }, true],
    [{ kind: 'devices' }, true],
    [{ kind: 'folders' }, true],
    [{ kind: 'pair', baseUrl: null }, true],
  ];

  it.each(routes)('%j', (route, keeps) => {
    expect(keepsBackOnWide(route)).toBe(keeps);
  });
});

describe('Escape and the third pane', () => {
  it('closes it when nothing else wanted the key', () => {
    expect(escapeClosesSidePane({ defaultPrevented: false, inField: false, overlayOpen: false })).toBe(true);
  });

  it('leaves the key to a dialog, to a field and to a handler that already used it', () => {
    expect(escapeClosesSidePane({ defaultPrevented: true, inField: false, overlayOpen: false })).toBe(false);
    expect(escapeClosesSidePane({ defaultPrevented: false, inField: true, overlayOpen: false })).toBe(false);
    expect(escapeClosesSidePane({ defaultPrevented: false, inField: false, overlayOpen: true })).toBe(false);
  });
});

describe('Enter in the composer', () => {
  it('depends on the pointer, not on the width of the window', () => {
    expect(ENTER_SENDS_QUERY).toBe('(hover: hover) and (pointer: fine)');
    expect(ENTER_SENDS_QUERY).not.toContain('width');
  });

  const enter = { key: 'Enter', shiftKey: false, altKey: false, isComposing: false };

  it('sends with a mouse and keyboard', () => {
    expect(enterSends(enter, true)).toBe(true);
  });

  it('adds a line with Shift+Enter, and on a touch screen', () => {
    expect(enterSends({ ...enter, shiftKey: true }, true)).toBe(false);
    expect(enterSends(enter, false)).toBe(false);
  });

  it('does not send while an input method is composing, nor for other keys', () => {
    expect(enterSends({ ...enter, isComposing: true }, true)).toBe(false);
    expect(enterSends({ ...enter, key: 'a' }, true)).toBe(false);
    expect(enterSends({ ...enter, altKey: true }, true)).toBe(false);
  });
});
