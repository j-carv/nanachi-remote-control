import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cspContent = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];

/** Diretivas da CSP como mapa: nome → lista de fontes. */
function directives(policy: string | undefined): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const part of (policy ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name.length > 0) map[name] = sources;
  }
  return map;
}

describe('index.html: Content-Security-Policy', () => {
  it('existe como meta http-equiv', () => {
    expect(cspContent).toBeDefined();
  });

  it('scripts e workers só do próprio origin; sem eval nem inline', () => {
    const policy = directives(cspContent);
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['worker-src']).toEqual(["'self'"]);
    expect(policy['default-src']).toEqual(["'self'"]);
    expect(cspContent).not.toContain('unsafe-eval');
  });

  it('imagens remotas bloqueadas: img-src só self, data e blob', () => {
    expect(directives(cspContent)['img-src']).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('conexões: https/wss para os daemons em tailscale, e ws/http só para loopback', () => {
    expect(directives(cspContent)['connect-src']).toEqual([
      "'self'",
      'https:',
      'wss:',
      'ws://127.0.0.1:*',
      'ws://localhost:*',
      'http://127.0.0.1:*',
      'http://localhost:*',
    ]);
  });

  it('estilos inline liberados (React usa style={...}); manifest do próprio origin', () => {
    const policy = directives(cspContent);
    expect(policy['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy['manifest-src']).toEqual(["'self'"]);
  });
});
