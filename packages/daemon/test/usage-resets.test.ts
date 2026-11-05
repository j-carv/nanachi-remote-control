import { describe, expect, it } from 'vitest';
import {
  codexResetsView,
  ompRedeemOutcome,
  ompRedeemPrompt,
  parseOmpResetList,
  resetSourceOf,
  stripAnsi,
} from '../src/usage-resets.js';

/*
 * Pure parts of the rate-limit resets (docs/PLAN.md, "rate-limit resets in the usage drawer"). The omp lines follow the
 * formats the contract records for omp 18.13.2; the listing below is built from those templates, not a capture.
 */

const LISTING = [
  '\u001b[1mSaved rate-limit resets:\u001b[22m',
  '- fake@example.com · Org [Anthropic · anthropic/1]: 2 saved, 1 usable now, expires in 3 days (active)',
  '- other@example.com [OpenAI Codex · openai-codex/2]: 1 saved, 0 usable now (not constrained)',
  '- broken@example.com [Anthropic · anthropic/3]: unavailable (token expired)',
  '- soon@example.com [Anthropic · anthropic/4]: 1 saved, 1 usable now, expires 2026-11-10 12:00 (exhausted)',
  '',
  'Spend one with `/usage reset <provider>/<credential id>` or `/usage reset <provider>/active`.',
].join('\n');

describe('stripAnsi', () => {
  it('remove escapes SGR e mantém o texto', () => {
    expect(stripAnsi('\u001b[38;2;0;180;255m██\u001b[39m 62%')).toBe('██ 62%');
    expect(stripAnsi('\u001b[1mNegrito\u001b[22m')).toBe('Negrito');
  });
});

describe('parseOmpResetList', () => {
  it('lê cada conta com salvos, utilizáveis, expiração, motivo e (active)', () => {
    const { entries, message } = parseOmpResetList(LISTING);
    expect(message).toBeNull();
    expect(entries).toEqual([
      {
        target: 'anthropic/1',
        accountLabel: 'fake@example.com · Org',
        providerLabel: 'Anthropic',
        available: 2,
        usable: 1,
        expiresAt: 'in 3 days',
        note: null,
        active: true,
      },
      {
        target: 'openai-codex/2',
        accountLabel: 'other@example.com',
        providerLabel: 'OpenAI Codex',
        available: 1,
        usable: 0,
        expiresAt: null,
        note: 'not constrained',
        active: false,
      },
      {
        target: 'anthropic/3',
        accountLabel: 'broken@example.com',
        providerLabel: 'Anthropic',
        available: 0,
        usable: 0,
        expiresAt: null,
        note: 'token expired',
        active: false,
      },
      {
        target: 'anthropic/4',
        accountLabel: 'soon@example.com',
        providerLabel: 'Anthropic',
        available: 1,
        usable: 1,
        expiresAt: '2026-11-10 12:00',
        note: 'exhausted',
        active: false,
      },
    ]);
  });

  it('linha unavailable vira zero salvos e zero utilizáveis, com o erro em note', () => {
    const { entries } = parseOmpResetList(LISTING);
    expect(entries.find((entry) => entry.target === 'anthropic/3')).toEqual({
      target: 'anthropic/3',
      accountLabel: 'broken@example.com',
      providerLabel: 'Anthropic',
      available: 0,
      usable: 0,
      expiresAt: null,
      note: 'token expired',
      active: false,
    });
  });

  it('(active) também vale na linha unavailable', () => {
    const { entries } = parseOmpResetList('- a@b.c [Anthropic · anthropic/1]: unavailable (network error) (active)');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ note: 'network error', active: true, available: 0 });
  });

  it('sem conta: nenhuma entrada e a primeira linha não vazia como mensagem', () => {
    const reply = '\nNo provider accounts found. Use /login to add one.\n';
    expect(parseOmpResetList(reply)).toEqual({
      entries: [],
      message: 'No provider accounts found. Use /login to add one.',
    });
  });

  it('falha ao carregar: a linha de erro vira mensagem', () => {
    expect(parseOmpResetList('Could not load saved resets: timed out')).toEqual({
      entries: [],
      message: 'Could not load saved resets: timed out',
    });
  });

  it('ignora linhas que não casam com o formato', () => {
    const reply = [
      'linha solta',
      '- sem colchetes: 1 saved, 1 usable now',
      '- a@b.c [Anthropic · anthropic/1]: texto qualquer',
      '- a@b.c [Anthropic · anthropic/1]: 1 saved, 1 usable now',
    ].join('\n');
    const { entries, message } = parseOmpResetList(reply);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe('anthropic/1');
    expect(message).toBeNull();
  });

  it('resposta vazia: sem entradas e sem mensagem', () => {
    expect(parseOmpResetList('')).toEqual({ entries: [], message: null });
  });
});

