// Fake login CLI for the daemon tests. It runs inside a PTY, like `claude auth login` and `codex login --device-auth`.
//
//   node login-fixture.mjs claude [echo]  prints the real Claude output (OSC 8 link + "Paste code here if prompted > "),
//                                         reads one line, writes a fake credential marker into CLAUDE_CONFIG_DIR, exits 0.
//                                         With "echo" it also prints the line back (a terminal echoing the pasted code).
//   node login-fixture.mjs codex [hold]   prints the real Codex output (device link and one-time code), writes the marker
//                                         into CODEX_HOME and exits 0. With "hold" it waits for the file <CODEX_HOME>/release.
//   node login-fixture.mjs fail           prints a line and exits 1.
//   node login-fixture.mjs hang           prints the Codex output and never exits.
//
// LOGIN_OUT_DIR: writes env.json (cwd, columns and the variables the tests look at) and pid.
// The marker (`logged-in.marker`) stands for the credential file: the tests never create or read a real one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'claude';
const flag = process.argv[3];
const samples = JSON.parse(readFileSync(new URL('./login-samples.json', import.meta.url), 'utf8'));
const home = process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME ?? process.cwd();

const outDir = process.env.LOGIN_OUT_DIR;
if (outDir !== undefined) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'env.json'),
    JSON.stringify({
      cwd: process.cwd(),
      columns: process.stdout.columns,
      NANACHI_TEST_LEAK: process.env.NANACHI_TEST_LEAK,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      PATH: process.env.PATH,
    }),
  );
  writeFileSync(join(outDir, 'pid'), String(process.pid));
}

function writeMarker() {
  writeFileSync(join(home, 'logged-in.marker'), 'fake credential marker');
}

function exitWith(code) {
  process.stdout.write('', () => process.exit(code));
}

if (mode === 'claude') {
  process.stdout.write(samples.claude);
  process.stdin.setEncoding('utf8');
  let typed = '';
  process.stdin.on('data', (chunk) => {
    typed += chunk;
    if (!/[\r\n]/.test(typed)) return;
    const line = typed.trim();
    if (flag === 'echo') process.stdout.write(`${line}\r\n`);
    writeMarker();
    process.stdout.write('Login successful\r\n', () => exitWith(0));
  });
} else if (mode === 'codex') {
  process.stdout.write(samples.codex);
  const finish = () => {
    writeMarker();
    exitWith(0);
  };
  if (flag === 'hold') {
    const timer = setInterval(() => {
      if (!existsSync(join(home, 'release'))) return;
      clearInterval(timer);
      finish();
    }, 50);
  } else {
    setTimeout(finish, 100);
  }
} else if (mode === 'fail') {
  process.stdout.write('Error: login was refused\r\n', () => exitWith(1));
} else if (mode === 'hang') {
  process.stdout.write(samples.codex);
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(`unknown mode: ${mode}\r\n`, () => exitWith(2));
}
