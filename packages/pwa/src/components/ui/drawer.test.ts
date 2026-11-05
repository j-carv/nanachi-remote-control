import { describe, expect, it } from 'vitest';
import { showsCloseButton } from './drawer.js';

type CloseState = Parameters<typeof showsCloseButton>[0];

const WIDE_DIALOG: CloseState = { wide: true, panel: 'dialog', dismissible: true, hideClose: false };

describe('showsCloseButton', () => {
  it('a wide dialog that can be dismissed has its close button', () => {
    expect(showsCloseButton(WIDE_DIALOG)).toBe(true);
  });

  it('the phone has none: its sheets close by dragging, Cancel or the back gesture', () => {
    expect(showsCloseButton({ ...WIDE_DIALOG, wide: false })).toBe(false);
  });

  it('a side panel keeps its header as it is', () => {
    expect(showsCloseButton({ ...WIDE_DIALOG, panel: 'side' })).toBe(false);
  });

  it('a sheet that cannot be dismissed right now (busy, or a login that is running) has no button that would do nothing', () => {
    expect(showsCloseButton({ ...WIDE_DIALOG, dismissible: false })).toBe(false);
  });

  it('a sheet whose own button already closes it can hide the corner one', () => {
    expect(showsCloseButton({ ...WIDE_DIALOG, hideClose: true })).toBe(false);
  });
});
