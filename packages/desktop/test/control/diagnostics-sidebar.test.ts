import { describe, expect, it } from 'vitest';
import { CONTROL_SECTIONS, SIDEBAR_SECTIONS } from '../../src/common/control-api.js';
import { sectionForShortcut, type KeyLike } from '../../src/common/shortcuts.js';
import { initialSection } from '../../src/control/lib/sessions.js';
import { SECTIONS, shortcutOf } from '../../src/control/shell/nav.js';

const ctrl = (key: string): KeyLike => ({ key, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false });

describe('diagnostics in the sidebar', () => {
  it('sits between Tailscale and Logs', () => {
    expect(SIDEBAR_SECTIONS).toEqual(['overview', 'folders', 'devices', 'accounts', 'tailscale', 'diagnostics', 'logs', 'settings', 'sessions']);
    expect(SECTIONS.map((meta) => meta.id)).toEqual(SIDEBAR_SECTIONS);
  });

  it('has no Ctrl+N shortcut, so the numbers the other sections have keep their place', () => {
    expect(shortcutOf('diagnostics')).toBeNull();
    expect(sectionForShortcut(ctrl('9'))).toBeNull();
  });

  it('keeps Ctrl+1..8 on the sections they selected before', () => {
    expect(CONTROL_SECTIONS).toEqual(['overview', 'folders', 'devices', 'accounts', 'tailscale', 'logs', 'settings', 'sessions']);
    expect(shortcutOf('tailscale')).toBe('Ctrl+5');
    expect(shortcutOf('logs')).toBe('Ctrl+6');
    expect(shortcutOf('settings')).toBe('Ctrl+7');
    expect(shortcutOf('sessions')).toBe('Ctrl+8');
    CONTROL_SECTIONS.forEach((section, index) => {
      expect(sectionForShortcut(ctrl(String(index + 1)))).toBe(section);
    });
  });

  it('opens on its own section when a window asks for it', () => {
    expect(initialSection('?section=diagnostics')).toBe('diagnostics');
  });
});
