const ELLIPSIS = '…';

/**
 * Shortens `text` by taking characters out of its middle, so its start and its end both stay visible. `fits` says
 * whether a candidate fits the space (the caller measures it). When the budget is odd the end takes the extra
 * character, so a path keeps its last folder name readable. Works on code points, so a surrogate pair is never split.
 * Returns the ellipsis alone when not even that fits.
 */
export function truncateMiddle(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const chars = Array.from(text);
  const build = (kept: number): string => {
    const tailLength = Math.ceil(kept / 2);
    const headLength = kept - tailLength;
    return `${chars.slice(0, headLength).join('')}${ELLIPSIS}${chars.slice(chars.length - tailLength).join('')}`;
  };

  if (!fits(build(0))) return ELLIPSIS;
  // Candidates grow with `kept`, so the longest one that fits is found by binary search.
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(build(middle))) low = middle;
    else high = middle - 1;
  }
  return build(low);
}
