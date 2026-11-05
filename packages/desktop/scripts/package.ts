import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';
import { removeTreeOrThrow } from '../src/install/safe-remove.js';
import { BUILD_DIR_ENV, releaseDirOf } from '../src/main/build-dir.js';
import { APP_FUSES, appBuilderConfig, INSTALLER_FUSES, installerArtifactName, installerBuilderConfig, installerPackageJson } from './builder-config.js';
import { assertNoDefaultApp, verifyFuses } from './fuses.js';
import { createPayload } from './payload-zip.js';
import { assertNode22, copyTree, directorySize, findNpmCli, stage, stagePaths, type StagePaths } from './stage.js';
import { fingerprintStageInputs, isStageFresh, writeStageStamp } from './stage-stamp.js';

/**
 * `npm run package -w @nanachi/desktop [-- --fresh] [-- --skip-installer]`
 *
 *   1. stage      <build dir>\stage\runtime   (skipped when it matches the repository's build outputs; `--fresh` forces it)
 *   2. compile    `build:desktop`: tsc, the preload, the installer and uninstall windows (esbuild)
 *   3. sidecar    `go build` of tsnet/ into <build dir>\stage\bin\nanachi-tsnet.exe
 *   4. app        electron-builder `dir` target -> <build dir>\release\win-unpacked\Nanachi.exe
 *   5. payload    win-unpacked as <build dir>\installer-payload\payload.zip (yazl) + payload.json
 *   6. installer  electron-builder `portable` target -> <build dir>\release\Nanachi-Setup-<version>.exe
 *
 * Everything is written under the build dir (`%LOCALAPPDATA%\nanachi-desktop-build`, or NANACHI_DESKTOP_BUILD_DIR),
 * never inside the repository. It compiles nothing the supervisor owns (no root `npm run build`): the daemon, shared
 * and PWA builds come from the supervisor's own watch build.
 */

