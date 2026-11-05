// Daemon for e2e/run-accounts.mjs: the built daemon (packages/daemon/dist), started the way `main.ts` starts it, but with
// the account runtime replaced so no real `claude` binary ever runs. It uses the seam the daemon tests use
// (`buildServer({ accountRuntime })`), so nothing test-only exists in the daemon's own code:
//
//   - the login of an account runs `node fake-claude-cli.mjs auth login` instead of `claude auth login`;
//   - every identity check (`claude auth status`, for the principal and for each extra account) runs
//     `node fake-claude-cli.mjs auth status`;
//   - `userHome` is a temp folder, so nothing under the real `%USERPROFILE%` is read or written.
//
// Environment: NANACHI_HOME (the temp home of the run), E2E_FAKE_CLAUDE_CLI (path to fake-claude-cli.mjs) and
// CLAUDE_CONFIG_DIR (the temp principal home; the run also puts it in the agent's env). It has no pairing, push or
// reload watcher: the run pairs through `dist/cli.js pair`, and the process is killed at the end.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const daemonDist = join(repoRoot, 'packages', 'daemon', 'dist');
const load = (name) => import(pathToFileURL(join(daemonDist, name)).href);

const fakeCli = process.env.E2E_FAKE_CLAUDE_CLI;
const home = process.env.NANACHI_HOME;
const principalHome = process.env.CLAUDE_CONFIG_DIR;
if (!fakeCli || !home || !principalHome) {
  console.error('accounts-daemon: NANACHI_HOME, E2E_FAKE_CLAUDE_CLI and CLAUDE_CONFIG_DIR are required');
  process.exit(1);
}

const { loadConfig } = await load('config.js');
const { openDatabase } = await load('db.js');
const { ensureMachine } = await load('repository.js');
const { loadOrCreateVapid } = await load('vapid.js');
const { LiveConnections } = await load('live-connections.js');
const { buildServer } = await load('server.js');
const { createAgentAccounts, execCommand, resolveVerifierCommand } = await load('agent-accounts.js');
const { agentBinDirs, withPathPrepended } = await load('agent-path.js');

const config = loadConfig(home);
const db = openDatabase(join(home, 'data.db'));
const machine = ensureMachine(db, config.machineName);
const vapid = loadOrCreateVapid(home);
const version = JSON.parse(readFileSync(join(repoRoot, 'packages', 'daemon', 'package.json'), 'utf8')).version;

// The identity checks run `claude`: here that is the fake CLI, run by this very node. Any other command keeps its
// normal resolution (the config of this run has no other agent with a verifier).
const probeEnv = withPathPrepended({ ...process.env }, agentBinDirs());
const resolveCommand = (command) => (command === 'claude' ? process.execPath : resolveVerifierCommand(command, probeEnv));
const run = (file, args, options) =>
  execCommand(file, file === process.execPath ? [fakeCli, ...args] : args, options);

const accountRuntime = {
  userHome: join(home, 'user-home'),
  daemonEnv: process.env,
  resolve: resolveCommand,
  run,
  login: {
    resolveLogin: (adapter) => ({ file: process.execPath, args: [fakeCli, ...adapter.login.args], shell: false }),
  },
};

const app = await buildServer({
  config,
  db,
  machine,
  version,
  home,
  staticDir: join(repoRoot, 'packages', 'pwa', 'dist'),
  staticPointer: join(repoRoot, 'packages', 'pwa', 'releases', 'current.json'),
  vapidPublicKey: vapid.publicKey,
  connections: new LiveConnections(),
  accountRuntime,
  // The principal's identity check (`GET /api/agents/accounts`) goes through the same fake CLI.
  agentAccounts: createAgentAccounts({
    agents: config.agents,
    home: accountRuntime.userHome,
    env: probeEnv,
    resolve: resolveCommand,
    run,
  }),
});

const stop = () => {
  app
    .close()
    .then(() => db.close())
    .finally(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await app.listen({ host: config.host, port: config.port });
