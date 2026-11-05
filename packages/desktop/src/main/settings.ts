import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where the control center window was, so it opens the same way next time. */
export interface ControlWindowBounds {
  /** Position of the normal (not maximized) window; absent when it was never moved or could not be read. */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** Desktop's own settings, in `<userData>/desktop-settings.json`. The daemon's settings stay in its `config.json`. */
export interface DesktopSettings {
  /** The user turned "Tailscale embutido" on in the panel. */
  tailscaleEnabled: boolean;
  /** Absent until the control center window has been opened and moved or resized. */
  controlWindow?: ControlWindowBounds;
}

export const DEFAULT_SETTINGS: Readonly<DesktopSettings> = { tailscaleEnabled: false };

const MIN_WINDOW_SIZE = 200;
const MAX_WINDOW_SIZE = 20_000;
const MAX_WINDOW_OFFSET = 100_000;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function readBounds(value: unknown): ControlWindowBounds | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, width, height, maximized } = value as Record<string, unknown>;
  if (!inRange(width, MIN_WINDOW_SIZE, MAX_WINDOW_SIZE) || !inRange(height, MIN_WINDOW_SIZE, MAX_WINDOW_SIZE)) return undefined;
  if (typeof maximized !== 'boolean') return undefined;
  const bounds: ControlWindowBounds = { width, height, maximized };
  // The position is kept only as a pair; a half-readable one is dropped and the system centers the window.
  if (inRange(x, -MAX_WINDOW_OFFSET, MAX_WINDOW_OFFSET) && inRange(y, -MAX_WINDOW_OFFSET, MAX_WINDOW_OFFSET)) {
    return { x, y, ...bounds };
  }
  return bounds;
}

/** Reads the file; a missing, corrupt or foreign file gives the defaults, and unknown keys are dropped. */
export function loadSettings(file: string): DesktopSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
    const { tailscaleEnabled, controlWindow } = raw as Record<string, unknown>;
    const settings: DesktopSettings = { tailscaleEnabled: tailscaleEnabled === true };
    const bounds = readBounds(controlWindow);
    if (bounds !== undefined) settings.controlWindow = bounds;
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export function saveSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

export interface SettingsStore {
  get(): DesktopSettings;
  update(patch: Partial<DesktopSettings>): DesktopSettings;
}

function copyOf(settings: DesktopSettings): DesktopSettings {
  const copy: DesktopSettings = { tailscaleEnabled: settings.tailscaleEnabled };
  if (settings.controlWindow !== undefined) copy.controlWindow = { ...settings.controlWindow };
  return copy;
}

export function createSettingsStore(file: string): SettingsStore {
  let current = loadSettings(file);
  return {
    get: () => copyOf(current),
    update(patch) {
      current = { ...current, ...patch };
      saveSettings(file, current);
      return copyOf(current);
    },
  };
}
