import type { ControlApi } from '../../common/control-api.js';
import { createMockControlApi, type MockScenario } from './mock-api.js';

const SCENARIOS: readonly MockScenario[] = ['default', 'empty', 'readonly', 'busy', 'pending', 'down', 'attached', 'login', 'update'];

/**
 * `?mock=1[&scenario=empty][&latency=0]`: installs the in-memory API as `window.nanachiControl`. Only reachable from a
 * mock build (`__CONTROL_MOCK__`); returns null when the flag is absent.
 */
export function installMockApi(search: string): ControlApi | null {
  const params = new URLSearchParams(search);
  if (params.get('mock') !== '1') return null;
  const requested = params.get('scenario');
  const scenario = SCENARIOS.find((candidate) => candidate === requested) ?? 'default';
  const latency = Number(params.get('latency') ?? '120');
  const api = createMockControlApi({ scenario, latencyMs: Number.isFinite(latency) ? latency : 120 });
  window.nanachiControl = api;
  return api;
}
