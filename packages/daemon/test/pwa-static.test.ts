import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();

const RELEASE_A = '20261104T154746123Z-aaaaaa';
const RELEASE_B = '20261104T160000000Z-bbbbbb';

/** Um "build" falso: index.html, sw.js e um asset, todos com o rótulo no conteúdo. */
async function writeSite(dir: string, label: string): Promise<void> {
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), `<!doctype html><title>${label}</title>`);
  await writeFile(join(dir, 'sw.js'), `// ${label}`);
  await writeFile(join(dir, 'assets', 'app.js'), `console.log('${label}');`);
}

function pointerFile(): string {
  return join(env.home, 'releases', 'current.json');
}

/**
 * Grava o ponteiro (ou o remove, com `release` undefined). O mtime é forçado: o daemon só relê quando o
 * ponteiro muda de mtime, tamanho ou inode, e dois writes no mesmo milissegundo não podem empatar.
 */
async function point(release: string | undefined, seconds: number): Promise<void> {
  const file = pointerFile();
  await mkdir(join(file, '..'), { recursive: true });
  if (release === undefined) {
    await rm(file, { force: true });
    return;
  }
  await writeFile(file, JSON.stringify({ release }));
  const when = new Date(seconds * 1000);
  await utimes(file, when, when);
}

async function get(daemon: TestDaemon, url: string): Promise<{ status: number; body: string; cache: string | undefined }> {
  const res = await daemon.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.body, cache: res.headers['cache-control'] as string | undefined };
}

describe('PWA estático: fallback para pwa/ e raiz pelo ponteiro das releases', () => {
  it('sem ponteiro serve a pasta pwa (dist) com os mesmos cabeçalhos de antes', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    const daemon = await env.start();

    const index = await get(daemon, '/');
    expect(index).toMatchObject({ status: 200, cache: 'public, max-age=0' });
    expect(index.body).toContain('<title>dist</title>');

    const sw = await get(daemon, '/sw.js');
    expect(sw).toMatchObject({ status: 200, body: '// dist', cache: 'public, max-age=0' });

    const asset = await get(daemon, '/assets/app.js');
    expect(asset).toMatchObject({ status: 200, body: "console.log('dist');" });

    const spa = await get(daemon, '/maquinas/abc');
    expect(spa).toMatchObject({ status: 200, cache: 'no-cache' });
    expect(spa.body).toContain('<title>dist</title>');
  });

  it('com ponteiro, serve a release apontada (index, sw e assets da mesma pasta) e troca sem reiniciar', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    await writeSite(join(env.home, 'releases', RELEASE_A), RELEASE_A);
    await writeSite(join(env.home, 'releases', RELEASE_B), RELEASE_B);
    const daemon = await env.start();

    await point(RELEASE_A, 1_000);
    expect((await get(daemon, '/')).body).toContain(`<title>${RELEASE_A}</title>`);
    expect((await get(daemon, '/sw.js')).body).toBe(`// ${RELEASE_A}`);
    expect((await get(daemon, '/assets/app.js')).body).toBe(`console.log('${RELEASE_A}');`);

    await point(RELEASE_B, 2_000);
    expect((await get(daemon, '/')).body).toContain(`<title>${RELEASE_B}</title>`);
    expect((await get(daemon, '/sw.js')).body).toBe(`// ${RELEASE_B}`);
  });

  it('ponteiro removido volta a servir a pasta pwa', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    await writeSite(join(env.home, 'releases', RELEASE_A), RELEASE_A);
    const daemon = await env.start();

    await point(RELEASE_A, 1_000);
    expect((await get(daemon, '/')).body).toContain(`<title>${RELEASE_A}</title>`);

    await point(undefined, 2_000);
    expect((await get(daemon, '/')).body).toContain('<title>dist</title>');
  });

  it('ponteiro para release sem index.html mantém a última release boa no ar', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    await writeSite(join(env.home, 'releases', RELEASE_A), RELEASE_A);
    // RELEASE_B nunca é criada: o ponteiro aponta para uma pasta que não existe.
    const daemon = await env.start();

    await point(RELEASE_A, 1_000);
    expect((await get(daemon, '/')).body).toContain(`<title>${RELEASE_A}</title>`);

    await point(RELEASE_B, 2_000);
    expect((await get(daemon, '/')).body).toContain(`<title>${RELEASE_A}</title>`);
  });

  it('release cujo index.html referencia um CSS ausente não é servida: a última boa continua no ar', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    await writeSite(join(env.home, 'releases', RELEASE_A), RELEASE_A);
    const broken = join(env.home, 'releases', RELEASE_B);
    await writeSite(broken, RELEASE_B);
    await writeFile(join(broken, 'index.html'), `<!doctype html><link rel="stylesheet" href="/assets/index-gone.css"><title>${RELEASE_B}</title>`);
    const daemon = await env.start();

    await point(RELEASE_A, 1_000);
    expect((await get(daemon, '/')).body).toContain(`<title>${RELEASE_A}</title>`);

    await point(RELEASE_B, 2_000);
    const index = await get(daemon, '/');
    expect(index).toMatchObject({ status: 200, cache: 'public, max-age=0' });
    expect(index.body).toContain(`<title>${RELEASE_A}</title>`);
    expect(index.body).not.toContain(RELEASE_B);
  });

  it('ponteiro com caminho fora de releases/ é ignorado e serve a pasta pwa', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    await writeSite(join(env.home, 'escondida'), 'escondida');
    const daemon = await env.start();

    await point('../escondida', 1_000);

    expect((await get(daemon, '/')).body).toContain('<title>dist</title>');
  });

  it('caminho codificado que sai da raiz (%2e%2e) não lê arquivo fora dela: cai no index.html', async () => {
    await writeSite(join(env.home, 'pwa'), 'dist');
    await writeFile(join(env.home, 'segredo.txt'), 'segredo fora da raiz');
    const daemon = await env.start();

    const res = await get(daemon, '/%2e%2e/segredo.txt');

    expect(res.body).not.toContain('segredo fora da raiz');
    expect(res.body).toContain('<title>dist</title>');
  });

  it('sem pasta pwa e sem ponteiro responde o aviso de PWA não compilada', async () => {
    const daemon = await env.start();

    expect(await get(daemon, '/')).toMatchObject({ status: 404 });
    expect((await get(daemon, '/')).body).toMatch(/PWA/);
  });
});
