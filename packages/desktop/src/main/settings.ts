import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isLanguage, languageFromLocale, type Language } from '../common/i18n/index.js';
import { isFingerprint, type PwaBuild } from './pwa-cache.js';

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
  /** The language of Desktop. Absent only before the first run has picked one from the system locale. */
  language?: Language;
  /**
   * The language Desktop last wrote into the embedded PWA's own storage (`nanachi.language`). While it equals `language` the
   * PWA keeps whatever the user chose inside it; Desktop writes again only when its own language moved.
   */
  pwaLanguage?: Language;
  /**
   * The PWA build the embedded PWA's service worker and Cache Storage were last cleared for (the daemon origin and the fingerprint
   * of its page). Absent until the first load; a different build or origin clears them again (see `pwa-cache.ts`).
   */
  pwaBuild?: PwaBuild;
}

export const DEFAULT_SETTINGS: Readonly<DesktopSettings> = { tailscaleEnabled: false };

const MIN_WINDOW_SIZE = 200;
const MAX_WINDOW_SIZE = 20_000;
const MAX_WINDOW_OFFSET = 100_000;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function readPwaBuild(value: unknown): PwaBuild | undefined {
  if (typeof value !== 'object' || value === null || !('origin' in value) || !('fingerprint' in value)) return undefined;
  const { origin, fingerprint } = value;
  if (typeof origin !== 'string' || !isFingerprint(fingerprint)) return undefined;
  return { origin, fingerprint };
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
    const { tailscaleEnabled, controlWindow, language, pwaLanguage, pwaBuild } = raw as Record<string, unknown>;
    const settings: DesktopSettings = { tailscaleEnabled: tailscaleEnabled === true };
    const bounds = readBounds(controlWindow);
    if (bounds !== undefined) settings.controlWindow = bounds;
    if (isLanguage(language)) settings.language = language;
    if (isLanguage(pwaLanguage)) settings.pwaLanguage = pwaLanguage;
    const build = readPwaBuild(pwaBuild);
    if (build !== undefined) settings.pwaBuild = build;
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Whether `file` holds Desktop's settings (a JSON object). A Desktop that ran before keeps one; a first run has none. */
export function settingsFileExists(file: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  } catch {
    return false;
  }
}

/**
 * The language Desktop starts in. A stored one wins. With none stored, a settings file that already exists means this is an
 * upgrade from a Desktop that only had Portuguese (the languages came later): it stays in Portuguese (`legacy`) instead of
 * suddenly following the system, and main marks the PWA's language as already written so the language the user may have chosen
 * inside the PWA is not replaced. With no file it is a first run, and the language of the system is taken.
 */
export function resolveStartupLanguage(input: {
  stored: Language | undefined;
  hadSettingsFile: boolean;
  locale: string | null | undefined;
}): { language: Language; legacy: boolean } {
  if (input.stored !== undefined) return { language: input.stored, legacy: false };
  if (input.hadSettingsFile) return { language: 'pt-BR', legacy: true };
  return { language: languageFromLocale(input.locale), legacy: false };
}

/**
 * The language of the installer and of the uninstaller, read from Desktop's settings file without changing it: the one
 * Desktop is set to (Portuguese for an upgrade that never chose, as Desktop itself will start), the system's when there is no
 * Desktop settings file yet.
 */
export function languageForSettingsFile(file: string, locale: string | null | undefined): Language {
  return resolveStartupLanguage({ stored: loadSettings(file).language, hadSettingsFile: settingsFileExists(file), locale }).language;
}

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export function saveSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * The language to hand the embedded PWA at this load, or null. Desktop writes `nanachi.language` into the PWA's storage on the
 * first load and after Desktop's own language changed (`written` is what it wrote last); while they agree the PWA keeps whatever
 * the user chose inside it.
 */
export function pendingPwaLanguage(language: Language, written: Language | undefined): Language | null {
  return written === language ? null : language;
}

export interface SettingsStore {
  get(): DesktopSettings;
  update(patch: Partial<DesktopSettings>): DesktopSettings;
}

function copyOf(settings: DesktopSettings): DesktopSettings {
  const copy: DesktopSettings = { tailscaleEnabled: settings.tailscaleEnabled };
  if (settings.controlWindow !== undefined) copy.controlWindow = { ...settings.controlWindow };
  if (settings.language !== undefined) copy.language = settings.language;
  if (settings.pwaLanguage !== undefined) copy.pwaLanguage = settings.pwaLanguage;
  if (settings.pwaBuild !== undefined) copy.pwaBuild = { ...settings.pwaBuild };
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
