import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Desktop's own settings, in `<userData>/desktop-settings.json`. The daemon's settings stay in its `config.json`. */
export interface DesktopSettings {
  /** The user turned "Tailscale embutido" on in the panel. */
  tailscaleEnabled: boolean;
}

export const DEFAULT_SETTINGS: Readonly<DesktopSettings> = { tailscaleEnabled: false };

/** Reads the file; a missing, corrupt or foreign file gives the defaults, and unknown keys are dropped. */
export function loadSettings(file: string): DesktopSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
    const { tailscaleEnabled } = raw as Record<string, unknown>;
    return { tailscaleEnabled: tailscaleEnabled === true };
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

export function createSettingsStore(file: string): SettingsStore {
  let current = loadSettings(file);
  return {
    get: () => ({ ...current }),
    update(patch) {
      current = { ...current, ...patch };
      saveSettings(file, current);
      return { ...current };
    },
  };
}