describe('parseOmpResetList: parenthesised text in the tail', () => {
  const row = (rest: string): string => `- a@b.c [Anthropic · anthropic/1]: ${rest}`;
  /** The fields the tail decides, for the row built from `rest`. */
  const tailOf = (rest: string) => {
    const { entries } = parseOmpResetList(row(rest));
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    return { expiresAt: entry?.expiresAt, note: entry?.note, active: entry?.active };
  };

  it('a reason with nested parentheses keeps the row', () => {
    expect(tailOf('1 saved, 1 usable now (cooldown (5h))')).toEqual({
      expiresAt: null,
      note: 'cooldown (5h)',
      active: false,
    });
  });

  it('an expiry with a time zone and a reason with nested parentheses are told apart', () => {
    expect(tailOf('1 saved, 1 usable now, expires Nov 6 (UTC) (blocked (429))')).toEqual({
      expiresAt: 'Nov 6 (UTC)',
      note: 'blocked (429)',
      active: false,
    });
  });

  it('the (active) marker comes off first, whatever the reason holds', () => {
    expect(tailOf('1 saved, 1 usable now, expires in 3 days (blocked (429)) (active)')).toEqual({
      expiresAt: 'in 3 days',
      note: 'blocked (429)',
      active: true,
    });
    expect(tailOf('1 saved, 0 usable now (cooldown (5h)) (active)')).toEqual({
      expiresAt: null,
      note: 'cooldown (5h)',
      active: true,
    });
  });

  it('a lone group after the expiry is part of the expiry only when it is a time zone', () => {
    // Rule: the reason is the last balanced group, unless it is the only group after `expires <text>` and it reads
    // as a time zone (UTC, GMT, GMT-3, UTC+02:00, +02:00, an abbreviation such as PST or CEST).
    for (const zone of ['UTC', 'GMT', 'GMT-3', 'UTC+02:00', '+02:00', '-0300', 'PST', 'CEST']) {
      expect(tailOf(`1 saved, 1 usable now, expires Nov 6, 12:00 (${zone})`)).toEqual({
        expiresAt: `Nov 6, 12:00 (${zone})`,
        note: null,
        active: false,
      });
    }
    for (const reason of ['exhausted', 'not constrained', 'cooldown (5h)', 'OK', '429']) {
      expect(tailOf(`1 saved, 1 usable now, expires Nov 6, 12:00 (${reason})`)).toEqual({
        expiresAt: 'Nov 6, 12:00',
        note: reason,
        active: false,
      });
    }
  });

  it('a second group after a time zone is always the reason, even when it reads as a time zone', () => {
    expect(tailOf('1 saved, 1 usable now, expires Nov 6 (UTC) (UTC)')).toEqual({
      expiresAt: 'Nov 6 (UTC)',
      note: 'UTC',
      active: false,
    });
    expect(tailOf('1 saved, 1 usable now, expires Nov 6 (UTC) (not constrained)')).toEqual({
      expiresAt: 'Nov 6 (UTC)',
      note: 'not constrained',
      active: false,
    });
  });

  it('without an expiry the only group is the reason, even when it reads as a time zone', () => {
    expect(tailOf('1 saved, 1 usable now (UTC)')).toEqual({ expiresAt: null, note: 'UTC', active: false });
  });

  it('an expiry made of a group alone stays the expiry', () => {
    expect(tailOf('1 saved, 1 usable now, expires (soon)')).toEqual({
      expiresAt: '(soon)',
      note: null,
      active: false,
    });
  });

  it('an empty reason is no reason', () => {
    expect(tailOf('1 saved, 1 usable now, expires Nov 6 ()')).toEqual({
      expiresAt: 'Nov 6',
      note: null,
      active: false,
    });
  });

  it('unbalanced parentheses never drop the row', () => {
    expect(tailOf('1 saved, 1 usable now (broken (reason)')).toEqual({
      expiresAt: null,
      note: '(broken (reason)',
      active: false,
    });
    expect(tailOf('1 saved, 1 usable now, expires Nov 6 (oops')).toEqual({
      expiresAt: 'Nov 6 (oops',
      note: null,
      active: false,
    });
    expect(tailOf('1 saved, 1 usable now, expires Nov 6 oops)')).toEqual({
      expiresAt: 'Nov 6 oops)',
      note: null,
      active: false,
    });
  });

  it('two groups without an expiry keep the whole text as the note', () => {
    expect(tailOf('1 saved, 1 usable now (a) (b)')).toEqual({ expiresAt: null, note: '(a) (b)', active: false });
  });

  it('unavailable rows take nested parentheses in the error', () => {
    const { entries } = parseOmpResetList(row('unavailable (network (timeout)) (active)'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ note: 'network (timeout)', active: true, available: 0, usable: 0 });
  });

  it('every row of a mixed listing survives, whatever its reason holds', () => {
    const reply = [
      '- a@b.c [Anthropic · anthropic/1]: 1 saved, 1 usable now (cooldown (5h))',
      '- b@b.c [Anthropic · anthropic/2]: 1 saved, 1 usable now, expires Nov 6 (UTC) (blocked (429))',
      '- c@b.c [OpenAI Codex · openai-codex/3]: unavailable (network (timeout))',
      '- d@b.c [Anthropic · anthropic/4]: 2 saved, 2 usable now, expires in 3 days (active)',
    ].join('\n');
    expect(parseOmpResetList(reply).entries.map((entry) => entry.target)).toEqual([
      'anthropic/1',
      'anthropic/2',
      'openai-codex/3',
      'anthropic/4',
    ]);
  });
});

