/** Parsed translation files: language, then namespace, then the JSON content. */
export type LocaleFiles = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The leaves of a namespace file, keyed by their dotted path. A leaf that is not a string is reported with the
 * value `null`, so the caller can flag it.
 */
export function flattenLeaves(value: unknown, prefix = ''): Map<string, string | null> {
  const leaves = new Map<string, string | null>();
  if (!isPlainObject(value)) return leaves;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(child)) {
      for (const [childPath, text] of flattenLeaves(child, path)) leaves.set(childPath, text);
    } else {
      leaves.set(path, typeof child === 'string' ? child : null);
    }
  }
  return leaves;
}

/** The `{{name}}` placeholders of a text, sorted and without repeats. */
export function placeholdersOf(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/**
 * Compares every language with the reference one and lists what is wrong. An empty list means the languages agree:
 * every namespace has a file in every language, the same keys, the same placeholders, only non-empty strings, and a
 * plural form `_one` always comes with `_other`.
 */
export function compareLocales(files: LocaleFiles, reference: string, namespaces: readonly string[]): string[] {
  const problems: string[] = [];
  const referenceFiles = files[reference] ?? {};

  for (const [language, byNamespace] of Object.entries(files)) {
    for (const namespace of namespaces) {
      if (!(namespace in byNamespace)) problems.push(`${language}/${namespace}.json is missing`);
    }
    for (const namespace of Object.keys(byNamespace)) {
      if (!namespaces.includes(namespace)) problems.push(`${language}/${namespace}.json is not a registered namespace`);
    }
  }

  for (const namespace of namespaces) {
    const expected = flattenLeaves(referenceFiles[namespace]);
    for (const [language, byNamespace] of Object.entries(files)) {
      if (!(namespace in byNamespace)) continue;
      const actual = flattenLeaves(byNamespace[namespace]);
      const where = `${language}/${namespace}.json`;

      for (const key of expected.keys()) {
        if (!actual.has(key)) problems.push(`${where}: missing key "${key}"`);
      }
      for (const [key, text] of actual) {
        if (language !== reference && !expected.has(key)) problems.push(`${where}: extra key "${key}"`);
        if (text === null) problems.push(`${where}: "${key}" is not a string`);
        else if (text.trim() === '') problems.push(`${where}: "${key}" is empty`);
        if (key.endsWith('_one') && !actual.has(`${key.slice(0, -'_one'.length)}_other`)) {
          problems.push(`${where}: "${key}" has no "_other" form`);
        }
        const referenceText = expected.get(key);
        if (language !== reference && text !== null && typeof referenceText === 'string') {
          const wanted = placeholdersOf(referenceText).join(',');
          const found = placeholdersOf(text).join(',');
          if (wanted !== found) problems.push(`${where}: "${key}" uses {{${found}}} but ${reference} uses {{${wanted}}}`);
        }
      }
    }
  }

  return problems;
}
