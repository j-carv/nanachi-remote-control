/**
 * Command-line flags of the installer and of `Nanachi.exe --uninstall`. They exist so verification can run both
 * against a temp folder without touching the real Start Menu, registry, login items or `%LOCALAPPDATA%\Programs`.
 */
export interface InstallFlags {
  /** `--target <dir>`: install into / uninstall from this folder instead of the default. */
  target: string | null;
  /** `--no-shortcuts`: do not create or remove Start Menu and desktop shortcuts. */
  noShortcuts: boolean;
  /** `--no-registry`: do not touch the uninstall key or the login item. */
  noRegistry: boolean;
  /** `--no-launch`: installer only; do not start Nanachi at the end. */
  noLaunch: boolean;
  /** `--yes`: run without waiting for a click (and without asking before closing a running Nanachi). */
  yes: boolean;
  /** `--delete-data`: uninstaller only; the same as ticking "Apagar também os dados do Nanachi". */
  deleteData: boolean;
}

/** Reads the flags out of `process.argv`; Electron's own switches and unknown arguments are ignored. */
export function parseInstallFlags(argv: readonly string[]): InstallFlags {
  const flags: InstallFlags = {
    target: null,
    noShortcuts: false,
    noRegistry: false,
    noLaunch: false,
    yes: false,
    deleteData: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--target') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error('--target precisa de uma pasta');
      flags.target = value;
      index += 1;
    } else if (arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length);
      if (value === '') throw new Error('--target precisa de uma pasta');
      flags.target = value;
    } else if (arg === '--no-shortcuts') flags.noShortcuts = true;
    else if (arg === '--no-registry') flags.noRegistry = true;
    else if (arg === '--no-launch') flags.noLaunch = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--delete-data') flags.deleteData = true;
  }
  return flags;
}
