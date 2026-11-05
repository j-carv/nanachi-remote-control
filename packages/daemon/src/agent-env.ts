/**
 * Environment merging for agent processes. On Windows variable names are case-insensitive, but a plain object copy
 * (`{ ...process.env }`) keeps the original spelling: `Claude_Config_Dir` and `CLAUDE_CONFIG_DIR` would then sit side by
 * side and which one the child sees is undefined. Every merge that can carry a home variable goes through here.
 */

/** A layer of variables. A key whose value is `undefined` removes that variable from every earlier layer. */
export type EnvLayer = Readonly<Record<string, string | undefined>>;

function normalize(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/**
 * Merges layers left to right: a later layer wins, spelling included, and an `undefined` value deletes the variable.
 * Case is ignored on Windows only (elsewhere `Foo` and `FOO` are different variables).
 */
export function mergeEnv(layers: readonly EnvLayer[], platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const merged = new Map<string, { key: string; value: string }>();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      const id = normalize(key, platform);
      if (value === undefined) {
        merged.delete(id);
        continue;
      }
      // Delete first so a later spelling takes the position of the later layer, not the earlier one.
      merged.delete(id);
      merged.set(id, { key, value });
    }
  }
  const result: NodeJS.ProcessEnv = {};
  for (const { key, value } of merged.values()) result[key] = value;
  return result;
}

/** `env` with `name` set to `value`, dropping any variant of the name in another case (Windows). */
export function withEnvValue(
  env: EnvLayer,
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return mergeEnv([env, { [name]: value }], platform);
}

/** `env` without `name` (any case on Windows). */
export function withoutEnv(env: EnvLayer, name: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return mergeEnv([env, { [name]: undefined }], platform);
}

/** Value of `name`, found case-insensitively on Windows. Empty string counts as absent. The last spelling wins. */
export function envValue(env: EnvLayer, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const id = normalize(name, platform);
  let found: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (normalize(key, platform) === id && value !== undefined && value !== '') found = value;
  }
  return found;
}
