/**
 * Who may talk to the installer and uninstaller main processes. Their windows load a local page and have no navigation or
 * `window.open`, but the handlers delete folders and write the registry, so each one also checks the caller instead of
 * trusting that nothing else will ever load in those windows (a future link, a devtools console, a second window).
 */

/** The part of an `ipcMain` event that identifies the caller. */
export interface IpcCallerLike {
  /** `event.sender`: the web contents that sent the message. */
  sender: { id: number };
  /** `event.senderFrame`: the frame that sent it; absent when it is already gone. */
  senderFrame?: { url: string; parent?: unknown } | null;
}

/**
 * True when the message came from the main frame of the window this process created, still showing a local file. The
 * window's web contents id is read by the caller when it asks; null (no window) trusts nobody.
 */
export function isOwnWindowCaller(event: IpcCallerLike, windowContentsId: number | null): boolean {
  if (windowContentsId === null || event.sender.id !== windowContentsId) return false;
  const frame = event.senderFrame;
  if (frame === undefined || frame === null) return false;
  // A subframe (even a local one) is not the page we loaded.
  if (frame.parent !== undefined && frame.parent !== null) return false;
  return frame.url.startsWith('file:');
}
