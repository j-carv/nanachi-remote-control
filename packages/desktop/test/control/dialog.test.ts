import { describe, expect, it } from 'vitest';
import { afterNativeClose } from '../../src/control/ui/dialog-logic.js';

/**
 * The native `<dialog>` can close without React asking: Chromium does not let a second Escape in a row be cancelled, so
 * it closes the element whatever `onCancel` does. `afterNativeClose` says what the component does when it sees the
 * `close` event, so that the `open` prop and the element never disagree for long.
 */
describe('afterNativeClose', () => {
  it('nothing to do when React closed it (the prop is already false)', () => {
    expect(afterNativeClose({ open: false, dismissible: true })).toBe('none');
    expect(afterNativeClose({ open: false, dismissible: false })).toBe('none');
  });

  it('the element closed by itself while the prop still says open: ask the owner to close it, so the state catches up', () => {
    expect(afterNativeClose({ open: true, dismissible: true })).toBe('ask-close');
  });

  it('closed by itself while an operation runs (not dismissible): the dialog has to come back, or the owner is left waiting on a closed dialog', () => {
    expect(afterNativeClose({ open: true, dismissible: false })).toBe('reopen');
  });
});