describe('ompRedeemPrompt', () => {
  it('monta o comando exato a partir de provedor e id validados', () => {
    expect(ompRedeemPrompt('anthropic/1')).toBe('/usage reset anthropic/1');
    expect(ompRedeemPrompt('openai-codex/active')).toBe('/usage reset openai-codex/active');
  });

  it('recusa provedor, id ou texto extra fora do formato (400 no HTTP)', () => {
    expect(ompRedeemPrompt('openai/1')).toBeUndefined();
    expect(ompRedeemPrompt('anthropic/abc')).toBeUndefined();
    expect(ompRedeemPrompt('anthropic/1 --all')).toBeUndefined();
    expect(ompRedeemPrompt('anthropic/1\n/usage reset x')).toBeUndefined();
    expect(ompRedeemPrompt('')).toBeUndefined();
  });
});

describe('ompRedeemOutcome', () => {
  it('Reset applied → reset, com o texto sem ANSI', () => {
    const reply = '\u001b[32mReset applied for fake@example.com (Anthropic) — 5h session limit refreshed.\u001b[39m\n';
    expect(ompRedeemOutcome(reply)).toEqual({
      outcome: 'reset',
      message: 'Reset applied for fake@example.com (Anthropic) — 5h session limit refreshed.',
    });
  });

  it('cada frase de falha do contrato vira o seu resultado', () => {
    expect(ompRedeemOutcome('fake@example.com (Anthropic): that reset was already redeemed.').outcome).toBe(
      'already_redeemed',
    );
    expect(ompRedeemOutcome('fake@example.com (Anthropic): no saved resets available to spend.').outcome).toBe(
      'no_credit',
    );
    expect(
      ompRedeemOutcome(
        'fake@example.com (Anthropic): nothing to reset right now — your covered limits are not constrained, so no credit was spent.',
      ).outcome,
    ).toBe('nothing_to_reset');
  });

  it('outras respostas (rede, login, conta não achada) são failed', () => {
    expect(
      ompRedeemOutcome(
        "fake@example.com (Anthropic): couldn't load this account's saved resets (network/auth) — nothing was spent, try again.",
      ).outcome,
    ).toBe('failed');
    expect(ompRedeemOutcome('Could not find the stored account anthropic/9').outcome).toBe('failed');
    expect(ompRedeemOutcome('').outcome).toBe('failed');
  });

  it('mensagem limitada a 500 caracteres', () => {
    const { message } = ompRedeemOutcome('x'.repeat(800));
    expect(message).toHaveLength(500);
  });
});

