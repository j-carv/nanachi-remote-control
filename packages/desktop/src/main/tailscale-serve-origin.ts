import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tailscaleHttpsOrigin } from '../common/pairing-link.js';

const run = promisify(execFile);

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Accept only a private HTTPS root that Tailscale already routes to this daemon. */
export function serveOrigin(stdout: string, daemonPort: number): string | null {
  try {
    const config = record(JSON.parse(stdout));
    const web = record(config?.Web);
    if (web === undefined || record(record(config?.TCP)?.['443'])?.HTTPS !== true) return null;

    const origins = [];
    for (const [hostPort, value] of Object.entries(web)) {
      if (!hostPort.endsWith(':443') || record(config?.AllowFunnel)?.[hostPort] === true) continue;
      const proxy = record(record(record(value)?.Handlers)?.['/'])?.Proxy;
      if (typeof proxy !== 'string') continue;
      const target = proxy.replace(/\/$/, '');
      if (target !== `http://127.0.0.1:${daemonPort}` && target !== `http://localhost:${daemonPort}`) continue;
      const origin = tailscaleHttpsOrigin(hostPort.slice(0, -4));
      if (origin !== null) origins.push(origin);
    }
    return origins.length === 1 ? origins[0] ?? null : null;
  } catch {
    return null;
  }
}

export async function externalPhoneOrigin(daemonPort: number): Promise<string | null> {
  const programFiles = process.env.ProgramFiles;
  if (programFiles === undefined) return null;
  try {
    const cli = join(programFiles, 'Tailscale', 'tailscale.exe');
    const { stdout } = await run(cli, ['serve', 'status', '--json'], {
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 256 * 1024,
    });
    return serveOrigin(stdout, daemonPort);
  } catch {
    return null;
  }
}
