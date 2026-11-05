import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyHealthResponse, fetchHealth, parseHealth, runProcess } from '../src/main/system.js';

const GOOD = { ok: true, machineId: 'm-1', machineName: 'PC', version: '0.0.0' };

describe('parseHealth', () => {
  it('accepts the daemon answer', () => {
    expect(parseHealth(GOOD)).toEqual({ machineId: 'm-1', machineName: 'PC', version: '0.0.0' });
  });

  it.each([
    ['not an object', 'ok'],
    ['null', null],
    ['ok false', { ...GOOD, ok: false }],
    ['no ok', { machineId: 'm', machineName: 'n', version: '1' }],
    ['empty machine id', { ...GOOD, machineId: '' }],
    ['numeric version', { ...GOOD, version: 1 }],
    ['missing name', { ok: true, machineId: 'm', version: '1' }],
  ])('rejects %s', (_label, value) => {
    expect(parseHealth(value)).toBeNull();
  });
});

describe('classifyHealthResponse', () => {
  it('only a 403 with the daemon\'s own forbidden body is "restricted"', () => {
    expect(classifyHealthResponse(403, { error: 'forbidden' })).toEqual({ kind: 'restricted' });
    expect(classifyHealthResponse(403, { error: 'bad_host' })).toEqual({ kind: 'none' });
    expect(classifyHealthResponse(403, 'Forbidden')).toEqual({ kind: 'none' });
    expect(classifyHealthResponse(403, null)).toEqual({ kind: 'none' });
    expect(classifyHealthResponse(401, { error: 'forbidden' })).toEqual({ kind: 'none' });
    expect(classifyHealthResponse(200, { error: 'forbidden' })).toEqual({ kind: 'none' });
    expect(classifyHealthResponse(200, GOOD)).toEqual({ kind: 'ok', info: { machineId: 'm-1', machineName: 'PC', version: '0.0.0' } });
  });
});

describe('fetchHealth', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('reads a Nanachi daemon from /api/health', async () => {
    const port = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify(GOOD) : '{}');
    });
    expect(await fetchHealth(port)).toEqual({
      kind: 'ok',
      info: { machineId: 'm-1', machineName: 'PC', version: '0.0.0' },
    });
  });

  it('recognises a daemon that refuses local calls (allowedTailscaleLogins): 403 {"error":"forbidden"}', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"forbidden"}');
    });
    expect(await fetchHealth(port)).toEqual({ kind: 'restricted' });
  });

  it('is null for a server that is not a Nanachi daemon', async () => {
    const port = await listen((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>hello</html>');
    });
    expect(await fetchHealth(port)).toEqual({ kind: 'none' });
  });

  it('is none for an error status', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 500;
      res.end(JSON.stringify(GOOD));
    });
    expect(await fetchHealth(port)).toEqual({ kind: 'none' });
  });

  it('is null when nothing listens on the port', async () => {
    const port = await listen((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await fetchHealth(port)).toEqual({ kind: 'none' });
  });

  it('is null when the server never answers within the timeout', async () => {
    const port = await listen(() => {
      // Never respond.
    });
    expect(await fetchHealth(port, { timeoutMs: 150 })).toEqual({ kind: 'none' });
    server?.closeAllConnections();
  });
});

describe('runProcess', () => {
  const options = { cwd: process.cwd(), env: process.env };

  it('collects stdout, stderr and the exit code', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "console.log('out'); console.error('err'); process.exit(3)"],
      options,
      10_000,
    );
    expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills a process that runs past the timeout', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, 300);
    expect(result.timedOut).toBe(true);
  });

  it('rejects when the command does not exist', async () => {
    await expect(runProcess('definitely-not-a-command-nanachi', [], options, 5_000)).rejects.toThrow();
  });
});
