import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Configuration } from 'electron-builder';
import { releaseDirOf, stageDirOf } from '../src/main/build-dir.js';
import { APP_USER_MODEL_ID, PRODUCT_NAME } from '../src/install/constants.js';

/**
 * The two electron-builder configurations, as plain objects with every path resolved here (no `${env.X}` macros in a
 * YAML file): one for the Nanachi app (`dir` target, `release\win-unpacked\Nanachi.exe`) and one for the installer app
 * (`portable` target, one `Nanachi-Setup-<version>.exe` that carries the app as a zip in its resources).
 *
 * Both skip every native rebuild: the daemon's native modules live in the stage folder and run under the bundled
 * Node 22, and Electron never loads them, so nothing in the repository's `node_modules` is rebuilt for Electron.
 * Neither signs: SmartScreen will warn, which the maintainer accepted for now.
 */

type Fuses = NonNullable<Configuration['electronFuses']>;

/**
 * Electron fuses, flipped by electron-builder in the packaged exe (before it would sign).
 *
 * - `runAsNode` off: `ELECTRON_RUN_AS_NODE=1 Nanachi.exe script.js` would otherwise turn the installed app into a plain
 *   Node that runs any script with the app's identity. Desktop never needs it: the daemon and the CLI run under the
 *   bundled `resources\runtime\node.exe`, the uninstaller is the same app with `--uninstall`, and the sidecar is its own exe.
 * - `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` off: no `NODE_OPTIONS` or `--inspect` to
 *   inject code into the main process of an installed copy.
 * The Nanachi app (asar) also loads code only from `app.asar` and validates its header hash, so a folder named `app`
 * next to it, or a swapped archive, is not picked up. The installer app ships unpacked (no asar), so those two stay off.
 * (Tests and the smoke run use `electron .` from node_modules, which these fuses do not touch.)
 */
export const INSTALLER_FUSES: Fuses = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
};
export const APP_FUSES: Fuses = {
  ...INSTALLER_FUSES,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
};

/**
 * With `electronDist` electron-builder keeps Electron's own `resources\default_app.asar` (the "Electron" welcome app that
 * runs when no app is found). Nothing here needs it, so it is dropped from the output before the fuses are flipped.
 */
export function dropDefaultApp(appOutDir: string): void {
  rmSync(join(appOutDir, 'resources', 'default_app.asar'), { force: true });
}

/**
 * The Chromium locale packs worth shipping: one for each language of Desktop, English being the fallback. They are not only
 * for Chromium's own strings: `app.getLocale()` answers with a locale Chromium has a pack for, so without `es` and `es-419` a
 * Spanish Windows would report `en-US` and Desktop's first run (and the installer, which has no setting yet) would pick English.
 */
export const ELECTRON_LANGUAGES = ['pt-BR', 'en-US', 'es', 'es-419'];

export interface AppConfigInput {
  buildDir: string;
  /** `node_modules/electron/dist`: the unpacked Electron, so electron-builder downloads nothing. */
  electronDist: string;
  electronVersion: string;
  /** The user's artwork (PNG). electron-builder converts it for the exe; the file itself is never touched. */
  icon: string;
}

/** Fields both configurations share. */
function common(input: AppConfigInput): Configuration {
  return {
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    electronDist: input.electronDist,
    electronVersion: input.electronVersion,
    electronLanguages: ELECTRON_LANGUAGES,
    forceCodeSigning: false,
    afterPack: (context) => {
      dropDefaultApp(context.appOutDir);
    },
  };
}

export function appBuilderConfig(input: AppConfigInput): Configuration {
  const stage = stageDirOf(input.buildDir);
  return {
    ...common(input),
    appId: APP_USER_MODEL_ID,
    productName: PRODUCT_NAME,
    copyright: 'Nanachi',
    extraMetadata: { author: { name: PRODUCT_NAME } },
    directories: { output: releaseDirOf(input.buildDir) },
    // The installer app is bundled into dist/installer by `build:desktop`; it does not belong in the Nanachi app.
    files: ['dist/**/*', 'package.json', '!dist/installer/**', '!**/*.map'],
    asar: true,
    electronFuses: APP_FUSES,
    extraResources: [
      { from: join(stage, 'runtime'), to: 'runtime' },
      // electron-builder's copier always drops a `node_modules` folder at the root of a `from`, so the daemon's
      // dependencies (the biggest part of the runtime) are a separate entry whose `from` is the folder itself.
      { from: join(stage, 'runtime', 'node_modules'), to: join('runtime', 'node_modules') },
      // The Tailscale sidecar built into <build dir>\stage\bin by the packaging script.
      { from: join(stage, 'bin'), to: 'bin' },
    ],
    win: { target: [{ target: 'dir', arch: ['x64'] }], icon: input.icon },
  };
}

export interface InstallerConfigInput extends AppConfigInput {
  version: string;
  /** Generated folder with the installer's `package.json`, `main.cjs`, `preload.cjs` and `ui/`. */
  installerAppDir: string;
  /** Folder with `payload.zip` and `payload.json`. */
  payloadDir: string;
}

export function installerArtifactName(version: string): string {
  return `Nanachi-Setup-${version}.exe`;
}

export function installerBuilderConfig(input: InstallerConfigInput): Configuration {
  return {
    ...common(input),
    appId: 'org.nanachi.setup',
    productName: 'Nanachi Setup',
    copyright: 'Nanachi',
    extraMetadata: { author: { name: PRODUCT_NAME } },
    directories: { output: join(input.buildDir, 'installer-build') },
    // A handful of bundled files: no asar. The payload zip is already compressed, so the portable archive is stored
    // as is instead of being compressed a second time.
    asar: false,
    electronFuses: INSTALLER_FUSES,
    compression: 'store',
    extraResources: [{ from: input.payloadDir, to: 'payload' }],
    win: { target: [{ target: 'portable', arch: ['x64'] }], icon: input.icon },
    portable: { artifactName: installerArtifactName(input.version), requestExecutionLevel: 'user' },
  };
}

/** What the installer app's `package.json` says. `main` is the bundled entry. */
export function installerPackageJson(version: string): Record<string, unknown> {
  return {
    name: 'nanachi-setup',
    productName: 'Nanachi Setup',
    version,
    private: true,
    description: 'Nanachi installer',
    author: { name: PRODUCT_NAME },
    main: 'main.cjs',
  };
}
