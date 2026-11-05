/**
 * Starts an action that nobody waits for (open a folder, open a page in the browser) and calls `report` when it fails:
 * main refuses what it does not recognise by rejecting, and a rejection nobody handles would vanish without a word.
 * Never throws and never leaves an unhandled rejection, whatever `run` or `report` do.
 */
export function runReported(run: () => Promise<unknown>, report: () => void): void {
  void (async () => {
    try {
      await run();
    } catch {
      try {
        report();
      } catch {
        // Nothing left to tell the user with.
      }
    }
  })();
}