const log = (line: string): void => console.log(`package: ${line}`);

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  const result = spawnSync(command, args, { cwd: options.cwd, stdio: 'inherit', env: options.env ?? process.env });
  if (result.error !== undefined) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} falhou (código ${result.status ?? 'sem código'})`);
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function readVersion(desktopDir: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
  const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version === '') throw new Error('package.json do desktop sem version');
  return version;
}

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) throw new Error(`faltou ${what}: ${path}`);
}

function electronInfo(desktopDir: string): { dist: string; version: string } {
  const require = createRequire(join(desktopDir, 'package.json'));
  const packageJson = require.resolve('electron/package.json');
  const version = (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
  const dist = join(dirname(packageJson), 'dist');
  requireFile(join(dist, 'electron.exe'), 'o Electron desempacotado (node_modules/electron/dist)');
  return { dist, version };
}

function stageStep(paths: StagePaths, fresh: boolean): void {
  const fingerprint = fingerprintStageInputs(paths);
  if (!fresh && isStageFresh(paths, fingerprint)) {
    log(`stage em dia (${paths.runtimeDir}); use --fresh para refazer`);
    return;
  }
  log(fresh ? 'stage: refazendo (--fresh)' : 'stage: ausente ou desatualizado, refazendo');
  stage(paths);
  writeStageStamp(paths.stageDir, fingerprint);
}

function compileStep(paths: StagePaths, npmCli: string): void {
  log('compilando (build:desktop)');
  run(process.execPath, [npmCli, 'run', 'build:desktop'], {
    cwd: paths.desktopDir,
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
  });
  requireFile(join(paths.desktopDir, 'dist', 'main', 'index.js'), 'o build do app (dist/main/index.js)');
  requireFile(join(paths.desktopDir, 'dist', 'installer', 'main.cjs'), 'o build do instalador (dist/installer/main.cjs)');
  requireFile(join(paths.desktopDir, 'dist', 'ui', 'uninstall.html'), 'a janela de desinstalação (dist/ui/uninstall.html)');
}

function sidecarStep(paths: StagePaths): string {
  const out = join(paths.stageDir, 'bin', 'nanachi-tsnet.exe');
  mkdirSync(dirname(out), { recursive: true });
  log(`go build do sidecar -> ${out}`);
  run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'], {
    cwd: join(paths.desktopDir, 'tsnet'),
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' },
  });
  return out;
}

async function appStep(paths: StagePaths, icon: string): Promise<string> {
  const electron = electronInfo(paths.desktopDir);
  const config = appBuilderConfig({ buildDir: paths.buildDir, electronDist: electron.dist, electronVersion: electron.version, icon });
  log(`electron-builder (dir) -> ${releaseDirOf(paths.buildDir)}`);
  await build({
    targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
    projectDir: paths.desktopDir,
    config,
    publish: 'never',
  });
  const unpacked = join(releaseDirOf(paths.buildDir), 'win-unpacked');
  requireFile(join(unpacked, 'Nanachi.exe'), 'Nanachi.exe');
  // What shipped is what was asked for: the fuses are read back from the exe, and Electron's default app is gone.
  verifyFuses(join(unpacked, 'Nanachi.exe'), APP_FUSES);
  assertNoDefaultApp(unpacked);
  log('fuses do app conferidos (RunAsNode e --inspect desligados, só carrega app.asar)');
  requireFile(join(unpacked, 'resources', 'app.asar'), 'resources/app.asar');
  requireFile(join(unpacked, 'resources', 'runtime', 'node.exe'), 'resources/runtime/node.exe');
  requireFile(join(unpacked, 'resources', 'runtime', 'packages', 'daemon', 'dist', 'main.js'), 'o daemon em resources/runtime');
  requireFile(join(unpacked, 'resources', 'bin', 'nanachi-tsnet.exe'), 'resources/bin/nanachi-tsnet.exe');
  // The runtime must arrive whole (electron-builder silently skips what its filters reject): same bytes as the stage.
  const staged = directorySize(join(paths.stageDir, 'runtime'));
  const packaged = directorySize(join(unpacked, 'resources', 'runtime'));
  if (staged !== packaged) {
    throw new Error(`o runtime empacotado (${mib(packaged)}) difere do stage (${mib(staged)}): electron-builder deixou arquivos de fora`);
  }
  return unpacked;
}

async function installerStep(paths: StagePaths, unpacked: string, version: string, icon: string): Promise<{ exe: string; zipBytes: number }> {
  const electron = electronInfo(paths.desktopDir);
  const payloadDir = join(paths.buildDir, 'installer-payload');
  log(`payload: zip de ${unpacked}`);
  const payload = await createPayload(unpacked, payloadDir, version, (line) => log(line));
  log(`payload.zip: ${mib(payload.zipBytes)} (${payload.meta.files} arquivos, ${mib(payload.meta.uncompressedBytes)} descompactados)`);

  const installerAppDir = join(paths.buildDir, 'installer-app');
  removeTreeOrThrow(installerAppDir);
  mkdirSync(installerAppDir, { recursive: true });
  copyTree(join(paths.desktopDir, 'dist', 'installer'), installerAppDir);
  writeFileSync(join(installerAppDir, 'package.json'), `${JSON.stringify(installerPackageJson(version), null, 2)}\n`, 'utf8');

  const outputDir = join(paths.buildDir, 'installer-build');
  removeTreeOrThrow(outputDir);
  const config = installerBuilderConfig({
    buildDir: paths.buildDir,
    electronDist: electron.dist,
    electronVersion: electron.version,
    icon,
    version,
    installerAppDir,
    payloadDir,
  });
  log(`electron-builder (portable) -> ${outputDir}`);
  await build({
    targets: Platform.WINDOWS.createTarget('portable', Arch.x64),
    projectDir: installerAppDir,
    config,
    publish: 'never',
  });

  const built = join(outputDir, installerArtifactName(version));
  requireFile(built, installerArtifactName(version));
  const installerApp = join(outputDir, 'win-unpacked');
  verifyFuses(join(installerApp, 'Nanachi Setup.exe'), INSTALLER_FUSES);
  assertNoDefaultApp(installerApp);
  const finalPath = join(releaseDirOf(paths.buildDir), installerArtifactName(version));
  rmSync(finalPath, { force: true });
  renameSync(built, finalPath);
  return { exe: finalPath, zipBytes: payload.zipBytes };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const skipInstaller = args.includes('--skip-installer');
  assertNode22(process.versions.node);

  const paths = stagePaths(import.meta.url);
  // electron-builder must never sign, whatever the environment says.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const name of ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name];
  process.env[BUILD_DIR_ENV] = paths.buildDir;

  const version = readVersion(paths.desktopDir);
  const icon = join(paths.repoRoot, 'packages', 'pwa', 'public', 'icon-512.png');
  requireFile(icon, 'o ícone do app (packages/pwa/public/icon-512.png)');
  const npmCli = findNpmCli(process.env, process.execPath);
  if (npmCli === null) throw new Error('não achei o npm-cli.js para rodar o npm com o Node 22');

  log(`versão ${version}; pasta de build ${paths.buildDir}`);
  stageStep(paths, fresh);
  compileStep(paths, npmCli);
  sidecarStep(paths);
  const unpacked = await appStep(paths, icon);
  log(`app: ${join(unpacked, 'Nanachi.exe')} (${mib(directorySize(unpacked))} em ${unpacked})`);

  if (skipInstaller) {
    log('instalador ignorado (--skip-installer)');
    return;
  }
  const installer = await installerStep(paths, unpacked, version, icon);
  log('pronto:');
  log(`  win-unpacked  ${unpacked}  ${mib(directorySize(unpacked))}`);
  log(`  payload.zip   ${join(paths.buildDir, 'installer-payload', 'payload.zip')}  ${mib(installer.zipBytes)}`);
  log(`  instalador    ${installer.exe}  ${mib(statSync(installer.exe).size)}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((error: unknown) => {
    console.error(`package: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    // electron-builder resets `process.exitCode` while it shuts down, so a failure must exit explicitly.
    process.exit(1);
  });
}
