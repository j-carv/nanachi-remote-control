import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function scriptsOf(path: string): Record<string, string> {
  const raw: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const scripts = (raw as { scripts?: unknown }).scripts;
  return typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, string>) : {};
}

/**
 * The supervisor runs the root `npm run build`, which is `npm run build --workspaces --if-present`: any workspace
 * that has a `build` script is built on every restart. Desktop must never be one of them, so a broken Desktop build
 * cannot stop the live supervisor.
 */
describe('desktop package scripts', () => {
  const scripts = scriptsOf('../package.json');

  it('has no `build` script, so the root build skips it', () => {
    expect(scripts).not.toHaveProperty('build');
    expect(scripts).not.toHaveProperty('prebuild');
    expect(scripts).not.toHaveProperty('postbuild');
  });

  it('builds with `build:desktop`, and dev uses it', () => {
    expect(scripts['build:desktop']).toContain('tsc -p tsconfig.build.json');
    expect(scripts.dev).toContain('npm run build:desktop');
    expect(scripts.dev).not.toMatch(/npm run build(?!:)/);
  });

  it('keeps typecheck and test, which the root scripts run through --workspaces', () => {
    expect(scripts.typecheck).toBeDefined();
    expect(scripts.test).toBeDefined();
    const root = scriptsOf('../../../package.json');
    expect(root.typecheck).toContain('--workspaces');
    expect(root.test).toContain('--workspaces');
    expect(root.build).toContain('--if-present');
  });
});
