'use strict';
/*
 * Runs one scenario of the folder-removal code under Electron's Node (`electron.exe` with ELECTRON_RUN_AS_NODE=1), where
 * `fs.rmSync(path, { recursive: true })` follows directory junctions. Usage:
 *
 *   electron.exe electron-probe.cjs <bundle.cjs> <scenario> <work dir>
 *
 * Prints one JSON line with facts; `test/electron-runtime.test.ts` asserts on them. Everything happens inside <work dir>.
 */
const path = require('node:path');
// Electron's `fs` treats `app.asar` as an archive; the uninstaller inside the app uses `original-fs`, so does this.
const fs = (() => {
  try {
    return require('original-fs');
  } catch {
    return require('node:fs');
  }
})();

const [bundlePath, scenario, work] = process.argv.slice(2);
const code = require(bundlePath);

const facts = { runtime: { node: process.versions.node, electron: process.versions.electron ?? null }, scenario };

function write(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** `<root>/outside` holds what must survive. */
function makeOutside(root) {
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'keep.txt'), 'keep');
  write(path.join(outside, 'sub', 'deep.txt'), 'deep');
  return outside;
}

function outsideFacts(outside) {
  return {
    outsideKeep: fs.existsSync(path.join(outside, 'keep.txt')),
    outsideDeep: fs.existsSync(path.join(outside, 'sub', 'deep.txt')),
  };
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(work, { recursive: true });

  if (scenario === 'canary') {
    // Does the plain recursive rmSync follow a junction in this runtime? (Documents why the walker exists.)
    const outside = makeOutside(path.join(work, 'canary'));
    const tree = path.join(work, 'canary', 'tree');
    write(path.join(tree, 'a.txt'));
    fs.symlinkSync(outside, path.join(tree, 'link'), 'junction');
    fs.rmSync(tree, { recursive: true, force: true });
    facts.plainRmSyncFollowsJunction = !fs.existsSync(path.join(outside, 'keep.txt'));
    return;
  }

  if (scenario === 'tree-with-junctions') {
    const outside = makeOutside(work);
    const tree = path.join(work, 'tree');
    write(path.join(tree, 'a.txt'));
    write(path.join(tree, 'sub', 'b.txt'));
    write(path.join(tree, 'sub', 'deeper', 'c.txt'));
    const readOnly = path.join(tree, 'readonly.txt');
    write(readOnly);
    fs.chmodSync(readOnly, 0o444);
    fs.symlinkSync(outside, path.join(tree, 'link'), 'junction');
    fs.symlinkSync(outside, path.join(tree, 'sub', 'deeper', 'link2'), 'junction');
    facts.removed = code.removeTree(tree, fs, { sleep: () => undefined });
    facts.treeExists = exists(tree);
    Object.assign(facts, outsideFacts(outside));
    return;
  }

  if (scenario === 'top-level-junction') {
    const outside = makeOutside(work);
    const junction = path.join(work, 'junction');
    fs.symlinkSync(outside, junction, 'junction');
    facts.removed = code.removeTree(junction, fs, { sleep: () => undefined });
    facts.junctionExists = exists(junction);
    Object.assign(facts, outsideFacts(outside));
    return;
  }

  if (scenario === 'delete-data') {
    // The layout of NANACHI_HOME: per-account folders whose projects, skills and sessions are junctions into the
    // agents' own folders in the user profile.
    const profile = path.join(work, 'profile');
    const claudeHome = path.join(profile, '.claude');
    const codexHome = path.join(profile, '.codex');
    write(path.join(claudeHome, 'projects', 'p1', 'session.jsonl'), 'claude history');
    write(path.join(claudeHome, 'skills', 'mine', 'SKILL.md'), 'skill');
    write(path.join(codexHome, 'sessions', '2026', 'rollout.jsonl'), 'codex history');
    const home = path.join(profile, '.nanachi-desktop');
    write(path.join(home, 'config.json'), '{"port":7777}');
    write(path.join(home, 'data.db'), 'sqlite');
    const account = path.join(home, 'accounts', 'claude', 'acc-1');
    fs.mkdirSync(account, { recursive: true });
    fs.symlinkSync(path.join(claudeHome, 'projects'), path.join(account, 'projects'), 'junction');
    fs.symlinkSync(path.join(claudeHome, 'skills'), path.join(account, 'skills'), 'junction');
    const codexAccount = path.join(home, 'accounts', 'codex', 'acc-2');
    fs.mkdirSync(codexAccount, { recursive: true });
    fs.symlinkSync(path.join(codexHome, 'sessions'), path.join(codexAccount, 'sessions'), 'junction');
    // A junction at the very top of the data folder's tree, too.
    fs.symlinkSync(claudeHome, path.join(home, 'claude-link'), 'junction');

    const installDir = path.join(work, 'Programs', 'Nanachi');
    write(path.join(installDir, 'Nanachi.exe'), 'MZ');
    write(path.join(installDir, 'resources', 'app.asar'), 'asar');
    write(path.join(installDir, '.nanachi-install.json'), JSON.stringify({ version: '1.0.0', installedAt: 'x', complete: true }));

    const desktopData = path.join(profile, 'AppData', 'Roaming', 'Nanachi');
    write(path.join(desktopData, 'machine.bin'), 'token');

    const result = await code.runUninstall(
      { installDir, deleteData: true, noShortcuts: true, noRegistry: true },
      {
        profile,
        desktopHome: home,
        desktopDataDir: desktopData,
        startMenuDir: path.join(work, 'start'),
        desktopDir: path.join(work, 'desktop'),
        selfPid: 1,
        fs,
        findRunning: async () => [],
        stopProcesses: async () => undefined,
        readShortcutTarget: () => null,
        readStartupCommand: async () => null,
        removeStartup: () => undefined,
        readInstallLocation: async () => null,
        runReg: async () => 0,
        homeInUse: async () => false,
        scheduleRemoval: () => undefined,
        emit: () => undefined,
        sleep: async () => undefined,
        removeOptions: { sleep: () => undefined },
      },
    );
    facts.warnings = result.warnings;
    facts.homeExists = exists(home);
    facts.installExists = exists(installDir);
    facts.desktopDataExists = exists(desktopData);
    facts.claudeProjects = exists(path.join(claudeHome, 'projects', 'p1', 'session.jsonl'));
    facts.claudeSkills = exists(path.join(claudeHome, 'skills', 'mine', 'SKILL.md'));
    facts.codexSessions = exists(path.join(codexHome, 'sessions', '2026', 'rollout.jsonl'));
    return;
  }

  if (scenario === 'upgrade') {
    const outside = makeOutside(work);
    const profile = path.join(work, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    const target = path.join(work, 'Programs', 'Nanachi');
    write(path.join(target, 'Nanachi.exe'), 'old exe');
    write(path.join(target, 'resources', 'old.txt'), 'old');
    fs.symlinkSync(outside, path.join(target, 'resources', 'link'), 'junction');
    fs.symlinkSync(outside, path.join(target, 'top-link'), 'junction');
    write(path.join(target, '.nanachi-install.json'), JSON.stringify({ version: '0.9.0', installedAt: 'x', complete: true }));

    const result = await code.runInstall(
      { target, desktopShortcut: false, startWithWindows: false, noShortcuts: true, noRegistry: true },
      {
        payload: { zipPath: 'unused.zip', meta: { version: '1.0.0', files: 1, uncompressedBytes: 3 } },
        profile,
        desktopHome: path.join(profile, '.nanachi-desktop'),
        startMenuDir: path.join(work, 'start'),
        desktopDir: path.join(work, 'desktop'),
        extract: async (_zip, dir, onBytes) => {
          write(path.join(dir, 'Nanachi.exe'), 'new exe');
          onBytes(3);
        },
        findRunning: async () => [],
        stopProcesses: async () => undefined,
        confirmClose: async () => true,
        writeShortcut: () => true,
        setStartup: () => undefined,
        runReg: async () => 0,
        emit: () => undefined,
        sleep: async () => undefined,
        fs,
        removeOptions: { sleep: () => undefined },
      },
    );
    facts.installedExe = result.exe === path.join(target, 'Nanachi.exe') && fs.readFileSync(result.exe, 'utf8') === 'new exe';
    facts.oldFileGone = !exists(path.join(target, 'resources', 'old.txt'));
    facts.linksGone = !exists(path.join(target, 'resources', 'link')) && !exists(path.join(target, 'top-link'));
    facts.marker = JSON.parse(fs.readFileSync(path.join(target, '.nanachi-install.json'), 'utf8'));
    Object.assign(facts, outsideFacts(outside));
    return;
  }

  throw new Error(`unknown scenario: ${scenario}`);
}

main().then(
  () => {
    process.stdout.write(`${JSON.stringify(facts)}\n`);
  },
  (error) => {
    process.stdout.write(`${JSON.stringify({ ...facts, error: String(error && error.stack ? error.stack : error) })}\n`);
    process.exitCode = 1;
  },
);
