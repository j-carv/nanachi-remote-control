import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const CONFIG = fileURLToPath(new URL('../vite.control.config.ts', import.meta.url));

/** Builds the renderer in memory (nothing is written) and returns every emitted chunk and asset as text. */
async function bundleText(mock: boolean): Promise<string> {
  const before = process.env.NANACHI_CONTROL_MOCK;
  if (mock) process.env.NANACHI_CONTROL_MOCK = '1';
  else delete process.env.NANACHI_CONTROL_MOCK;
  try {
    const result = await build({ configFile: CONFIG, logLevel: 'silent', build: { write: false } });
    const outputs = Array.isArray(result) ? result : [result];
    let text = '';
    for (const output of outputs) {
      if (!('output' in output)) continue;
      for (const file of output.output) {
        text += file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : '';
      }
    }
    return text;
  } finally {
    if (before === undefined) delete process.env.NANACHI_CONTROL_MOCK;
    else process.env.NANACHI_CONTROL_MOCK = before;
  }
}

describe('control center page', () => {
  /** The directives of the CSP the page itself carries (`loadFile` has no response headers to put it in). */
  function policy(): Map<string, string> {
    const html = readFileSync(new URL('../src/control/index.html', import.meta.url), 'utf8');
    const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    if (content === undefined) throw new Error('o index.html não tem Content-Security-Policy');
    return new Map(
      content
        .split(';')
        .map((directive) => directive.trim())
        .filter((directive) => directive !== '')
        .map((directive) => {
          const [name = '', ...values] = directive.split(/\s+/);
          return [name, values.join(' ')];
        }),
    );
  }

  it('the CSP lets the page load only its own files, and closes the doors the fetch directives leave open', () => {
    const csp = policy();
    expect(csp.get('default-src')).toBe("'self'");
    expect(csp.get('script-src')).toBe("'self'");
    expect(csp.get('connect-src')).toBe("'none'");
    // `default-src` does not cover these three: without them a <base>, a <form> or a plug-in could redirect the page.
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('form-action')).toBe("'none'");
    expect(csp.get('object-src')).toBe("'none'");
  });

  it('no inline script, no eval and no remote origin is allowed anywhere in the policy', () => {
    const everything = [...policy().values()].join(' ');
    expect(everything).not.toContain('unsafe-eval');
    expect(everything).not.toContain('http');
    expect(policy().get('script-src')).not.toContain('unsafe-inline');
  });
});

describe('control center bundle', () => {
  it('the shipped build has no mock data: a page without the bridge says so instead', async () => {
    const text = await bundleText(false);
    expect(text).toContain('Abra pelo Nanachi Desktop');
    expect(text).not.toContain('iPad antigo');
    expect(text).not.toContain('PENDRIVE');
    expect(text).not.toContain('tail4e2f1');
  }, 90_000);

  it('the mock build (screenshots and development) does carry it, which proves the check above can fail', async () => {
    const text = await bundleText(true);
    expect(text).toContain('iPad antigo');
  }, 90_000);
});
