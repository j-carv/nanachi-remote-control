// Fake `claude` CLI for e2e/run-accounts.mjs. It stands in for the two commands the daemon runs for an account:
//
//   node fake-claude-cli.mjs auth login   prints what `claude auth login` prints in a PTY (an OSC 8 link and
//                                         "Paste code here if prompted > "), reads one line, and then either writes the
//                                         credential marker into CLAUDE_CONFIG_DIR and exits 0, or (the line is
//                                         "wrong") prints an error that echoes the line, like a CLI would, and exits 1.
//   node fake-claude-cli.mjs auth status  prints the JSON of `claude auth status`: logged in when the marker exists in
//                                         CLAUDE_CONFIG_DIR, logged out otherwise.
//
// The marker (`e2e-login.json`) stands for `.credentials.json`: this script never reads or writes a real credential, and
// it refuses to run without CLAUDE_CONFIG_DIR so it can never fall back to the user's own `~/.claude`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [group, action] = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR;
if (home === undefined || home === '') {
  process.stderr.write('fake-claude-cli: CLAUDE_CONFIG_DIR is required\n');
  process.exit(2);
}
const marker = join(home, 'e2e-login.json');
const email = process.env.E2E_FAKE_EMAIL ?? 'trabalho@example.test';

function exitWith(code) {
  process.stdout.write('', () => process.exit(code));
}

if (group === 'auth' && action === 'status') {
  if (!existsSync(marker)) {
    process.stdout.write(`${JSON.stringify({ loggedIn: false })}\n`, () => process.exit(0));
  } else {
    const data = JSON.parse(readFileSync(marker, 'utf8'));
    process.stdout.write(
      `${JSON.stringify({ loggedIn: true, email: data.email, orgName: 'Org Teste', subscriptionType: 'pro' })}\n`,
      () => process.exit(0),
    );
  }
} else if (group === 'auth' && action === 'login') {
  // The real output, kept next to the daemon's own login fixtures.
  const samples = JSON.parse(
    readFileSync(new URL('../../packages/daemon/test/fixtures/login-samples.json', import.meta.url), 'utf8'),
  );
  process.stdout.write(samples.claude);
  process.stdin.setEncoding('utf8');
  let typed = '';
  process.stdin.on('data', (chunk) => {
    typed += chunk;
    if (!/[\r\n]/.test(typed)) return;
    const line = typed.trim();
    if (line === 'wrong') {
      process.stdout.write(`\r\nError: invalid code: ${line}\r\n`, () => exitWith(1));
      return;
    }
    writeFileSync(marker, JSON.stringify({ email }));
    process.stdout.write('\r\nLogin successful\r\n', () => exitWith(0));
  });
} else {
  process.stderr.write(`fake-claude-cli: unsupported command: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
