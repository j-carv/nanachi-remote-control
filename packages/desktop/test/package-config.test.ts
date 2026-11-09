import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeTree } from '../src/install/safe-remove.js';
import {
  appBuilderConfig,
  dropDefaultApp,
  ELECTRON_LANGUAGES,
  installerArtifactName,
  installerBuilderConfig,
  installerPackageJson,
} from '../scripts/builder-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD = 'C:\\Users\\ana\\AppData\\Local\\nanachi-desktop-build';
const input = {
  buildDir: BUILD,
  electronDist: 'C:\\repo\\node_modules\\electron\\dist',
  electronVersion: '45.2.3',
  icon: 'C:\\repo\\packages\\pwa\\public\\icon-512.png',
};

describe('app electron-builder config', () => {
  const config = appBuilderConfig(input);

  it('builds the unpacked Nanachi app into <build dir>\\release', () => {
    expect(config.appId).toBe('org.nanachi.desktop');
    expect(config.productName).toBe('Nanachi');
    expect(config.directories?.output).toBe(join(BUILD, 'release'));
    expect(config.win?.target).toEqual([{ target: 'dir', arch: ['x64'] }]);
    expect(config.win?.icon).toBe(input.icon);
  });

  it('ships the staged runtime and the sidecar as extra resources, from explicit absolute paths', () => {
    expect(config.extraResources).toEqual([
      { from: join(BUILD, 'stage', 'runtime'), to: 'runtime' },
      // electron-builder never copies a root-level node_modules, so the daemon's dependencies get their own entry.
      { from: join(BUILD, 'stage', 'runtime', 'node_modules'), to: join('runtime', 'node_modules') },
      { from: join(BUILD, 'stage', 'bin'), to: 'bin' },
    ]);
  });

  it('never rebuilds native modules for Electron and never signs', () => {
    expect(config.npmRebuild).toBe(false);
    expect(config.nodeGypRebuild).toBe(false);
    expect(config.buildDependenciesFromSource).toBe(false);
    expect(config.forceCodeSigning).toBe(false);
  });

  it('uses the Electron already installed, so nothing is downloaded', () => {
    expect(config.electronDist).toBe(input.electronDist);
    expect(config.electronVersion).toBe('45.2.3');
    expect(config.electronLanguages).toEqual(ELECTRON_LANGUAGES);
  });

  it('ships a Chromium locale pack for every language of Desktop, so app.getLocale() can answer es-419, pt-BR and en-US', () => {
    // `app.getLocale()` only answers with a locale Chromium has a pack for: without `es` the first run of Desktop and the
    // installer on a Spanish Windows would see `en-US` and pick English.
    for (const pack of ['pt-BR', 'en-US', 'es', 'es-419']) expect(ELECTRON_LANGUAGES).toContain(pack);
  });

  it('names Nanachi as the publisher (the exe metadata would otherwise keep the Electron one)', () => {
    expect(config.extraMetadata).toEqual({ author: { name: 'Nanachi' } });
  });

  it('leaves the installer app out of the Nanachi app', () => {
    expect(config.files).toContain('dist/**/*');
    expect(config.files).toContain('!dist/installer/**');
  });

  it('has no ${env.X}-style macros: every path is resolved here', () => {
    expect(JSON.stringify(config)).not.toContain('${');
  });
});

describe('installer electron-builder config', () => {
  const config = installerBuilderConfig({
    ...input,
    version: '1.4.0',
    installerAppDir: join(BUILD, 'installer-app'),
    payloadDir: join(BUILD, 'installer-payload'),
  });

  it('makes one portable exe named Nanachi-Setup-<version>.exe, per user', () => {
    expect(config.win?.target).toEqual([{ target: 'portable', arch: ['x64'] }]);
    expect(config.portable?.artifactName).toBe('Nanachi-Setup-1.4.0.exe');
    expect(installerArtifactName('1.4.0')).toBe('Nanachi-Setup-1.4.0.exe');
    expect(config.portable?.requestExecutionLevel).toBe('user');
    expect(config.directories?.output).toBe(join(BUILD, 'installer-build'));
  });

  it("carries the payload folder in its resources and compresses the installer's own Electron app", () => {
    expect(config.extraResources).toEqual([{ from: join(BUILD, 'installer-payload'), to: 'payload' }]);
    expect(config.compression).toBe('normal');
    expect(config.asar).toBe(false);
  });

  it('is its own app, with the same no-rebuild, no-signing rules', () => {
    expect(config.appId).toBe('org.nanachi.setup');
    expect(config.productName).toBe('Nanachi Setup');
    expect(config.npmRebuild).toBe(false);
    expect(config.forceCodeSigning).toBe(false);
    expect(JSON.stringify(config)).not.toContain('${');
  });

  it('gets a package.json whose main is the bundled entry', () => {
    expect(installerPackageJson('1.4.0')).toMatchObject({ name: 'nanachi-setup', version: '1.4.0', main: 'main.cjs' });
  });
});

describe('Electron fuses', () => {
  const app = appBuilderConfig(input);
  const installer = installerBuilderConfig({
    ...input,
    version: '1.4.0',
    installerAppDir: join(BUILD, 'installer-app'),
    payloadDir: join(BUILD, 'installer-payload'),
  });

  it('turns RunAsNode, NODE_OPTIONS and --inspect off in both packaged apps', () => {
    for (const config of [app, installer]) {
      expect(config.electronFuses).toMatchObject({
        runAsNode: false,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
      });
    }
  });

  it('makes the Nanachi app load only a validated app.asar', () => {
    expect(app.asar).toBe(true);
    expect(app.electronFuses).toMatchObject({ onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true });
  });

  it('leaves the asar fuses off for the installer app, which ships unpacked (they would stop it from starting)', () => {
    expect(installer.asar).toBe(false);
    expect(installer.electronFuses?.onlyLoadAppFromAsar).toBeUndefined();
    expect(installer.electronFuses?.enableEmbeddedAsarIntegrityValidation).toBeUndefined();
  });

  it('does not touch the cookie store encryption (a one-way switch nobody asked for)', () => {
    expect(app.electronFuses?.enableCookieEncryption).toBeUndefined();
    expect(installer.electronFuses?.enableCookieEncryption).toBeUndefined();
  });

  it('Desktop never needs RunAsNode: nothing in the app or the installer runs Electron as Node', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(join(here, '..', 'src'));
    walk(join(here, '..', 'installer'));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('ELECTRON_RUN_AS_NODE');
      expect(text, file).not.toMatch(/utilityProcess|\bfork\(/);
    }
  });
});

describe('dropDefaultApp', () => {
  it('removes resources/default_app.asar from the unpacked app and is fine when it is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanachi-default-app-'));
    try {
      mkdirSync(join(dir, 'resources'), { recursive: true });
      writeFileSync(join(dir, 'resources', 'default_app.asar'), 'electron welcome app');
      writeFileSync(join(dir, 'resources', 'app.asar'), 'ours');
      dropDefaultApp(dir);
      expect(existsSync(join(dir, 'resources', 'default_app.asar'))).toBe(false);
      expect(readFileSync(join(dir, 'resources', 'app.asar'), 'utf8')).toBe('ours');
      expect(() => dropDefaultApp(dir)).not.toThrow();
    } finally {
      removeTree(dir, nodeFs);
    }
  });

  it('runs as the afterPack hook of both configurations', () => {
    for (const config of [appBuilderConfig(input), installerBuilderConfig({ ...input, version: '1', installerAppDir: BUILD, payloadDir: BUILD })]) {
      expect(typeof config.afterPack).toBe('function');
    }
  });
});
