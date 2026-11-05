import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountAdapterOf } from '../src/accounts/adapters.js';
import {
  CODE_MASK,
  OUTPUT_LIMIT,
  cleanTerminalText,
  maskCodes,
  parseLoginOutput,
  tailOf,
} from '../src/accounts/login-output.js';

/** Real output observed on this PC (PLAN.md, several accounts per agent). Escape sequences are part of the sample. */
const SAMPLES = JSON.parse(readFileSync(new URL('./fixtures/login-samples.json', import.meta.url), 'utf8')) as {
  claude: string;
  claudeUrl: string;
  codex: string;
};

const CODEX_PATTERN = accountAdapterOf('codex')?.login.codePattern ?? null;

describe('cleanTerminalText', () => {
  it('drops OSC terminated by BEL or by ST, keeping the visible text', () => {
    expect(cleanTerminalText('a\u001b]0;title\u0007b')).toBe('ab');
    expect(cleanTerminalText('a\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\b')).toBe('alinkb');
  });

  it('drops SGR without leaving a gap', () => {
    expect(cleanTerminalText('Co\u001b[1;32mde\u001b[0mx')).toBe('Codex');
    expect(cleanTerminalText('\u001b[38;5;208mx\u001b[m')).toBe('x');
  });

  it('replaces every other CSI with a space, so lines are not glued together', () => {
    expect(cleanTerminalText('agent\u001b[2;1HFollow')).toBe('agent Follow');
    expect(cleanTerminalText('a\u001b[?25lb\u001b[2Jc\u001b[K')).toBe('a b c ');
  });

  it('normalises CRLF and a lone CR to LF', () => {
    expect(cleanTerminalText('one\r\ntwo\rthree\nfour')).toBe('one\ntwo\nthree\nfour');
  });

  it('drops an escape sequence cut off at the end of the chunk', () => {
    expect(cleanTerminalText('abc\u001b')).toBe('abc');
    expect(cleanTerminalText('abc\u001b[12;')).toBe('abc');
    expect(cleanTerminalText('abc\u001b]8;id=1;https://x.test')).toBe('abc');
    expect(cleanTerminalText('abc\u001b]8;id=1;https://x.test\u001b')).toBe('abc');
  });

  it('drops charset and keypad escapes and stray control characters, but keeps tab and newline', () => {
    expect(cleanTerminalText('a\u001b(Bb\u001b=c\u0000d\u0008e\tf\ng')).toBe('abcde\tf\ng');
  });
});

