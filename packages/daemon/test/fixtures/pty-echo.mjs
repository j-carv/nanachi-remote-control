// Processo de terminal para os testes do daemon (roda dentro de um PTY, sem loader).
// Sem argumento: imprime "pronto", lê uma linha do stdin, ecoa "eco: <linha>" e sai com código 3.
// Com "espera": imprime "pronto" e fica vivo até ser morto.
// PTY_OUT_DIR: grava <AGENT_SESSION_ID>.env.json (env e cwd que recebeu) e, por último, <AGENT_SESSION_ID>.pid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.env.PTY_OUT_DIR;
const sessionKey = process.env.AGENT_SESSION_ID ?? 'sem-id';
if (outDir !== undefined) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${sessionKey}.env.json`),
    JSON.stringify({
      cwd: process.cwd(),
      AGENT_SESSION_ID: process.env.AGENT_SESSION_ID,
      NANACHI_URL: process.env.NANACHI_URL,
      NANACHI_AGENT_TOKEN: process.env.NANACHI_AGENT_TOKEN,
      PATH: process.env.PATH,
    }),
  );
  writeFileSync(join(outDir, `${sessionKey}.pid`), String(process.pid));
}

console.log('pronto');

if (process.argv[2] === 'espera') {
  setInterval(() => {}, 60_000);
} else {
  process.stdin.setEncoding('utf8');
  let typed = '';
  process.stdin.on('data', (chunk) => {
    typed += chunk;
    if (!/[\r\n]/.test(typed)) return;
    process.stdout.write(`eco: ${typed.trim()}\r\n`, () => process.exit(3));
  });
}
