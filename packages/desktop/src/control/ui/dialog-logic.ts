/**
 * What `Dialog` does when the native `<dialog>` element closes (its `close` event). React closes it by clearing the `open`
 * prop, and then there is nothing to do. But the element can also close by itself: Chromium does not let a second Escape
 * in a row be cancelled, so it closes the element whatever the `cancel` handler did, and the prop would stay `true` with
 * no dialog on screen.
 *
 * - `none`: the prop is already false.
 * - `ask-close`: tell the owner (`onClose`), so its state catches up with what the user did.
 * - `reopen`: the owner does not allow closing right now (`dismissible` is false while an operation runs): show it again.
 */
export function afterNativeClose(input: { open: boolean; dismissible: boolean }): 'none' | 'ask-close' | 'reopen' {
  if (!input.open) return 'none';
  return input.dismissible ? 'ask-close' : 'reopen';
}
