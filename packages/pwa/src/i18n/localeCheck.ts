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

/** The plural categories of CLDR, which i18next turns into key suffixes (`count_one`, `count_many`, ...). */
const PLURAL_CATEGORIES: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** Plural categories a language uses for some counts, according to `Intl.PluralRules` (Spanish has `many` for 1000000). */
export function pluralCategoriesOf(language: string): readonly string[] {
  try {
    return new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  } catch {
    return ['one', 'other'];
  }
}

/** The base and the category of a plural key (`count_many` gives `count` and `many`), or null for any other key. */
function pluralParts(key: string): { base: string; category: string } | null {
  const cut = key.lastIndexOf('_');
  if (cut <= 0) return null;
  const category = key.slice(cut + 1);
  return PLURAL_CATEGORIES.includes(category) ? { base: key.slice(0, cut), category } : null;
}

/**
 * The reference key that an extra plural form is measured against: `count_many` follows `count_other`. Null when the
 * key is not a plural form of a text the reference writes as plural.
 */
function extraPluralReference(key: string, expected: ReadonlyMap<string, string | null>): string | null {
  const parts = pluralParts(key);
  if (parts === null) return null;
  const other = `${parts.base}_other`;
  return expected.has(other) ? other : null;
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
 *
 * Plural forms follow the language. The reference decides which texts are plural (it has `count_other`), and another
 * language may add the forms its own rules need next to them (Spanish `count_many`) without counting as an extra key,
 * and must have every form `categoriesOf` reports for it: a count that picks a missing form finds no text, and the
 * screen shows the bare key. The reference is not checked for this, because the other files are measured against it.
 */
export function compareLocales(
  files: LocaleFiles,
  reference: string,
  namespaces: readonly string[],
  categoriesOf: (language: string) => readonly string[] = pluralCategoriesOf,
): string[] {
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
        const measuredAgainst = expected.has(key) ? key : extraPluralReference(key, expected);
        if (language !== reference && measuredAgainst === null) problems.push(`${where}: extra key "${key}"`);
        if (text === null) problems.push(`${where}: "${key}" is not a string`);
        else if (text.trim() === '') problems.push(`${where}: "${key}" is empty`);
        if (key.endsWith('_one') && !actual.has(`${key.slice(0, -'_one'.length)}_other`)) {
          problems.push(`${where}: "${key}" has no "_other" form`);
        }
        if (language !== reference && key.endsWith('_other')) {
          const base = key.slice(0, -'_other'.length);
          for (const category of categoriesOf(language)) {
            if (!actual.has(`${base}_${category}`)) {
              problems.push(`${where}: "${base}" has no "_${category}" form, which ${language} uses for some counts`);
            }
          }
        }
        const referenceText = measuredAgainst === null ? undefined : expected.get(measuredAgainst);
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
