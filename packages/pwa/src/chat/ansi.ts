/*
 * Escape sequences of terminal output that agents send inside text (omp `/usage` prints SGR colors). The chat does
 * not render a terminal, so they are removed before the text reaches the markdown renderer. Based on the patterns
 * of the `ansi-regex` package, without the dependency.
 */

/** OSC (hyperlink, window title): ESC ] ... terminated by BEL or ST (ESC \). */
const OSC = String.raw`\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)`;

/** CSI (SGR colors, cursor and erase), with ESC or the 8-bit introducer \u009b. */
const CSI = String.raw`[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]`;

/** A sequence cut by the end of a streaming chunk (ESC, or ESC [ and parameters), removed until it completes. */
const PARTIAL_AT_END = String.raw`\u001B(?:\[[\d;?]*)?$`;

const ANSI_PATTERN = new RegExp(`${OSC}|${CSI}|${PARTIAL_AT_END}`, 'g');

/** Text without ANSI escape sequences (colors, cursor moves, OSC). Text without escapes comes back unchanged. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