describe('resetSourceOf', () => {
  it('omp e codex têm fonte; os outros não', () => {
    expect(resetSourceOf('omp')).toBe('omp');
    expect(resetSourceOf('codex')).toBe('codex');
    expect(resetSourceOf('claude')).toBeUndefined();
    expect(resetSourceOf('agy')).toBeUndefined();
    expect(resetSourceOf('shell')).toBeUndefined();
    expect(resetSourceOf('constructor')).toBeUndefined();
  });
});

describe('codexResetsView', () => {
  const credit = (id: string, status: string, expiresAt: number | null) => ({ id, status, expiresAt });

  it('rateLimitResetCredits null: sem entradas e mensagem fixa', () => {
    expect(codexResetsView('a@b.c', null)).toEqual({
      entries: [],
      message: 'Nenhum reset salvo nesta conta',
      knownIds: [],
    });
  });

  it('usa o crédito disponível que expira antes como alvo, com a data em ISO', () => {
    const view = codexResetsView('a@b.c', {
      availableCount: 2,
      credits: [
        credit('late', 'available', 1_800_000_000),
        credit('soon', 'available', 1_700_000_000),
        credit('used', 'redeemed', null),
      ],
    });
    expect(view.message).toBeNull();
    expect(view.knownIds).toEqual(['late', 'soon']);
    expect(view.entries).toEqual([
      {
        target: 'soon',
        accountLabel: 'a@b.c',
        providerLabel: 'OpenAI Codex',
        available: 2,
        usable: 2,
        expiresAt: new Date(1_700_000_000 * 1000).toISOString(),
        note: null,
        active: true,
      },
    ]);
  });

  it('only available credits are known targets: redeeming, redeemed and unknown ones are not', () => {
    const view = codexResetsView('a@b.c', {
      availableCount: 1,
      credits: [
        credit('ok', 'available', 1_700_000_000),
        credit('busy', 'redeeming', 1_700_000_000),
        credit('spent', 'redeemed', null),
        credit('odd', 'unknown', null),
      ],
    });
    expect(view.knownIds).toEqual(['ok']);
    expect(view.entries[0]?.target).toBe('ok');
  });

  it('credits null: alvo next, usable vem da contagem, sem data', () => {
    const view = codexResetsView(null, { availableCount: 3, credits: null });
    expect(view.entries).toEqual([
      {
        target: 'next',
        accountLabel: 'Conta',
        providerLabel: 'OpenAI Codex',
        available: 3,
        usable: 3,
        expiresAt: null,
        note: null,
        active: true,
      },
    ]);
    expect(view.knownIds).toEqual([]);
  });

  it('sem crédito disponível: usable 0 e alvo next', () => {
    const view = codexResetsView('a@b.c', { availableCount: 0, credits: [credit('x', 'redeemed', null)] });
    expect(view.entries[0]).toMatchObject({ target: 'next', usable: 0, expiresAt: null });
  });
});
