/** Joins class names, skipping falsy parts. Variants are written out in full, so no class merging is needed. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
