import { describe, expect, it } from 'vitest';
import { analyzeLogLine, type LogTokenKind } from '../../src/control/lib/log-tokens.js';

/** The texts of the tokens of one kind, in order. */
function textsOf(line: string, kind: LogTokenKind): string[] {
  return analyzeLogLine(line)
    .tokens.filter((token) => token.kind === kind)
    .map((token) => token.text);
}

/** Every token must give back exactly the line it came from, or the viewer would show different text than the file. */
function expectLossless(line: string): void {
  expect(analyzeLogLine(line).tokens.map((token) => token.text).join('')).toBe(line);
}

describe('analyzeLogLine: structure', () => {
  it('keeps the text of the line exactly, whatever the tokens', () => {
    const samples = [
      '{"level":30,"time":1762389600123,"pid":4312,"hostname":"OFFICE-PC","msg":"Server listening at http://127.0.0.1:7780"}',
      '2026-11-05T04:56:43.604Z [shared-tsc] error TS2688: Cannot find type definition file for \'fs-extra\'.',
      '    at Object.<anonymous> (C:\\repo\\packages\\desktop\\src\\main\\index.ts:42:7)',
      '[tsnet]   erro:   não foi possível iniciar   o nó\ttab',
      '',
      '   ',
      'd\'água, "unterminated, \\ backslash',
    ];
    for (const sample of samples) expectLossless(sample);
  });

  it('an empty line has no tokens and the info level', () => {
    expect(analyzeLogLine('')).toEqual({ tokens: [], level: 'info' });
  });

  it('does not take long on adversarial input (long words, runs of separators, unterminated quotes)', () => {
    const adversarial = [
      'a'.repeat(5000),
      '/a'.repeat(1500),
      `C:\\${'a '.repeat(1500)}`,
      '"'.repeat(3000),
      `${'x/'.repeat(1500)}1`,
      `${'1.'.repeat(2000)}z`,
    ];
    const started = Date.now();
    for (const line of adversarial) expectLossless(line);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('analyzeLogLine: pino JSON lines (what the daemon writes to stdout)', () => {
  const info =
    '{"level":30,"time":1762389600123,"pid":4312,"hostname":"OFFICE-PC","msg":"Server listening at http://127.0.0.1:7780"}';

  it('reads the numeric level as info and the time as a timestamp', () => {
    const analysis = analyzeLogLine(info);
    expect(analysis.level).toBe('info');
    expect(textsOf(info, 'level')).toEqual(['30']);
    expect(textsOf(info, 'timestamp')).toEqual(['1762389600123']);
  });

  it('marks the JSON keys and the numbers, and the URL inside the message', () => {
    expect(textsOf(info, 'key')).toEqual(['"level"', '"time"', '"pid"', '"hostname"', '"msg"']);
    expect(textsOf(info, 'number')).toEqual(['4312']);
    expect(textsOf(info, 'url')).toEqual(['http://127.0.0.1:7780']);
  });

  it('gives the JSON punctuation its own token', () => {
    const punctuation = textsOf(info, 'punctuation');
    expect(punctuation.slice(0, 3)).toEqual(['{', ':', ',']);
    expect(punctuation.at(-1)).toBe('}');
  });

  it('maps the pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 and 60 error', () => {
    const at = (level: number): string => `{"level":${level},"msg":"x"}`;
    expect(analyzeLogLine(at(10)).level).toBe('trace');
    expect(analyzeLogLine(at(20)).level).toBe('debug');
    expect(analyzeLogLine(at(30)).level).toBe('info');
    expect(analyzeLogLine(at(40)).level).toBe('warn');
    expect(analyzeLogLine(at(50)).level).toBe('error');
    expect(analyzeLogLine(at(60)).level).toBe('error');
  });

  it('an error logged with a stack and a Windows path: the level is error and the path is a path', () => {
    const line = String.raw`{"level":50,"time":1762389601000,"pid":4312,"err":{"type":"Error","message":"ENOENT: open 'C:\\Users\\sample-user\\x.json'"},"msg":"falhou ao ler"}`;
    expect(analyzeLogLine(line).level).toBe('error');
    expect(textsOf(line, 'path')).toEqual([String.raw`C:\\Users\\sample-user\\x.json`]);
  });

  it('a message that says "error" does not make an info line an error', () => {
    const line = '{"level":30,"msg":"error handled gracefully"}';
    expect(analyzeLogLine(line).level).toBe('info');
  });

  it('a JSON string value with a level name counts as the level', () => {
    expect(analyzeLogLine('{"level":"warn","msg":"disk almost full"}').level).toBe('warn');
  });
});

describe('analyzeLogLine: levels in plain text', () => {
  it('an ISO timestamp followed by a level word', () => {
    const line = '2026-11-05T10:00:00Z ERROR something broke';
    expect(analyzeLogLine(line).level).toBe('error');
    expect(textsOf(line, 'timestamp')).toEqual(['2026-11-05T10:00:00Z']);
    expect(textsOf(line, 'level')).toEqual(['ERROR']);
  });

  it('a bracketed level and a bracketed source tag', () => {
    expect(analyzeLogLine('[warn] disk almost full').level).toBe('warn');
    expect(analyzeLogLine('[DEBUG] polling').level).toBe('debug');
    expect(textsOf('[DEBUG] polling', 'level')).toEqual(['[DEBUG]']);
  });

  it('a level word after a source tag, in Portuguese too', () => {
    const line = '[tsnet] erro: não foi possível iniciar o nó';
    expect(analyzeLogLine(line).level).toBe('error');
    expect(textsOf(line, 'level')).toEqual(['erro']);
  });

  it('a level word after a timestamp and a tag (the tsc output of the supervisor log)', () => {
    const line = "2026-11-05T04:56:43.604Z [shared-tsc] error TS2688: Cannot find type definition file for 'fs-extra'.";
    expect(analyzeLogLine(line).level).toBe('error');
    expect(textsOf(line, 'timestamp')).toEqual(['2026-11-05T04:56:43.604Z']);
    expect(textsOf(line, 'string')).toEqual(["'fs-extra'"]);
  });

  it('a clock time with AM and PM', () => {
    expect(textsOf('10:03:55 AM - Starting compilation', 'timestamp')).toEqual(['10:03:55 AM']);
  });

  it('WARNING at the start of a line is a warning', () => {
    expect(analyzeLogLine('WARNING: deprecated option').level).toBe('warn');
  });

  it('a level word in the middle of a sentence is not a level marker', () => {
    expect(analyzeLogLine('the daemon found 9 errors and kept going').level).toBe('info');
    expect(textsOf('the daemon found 9 errors', 'level')).toEqual([]);
  });

  it('keeps the old keyword rule for lines without a level marker (Uncaught, panic, warn)', () => {
    expect(analyzeLogLine('Uncaught Exception: x').level).toBe('error');
    expect(analyzeLogLine('kernel panic reached').level).toBe('error');
    expect(analyzeLogLine('disk warning reached').level).toBe('warn');
  });

  it('a word that only contains a level name is not a level', () => {
    expect(analyzeLogLine('terror management').level).toBe('info');
  });

  it('key=value pairs: the key, the equals sign and a level value', () => {
    const line = 'port=7780 state=running pid=4312 level=debug';
    expect(textsOf(line, 'key')).toEqual(['port', 'state', 'pid', 'level']);
    expect(textsOf(line, 'level')).toEqual(['debug']);
    expect(textsOf(line, 'number')).toEqual(['7780', '4312']);
    expect(analyzeLogLine(line).level).toBe('debug');
  });
});

describe('analyzeLogLine: URLs, paths and numbers', () => {
  it('a URL keeps its port and loses the sentence punctuation after it', () => {
    expect(textsOf('Server listening at http://127.0.0.1:7780.', 'url')).toEqual(['http://127.0.0.1:7780']);
    expect(textsOf('see http://localhost:7780/api.', 'url')).toEqual(['http://localhost:7780/api']);
  });

  it('a tailnet HTTPS address with a trailing slash', () => {
    expect(textsOf('Open https://nanachi-pc.tail1234.ts.net/ now.', 'url')).toEqual(['https://nanachi-pc.tail1234.ts.net/']);
  });

  it('a Windows path with spaces and non-ASCII letters, closed by a parenthesis', () => {
    const line =
      'a interface do centro de controle não foi encontrada (C:\\Users\\sample-user\\OneDrive\\Área de Trabalho\\Nanachi-Remote\\packages\\desktop\\dist\\control\\index.html). Abrindo as sessões no lugar.';
    expect(textsOf(line, 'path')).toEqual(['C:\\Users\\sample-user\\OneDrive\\Área de Trabalho\\Nanachi-Remote\\packages\\desktop\\dist\\control\\index.html']);
  });

  it('a stack frame: the "at" word, the path with its line and column, and the plain function name', () => {
    const line = '    at Object.<anonymous> (C:\\repo\\packages\\desktop\\src\\main\\index.ts:42:7)';
    const tokens = analyzeLogLine(line).tokens;
    expect(tokens[0]).toEqual({ kind: 'text', text: '    ' });
    expect(tokens[1]).toEqual({ kind: 'frame', text: 'at' });
    expect(textsOf(line, 'path')).toEqual(['C:\\repo\\packages\\desktop\\src\\main\\index.ts:42:7']);
  });

  it('a POSIX stack frame keeps the path with its line and column', () => {
    const line = '    at Module._compile (/usr/src/app/dist/index.js:12:5)';
    expect(textsOf(line, 'path')).toEqual(['/usr/src/app/dist/index.js:12:5']);
    expect(textsOf(line, 'frame')).toEqual(['at']);
  });

  it('a relative path with a tsc location, and the quoted text after it', () => {
    const line = "src/control/lib/logs.ts(12,5): error TS2322: Type 'string' is not assignable";
    expect(textsOf(line, 'path')).toEqual(['src/control/lib/logs.ts']);
    expect(textsOf(line, 'number')).toEqual(['12', '5']);
    expect(textsOf(line, 'string')).toEqual(["'string'"]);
    expect(analyzeLogLine(line).level).toBe('error');
  });

  it('a route and a version are not paths or numbers', () => {
    expect(textsOf('GET /api/sessions/abc 200', 'path')).toEqual([]);
    expect(textsOf('version v1.2.3 ready', 'number')).toEqual([]);
    expect(textsOf('1/2 done', 'path')).toEqual([]);
  });

  it('numbers keep their decimals and an IP address is one number', () => {
    expect(textsOf('took 12 ms, load 0.5, bind 127.0.0.1', 'number')).toEqual(['12', '0.5', '127.0.0.1']);
  });
});

describe('analyzeLogLine: quotes, keys and frames', () => {
  it('double-quoted keys and values are told apart by the colon after the key', () => {
    const line = '{"a":"b"}';
    expect(textsOf(line, 'key')).toEqual(['"a"']);
    expect(textsOf(line, 'string')).toEqual(['"b"']);
  });

  it('an apostrophe inside a word does not open a quoted string', () => {
    expect(textsOf("Não encontrei o arquivo d'água.", 'string')).toEqual([]);
  });

  it('a single-quoted value after a space is a string', () => {
    expect(textsOf("cannot open 'config.json' now", 'string')).toEqual(["'config.json'"]);
  });

  it('an empty line of only spaces is text, and a frame line is recognised by its first word', () => {
    expect(analyzeLogLine('   ').tokens).toEqual([{ kind: 'text', text: '   ' }]);
    expect(analyzeLogLine('      at async Promise.all (index 0)').tokens[1]).toEqual({ kind: 'frame', text: 'at' });
    expect(analyzeLogLine('atomic write done').tokens.some((token) => token.kind === 'frame')).toBe(false);
  });

  it('plain text lines keep their words as text', () => {
    expect(analyzeLogLine('daemon listening').tokens).toEqual([{ kind: 'text', text: 'daemon listening' }]);
  });
});