describe('parseLoginOutput', () => {
  it('Claude (real sample): url comes from the first https link, with the OSC 8 wrapper gone', () => {
    const parsed = parseLoginOutput(SAMPLES.claude, null, false);

    expect(parsed.url).toBe(SAMPLES.claudeUrl);
    expect(parsed.userCode).toBeNull();
    expect(parsed.text).toContain("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize");
    expect(parsed.text.endsWith('\nPaste code here if prompted > ')).toBe(true);
    expect(parsed.text).not.toContain('\u001b');
    expect(parsed.text).not.toContain('\r');
    // The OSC parameters carried a second copy of the URL: only the visible one is left.
    expect(parsed.text.split('https://claude.com/cai/oauth/authorize').length - 1).toBe(1);
  });

  it('Claude: the redirect_uri inside the link is not mistaken for the link', () => {
    expect(parseLoginOutput(SAMPLES.claude, null, true).url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  });

  it('Codex (real sample): url and one-time code, even with cursor moves between the lines', () => {
    const parsed = parseLoginOutput(SAMPLES.codex, CODEX_PATTERN, false);

    expect(parsed.url).toBe('https://auth.openai.com/codex/device');
    expect(parsed.userCode).toBe('0HKH-0YU99');
    expect(parsed.text).toContain('agent Follow these steps');
    expect(parsed.text).toContain('/codex/device 2. Enter this one-time code');
  });

  it('the code is only searched after the link', () => {
    const raw = 'ABCD-EFGH before\nvisit https://example.test/device now\nthen WXYZ-12345 done';
    expect(parseLoginOutput(raw, CODEX_PATTERN, true)).toMatchObject({ url: 'https://example.test/device', userCode: 'WXYZ-12345' });
    // A code-shaped string before the link and nothing after it: no code.
    const onlyBefore = 'ABCD-EFGH before\nvisit https://example.test/device now\n';
    expect(parseLoginOutput(onlyBefore, CODEX_PATTERN, true).userCode).toBeNull();
  });

  it('no link yet: url and userCode are null, even if a code-shaped string is there', () => {
    expect(parseLoginOutput('Starting login...\r\nABCD-EFGH\r\n', CODEX_PATTERN, true)).toMatchObject({ url: null, userCode: null });
  });

  it('stops the link at whitespace, quotes and angle brackets', () => {
    for (const [raw, url] of [
      ['go https://a.test/x?y=1 now', 'https://a.test/x?y=1'],
      ['go "https://a.test/x" now', 'https://a.test/x'],
      ["go 'https://a.test/x' now", 'https://a.test/x'],
      ['go <https://a.test/x> now', 'https://a.test/x'],
    ] as const) {
      expect(parseLoginOutput(raw, null, true).url).toBe(url);
    }
  });

  it('ignores http links', () => {
    expect(parseLoginOutput('visit http://insecure.test/a\n', null, true).url).toBeNull();
  });

  it('while output is still arriving, a link or code that touches the end of the text is not trusted yet', () => {
    const partial = 'visit https://auth.openai.com/codex/dev';
    expect(parseLoginOutput(partial, CODEX_PATTERN, false).url).toBeNull();
    expect(parseLoginOutput(partial, CODEX_PATTERN, true).url).toBe('https://auth.openai.com/codex/dev');

    const codeCut = 'visit https://auth.openai.com/codex/device\r\ncode ABCD-12';
    expect(parseLoginOutput(codeCut, CODEX_PATTERN, false)).toMatchObject({ url: 'https://auth.openai.com/codex/device', userCode: null });
    expect(parseLoginOutput(codeCut + '34\r\n', CODEX_PATTERN, false).userCode).toBe('ABCD-1234');
  });

  it('a pattern with the g flag does not carry state between calls', () => {
    const global = new RegExp(CODEX_PATTERN?.source ?? '', 'g');
    const raw = 'https://auth.openai.com/codex/device\r\n0HKH-0YU99\r\n';
    expect(parseLoginOutput(raw, global, true).userCode).toBe('0HKH-0YU99');
    expect(parseLoginOutput(raw, global, true).userCode).toBe('0HKH-0YU99');
  });
});

describe('maskCodes', () => {
  it('replaces an echoed code', () => {
    expect(maskCodes('Paste code here > AbC123xyz\n', ['AbC123xyz'])).toBe(`Paste code here > ${CODE_MASK}\n`);
  });

  it('replaces every echo, not just the first', () => {
    expect(maskCodes('x SECRET-CODE-1 y SECRET-CODE-1', ['SECRET-CODE-1'])).toBe(`x ${CODE_MASK} y ${CODE_MASK}`);
  });

  it('masks a code that the terminal redrew with spaces or line breaks between characters', () => {
    expect(maskCodes('> SECR ET-CO\nDE-1 <', ['SECRET-CODE-1'])).toBe(`> ${CODE_MASK} <`);
  });

  it('treats the code as text, not as a pattern', () => {
    expect(maskCodes('a.b*c+d?e(f)[g]{h}|i\\j^k$l', ['a.b*c+d?e(f)[g]{h}|i\\j^k$l'])).toBe(CODE_MASK);
    expect(maskCodes('axb', ['a.b'])).toBe('axb');
  });

  it('masks several codes and leaves the text alone when there is nothing to mask', () => {
    expect(maskCodes('one-code-aaa two-code-bbb', ['one-code-aaa', 'two-code-bbb'])).toBe(`${CODE_MASK} ${CODE_MASK}`);
    expect(maskCodes('nothing here', [])).toBe('nothing here');
    expect(maskCodes('nothing here', [''])).toBe('nothing here');
  });
});

describe('tailOf', () => {
  it('keeps the whole text under the limit and the last OUTPUT_LIMIT characters over it', () => {
    expect(OUTPUT_LIMIT).toBe(4000);
    expect(tailOf('short')).toBe('short');
    const long = `${'a'.repeat(100)}${'b'.repeat(OUTPUT_LIMIT)}`;
    expect(tailOf(long)).toBe('b'.repeat(OUTPUT_LIMIT));
    expect(tailOf('abcdef', 3)).toBe('def');
  });
});
