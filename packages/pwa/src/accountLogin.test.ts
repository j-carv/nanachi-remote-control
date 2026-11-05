import type { AccountLoginState } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  canSendLoginCode,
  isFatalLoginError,
  isLoginFinal,
  isSecureLoginUrl,
  loginClosable,
  LOGIN_POLL_MS,
  loginStatusText,
  loginStepOf,
  startLoginFlow,
  type LoginFlowClient,
  type LoginStep,
} from './accountLogin.js';

const BASE: AccountLoginState = {
  accountId: 'a-1',
  state: 'waiting',
  url: 'https://claude.com/cai/oauth/authorize?code=true',
  userCode: null,
  needsCode: true,
  codeSent: false,
  output: '',
  error: null,
  account: null,
};

const state = (patch: Partial<AccountLoginState>): AccountLoginState => ({ ...BASE, ...patch });

describe('loginStepOf', () => {
  it('antes da primeira resposta: preparando', () => {
    expect(loginStepOf(null)).toEqual({ kind: 'starting' });
  });

  it('starting: ainda sem link', () => {
    expect(loginStepOf(state({ state: 'starting', url: null }))).toEqual({ kind: 'starting' });
  });

  it('waiting no Claude: link e campo do código', () => {
    expect(loginStepOf(state({}))).toEqual({
      kind: 'link',
      url: 'https://claude.com/cai/oauth/authorize?code=true',
      userCode: null,
      needsCode: true,
      codeSent: false,
    });
  });

  it('waiting no Codex: link e o código para digitar no navegador', () => {
    expect(
      loginStepOf(state({ url: 'https://auth.openai.com/codex/device', userCode: '0HKH-0YU99', needsCode: false })),
    ).toEqual({
      kind: 'link',
      url: 'https://auth.openai.com/codex/device',
      userCode: '0HKH-0YU99',
      needsCode: false,
      codeSent: false,
    });
  });

  it('código já enviado continua em "link" (o login ainda não terminou), com codeSent', () => {
    expect(loginStepOf(state({ codeSent: true }))).toMatchObject({ kind: 'link', codeSent: true });
  });

  it('verifying, succeeded, failed e cancelled', () => {
    expect(loginStepOf(state({ state: 'verifying' }))).toEqual({ kind: 'verifying' });
    expect(loginStepOf(state({ state: 'succeeded', account: 'pessoa@exemplo.com' }))).toEqual({
      kind: 'success',
      account: 'pessoa@exemplo.com',
    });
    expect(
      loginStepOf(state({ state: 'failed', error: 'o login falhou (código 1)', output: 'Error: login was refused' })),
    ).toEqual({ kind: 'failure', error: 'o login falhou (código 1)', output: 'Error: login was refused' });
    expect(loginStepOf(state({ state: 'cancelled' }))).toEqual({ kind: 'cancelled' });
  });

  it('failed sem texto de erro ganha um texto geral', () => {
    expect(loginStepOf(state({ state: 'failed', error: null }))).toMatchObject({ kind: 'failure', error: 'o login falhou' });
  });
});

describe('loginStatusText', () => {
  const text = (step: LoginStep) => loginStatusText(step);

  it('uma frase por etapa', () => {
    expect(text({ kind: 'starting' })).toBe('Preparando…');
    expect(text(loginStepOf(state({})))).toBe('Aguardando você entrar…');
    expect(text(loginStepOf(state({ codeSent: true })))).toBe('Código enviado. Aguardando o login terminar…');
    expect(text({ kind: 'verifying' })).toBe('Verificando…');
    expect(text({ kind: 'success', account: 'pessoa@exemplo.com' })).toBe('Conta conectada: pessoa@exemplo.com');
    expect(text({ kind: 'success', account: null })).toBe('Conta conectada');
    expect(text({ kind: 'cancelled' })).toBe('Login cancelado.');
  });

  it('falha: o motivo do daemon com a primeira letra maiúscula', () => {
    expect(text({ kind: 'failure', error: 'tempo esgotado', output: '' })).toBe('Tempo esgotado');
    expect(text({ kind: 'failure', error: 'o login falhou (código 1)', output: '' })).toBe('O login falhou (código 1)');
  });
});

describe('canSendLoginCode', () => {
  const waiting = loginStepOf(state({}));

  it('só no Claude, esperando o código, com algo digitado', () => {
    expect(canSendLoginCode(waiting, 'abc')).toBe(true);
    expect(canSendLoginCode(waiting, '   ')).toBe(false);
    expect(canSendLoginCode(waiting, '')).toBe(false);
  });

  it('não depois de enviado, nem no Codex, nem fora da espera', () => {
    expect(canSendLoginCode(loginStepOf(state({ codeSent: true })), 'abc')).toBe(false);
    expect(canSendLoginCode(loginStepOf(state({ needsCode: false })), 'abc')).toBe(false);
    expect(canSendLoginCode({ kind: 'starting' }, 'abc')).toBe(false);
    expect(canSendLoginCode({ kind: 'verifying' }, 'abc')).toBe(false);
  });
});

describe('isLoginFinal', () => {
  it('succeeded, failed e cancelled encerram o login', () => {
    expect(isLoginFinal('succeeded')).toBe(true);
    expect(isLoginFinal('failed')).toBe(true);
    expect(isLoginFinal('cancelled')).toBe(true);
    expect(isLoginFinal('starting')).toBe(false);
    expect(isLoginFinal('waiting')).toBe(false);
    expect(isLoginFinal('verifying')).toBe(false);
  });
});

/** Relógio manual: o teste decide quando os temporizadores disparam. */
function manualClock() {
  const timers: Array<{ id: number; ms: number; run(): void }> = [];
  let nextId = 1;
  return {
    schedule(run: () => void, ms: number): () => void {
      const id = nextId++;
      timers.push({ id, ms, run });
      return () => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index !== -1) timers.splice(index, 1);
      };
    },
    pending: () => timers.map((timer) => timer.ms),
    /** Dispara o próximo temporizador pendente. */
    fire() {
      const timer = timers.shift();
      if (timer === undefined) throw new Error('nenhum temporizador pendente');
      timer.run();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeOptions {
  start: AccountLoginState | Error;
  polls: Array<AccountLoginState | Error>;
  /** Answer of the code send. Default: the waiting state with the code sent. */
  send?: AccountLoginState | Error;
  /** Answers of the DELETEs, in order. Default: every one works. */
  cancels?: Array<'ok' | Error>;
}

function fakeClient(options: FakeOptions) {
  const calls: string[] = [];
  const polls = [...options.polls];
  const cancels = [...(options.cancels ?? [])];
  const client: LoginFlowClient = {
    startAccountLogin: async (agentId, accountId) => {
      calls.push(`start ${agentId}/${accountId}`);
      if (options.start instanceof Error) throw options.start;
      return options.start;
    },
    fetchAccountLogin: async (agentId, accountId) => {
      calls.push(`get ${agentId}/${accountId}`);
      const next = polls.shift();
      if (next === undefined) throw new Error('mais consultas do que o esperado');
      if (next instanceof Error) throw next;
      return next;
    },
    sendAccountLoginCode: async (agentId, accountId, code) => {
      calls.push(`code ${agentId}/${accountId} ${code}`);
      const answer = options.send ?? state({ codeSent: true });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    cancelAccountLogin: async (agentId, accountId) => {
      calls.push(`delete ${agentId}/${accountId}`);
      const answer = cancels.shift() ?? 'ok';
      if (answer instanceof Error) throw answer;
    },
  };
  return { client, calls };
}

describe('startLoginFlow', () => {
  it('começa o login, mostra o estado e consulta a cada 1,5 s até um estado final', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({
      start: state({ state: 'starting', url: null }),
      polls: [state({}), state({ state: 'verifying' }), state({ state: 'succeeded', account: 'pessoa@exemplo.com' })],
    });
    const seen: string[] = [];
    startLoginFlow(client, 'claude', 'a-1', { onState: (next) => seen.push(next.state), onError: () => undefined }, clock.schedule);

    await settle();
    expect(seen).toEqual(['starting']);
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);
    expect(LOGIN_POLL_MS).toBe(1500);

    clock.fire();
    await settle();
    clock.fire();
    await settle();
    clock.fire();
    await settle();

    expect(seen).toEqual(['starting', 'waiting', 'verifying', 'succeeded']);
    expect(clock.pending()).toEqual([]);
    expect(calls).toEqual(['start claude/a-1', 'get claude/a-1', 'get claude/a-1', 'get claude/a-1']);
  });

  it('o POST já devolve um estado final: não consulta nada', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({ state: 'failed', error: 'não foi possível iniciar o login: x' }), polls: [] });
    const seen: string[] = [];
    startLoginFlow(client, 'claude', 'a-1', { onState: (next) => seen.push(next.state), onError: () => undefined }, clock.schedule);
    await settle();
    expect(seen).toEqual(['failed']);
    expect(clock.pending()).toEqual([]);
    expect(calls).toEqual(['start claude/a-1']);
  });

  it('erro ao começar (409 login_in_progress): avisa e não consulta', async () => {
    const clock = manualClock();
    const conflict = new ApiError('unexpected', 409, null, 'login_in_progress');
    const { client } = fakeClient({ start: conflict, polls: [] });
    const errors: unknown[] = [];
    startLoginFlow(client, 'claude', 'a-1', { onState: () => undefined, onError: (error) => errors.push(error) }, clock.schedule);
    await settle();
    expect(errors).toEqual([conflict]);
    expect(clock.pending()).toEqual([]);
  });

  it('falha passageira na consulta (rede) é avisada e a consulta continua', async () => {
    const clock = manualClock();
    const network = new ApiError('network');
    const { client } = fakeClient({ start: state({}), polls: [network, state({ state: 'verifying' })] });
    const seen: string[] = [];
    const errors: unknown[] = [];
    const fatalFlags: boolean[] = [];
    startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push(next.state), onError: (error, isFatal) => (errors.push(error), fatalFlags.push(isFatal)) },
      clock.schedule,
    );
    await settle();
    clock.fire();
    await settle();
    expect(errors).toEqual([network]);
    expect(fatalFlags).toEqual([false]);
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);
    clock.fire();
    await settle();
    expect(seen).toEqual(['waiting', 'verifying']);
  });

  it('404 e 401 na consulta encerram: o login sumiu ou o acesso acabou', async () => {
    for (const fatal of [new ApiError('not_found', 404, null, 'not_found'), new ApiError('unauthorized', 401)]) {
      const clock = manualClock();
      const { client } = fakeClient({ start: state({}), polls: [fatal] });
      const errors: unknown[] = [];
      const fatalFlags: boolean[] = [];
      startLoginFlow(
        client,
        'claude',
        'a-1',
        { onState: () => undefined, onError: (error, isFatal) => (errors.push(error), fatalFlags.push(isFatal)) },
        clock.schedule,
      );
      await settle();
      clock.fire();
      await settle();
      expect(errors).toEqual([fatal]);
      expect(fatalFlags).toEqual([true]);
      expect(clock.pending()).toEqual([]);
    }
  });

  it('abandonar cancela o temporizador e descarta a resposta que estava em voo', async () => {
    const clock = manualClock();
    const { client } = fakeClient({ start: state({}), polls: [state({ state: 'verifying' })] });
    const seen: string[] = [];
    const flow = startLoginFlow(client, 'claude', 'a-1', { onState: (next) => seen.push(next.state), onError: () => undefined }, clock.schedule);
    await settle();
    clock.fire(); // a consulta sai
    flow.abandon(); // ... e o usuário fecha a folha antes da resposta
    await settle();
    expect(seen).toEqual(['waiting']);
    expect(clock.pending()).toEqual([]);
  });

  it('abandonar antes do POST responder não deixa nada agendado', async () => {
    const clock = manualClock();
    const { client } = fakeClient({ start: state({}), polls: [] });
    const seen: string[] = [];
    const flow = startLoginFlow(client, 'claude', 'a-1', { onState: (next) => seen.push(next.state), onError: () => undefined }, clock.schedule);
    flow.abandon();
    await settle();
    expect(seen).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });

  it('nunca tem duas consultas ao mesmo tempo: o próximo tempo só conta depois da resposta', async () => {
    const clock = manualClock();
    let release: (value: AccountLoginState) => void = () => undefined;
    let concurrent = 0;
    let peak = 0;
    const client: LoginFlowClient = {
      startAccountLogin: async () => state({}),
      sendAccountLoginCode: async () => state({}),
      cancelAccountLogin: async () => undefined,
      fetchAccountLogin: () =>
        new Promise<AccountLoginState>((resolve) => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          release = (value) => {
            concurrent -= 1;
            resolve(value);
          };
        }),
    };
    startLoginFlow(client, 'claude', 'a-1', { onState: () => undefined, onError: () => undefined }, clock.schedule);
    await settle();
    clock.fire();
    await settle();
    expect(clock.pending()).toEqual([]); // consulta em voo: nada agendado
    release(state({ state: 'verifying' }));
    await settle();
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);
    expect(peak).toBe(1);
  });
});

describe('isSecureLoginUrl', () => {
  it('só https://', () => {
    expect(isSecureLoginUrl('https://claude.com/cai/oauth/authorize?code=true')).toBe(true);
    for (const url of ['http://claude.com', 'javascript:alert(1)', 'HTTPS://claude.com', ' https://x', '', 'claude.com']) {
      expect(isSecureLoginUrl(url)).toBe(false);
    }
  });
});

describe('loginClosable', () => {
  const link = loginStepOf(state({}));

  it('enquanto o login corre só se fecha cancelando', () => {
    expect(loginClosable({ kind: 'starting' }, false)).toBe(false);
    expect(loginClosable(link, false)).toBe(false);
    expect(loginClosable({ kind: 'verifying' }, false)).toBe(false);
  });

  it('login terminado se fecha direto', () => {
    expect(loginClosable({ kind: 'success', account: null }, false)).toBe(true);
    expect(loginClosable({ kind: 'failure', error: 'x', output: '' }, false)).toBe(true);
    expect(loginClosable({ kind: 'cancelled' }, false)).toBe(true);
  });

  it('login que não dá mais para alcançar (não começou, 404 ou 401) se fecha direto, em qualquer etapa', () => {
    expect(loginClosable({ kind: 'starting' }, true)).toBe(true);
    expect(loginClosable(link, true)).toBe(true);
    expect(loginClosable({ kind: 'verifying' }, true)).toBe(true);
  });
});

describe('isFatalLoginError', () => {
  it('404 e 401 não têm volta; o resto pode passar', () => {
    expect(isFatalLoginError(new ApiError('not_found', 404, null, 'not_found'))).toBe(true);
    expect(isFatalLoginError(new ApiError('unauthorized', 401))).toBe(true);
    expect(isFatalLoginError(new ApiError('network'))).toBe(false);
    expect(isFatalLoginError(new ApiError('unexpected', 409, null, 'login_in_progress'))).toBe(false);
    expect(isFatalLoginError(new Error('x'))).toBe(false);
  });
});

const quiet = { onState: () => undefined, onError: () => undefined };

describe('startLoginFlow: abandonar (a folha sumiu)', () => {
  it('com o login em andamento manda um DELETE e não deixa temporizador', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);

    flow.abandon();
    await settle();
    expect(clock.pending()).toEqual([]);
    expect(calls).toEqual(['start claude/a-1', 'delete claude/a-1']);
  });

  it('antes do POST responder espera por ele e só então apaga o login', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    flow.abandon();
    expect(calls).toEqual(['start claude/a-1']);
    await settle();
    expect(calls).toEqual(['start claude/a-1', 'delete claude/a-1']);
    expect(clock.pending()).toEqual([]);
  });

  it('depois de um estado final não manda DELETE (nada a cancelar)', async () => {
    for (const final of ['succeeded', 'failed', 'cancelled'] as const) {
      const clock = manualClock();
      const { client, calls } = fakeClient({ start: state({}), polls: [state({ state: final })] });
      const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
      await settle();
      clock.fire();
      await settle();
      flow.abandon();
      await settle();
      expect(calls).toEqual(['start claude/a-1', 'get claude/a-1']);
    }
  });

  it('o POST que já devolve um estado final também não manda DELETE', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({ state: 'failed', error: 'x' }), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    flow.abandon();
    await settle();
    expect(calls).toEqual(['start claude/a-1']);
  });

  it('o POST que falhou não manda DELETE', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: new ApiError('network'), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    flow.abandon();
    await settle();
    expect(calls).toEqual(['start claude/a-1']);
  });

  it('depois de uma falha fatal na consulta (404) não manda DELETE', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({
      start: state({}),
      polls: [new ApiError('not_found', 404, null, 'not_found')],
    });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();
    clock.fire();
    await settle();
    flow.abandon();
    await settle();
    expect(calls).toEqual(['start claude/a-1', 'get claude/a-1']);
  });

  it('abandonar duas vezes manda um DELETE só; falha do DELETE não vira erro solto', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [], cancels: [new ApiError('network')] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();
    flow.abandon();
    flow.abandon();
    await settle();
    expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(1);
  });
});

describe('startLoginFlow: cancelar', () => {
  it('manda o DELETE, para de consultar e não repete o DELETE ao abandonar depois', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();

    await flow.cancel();
    expect(clock.pending()).toEqual([]);
    flow.abandon();
    await settle();
    expect(calls).toEqual(['start claude/a-1', 'delete claude/a-1']);
  });

  it('404 no DELETE: o login já não existe, conta como cancelado', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({
      start: state({}),
      polls: [],
      cancels: [new ApiError('not_found', 404, null, 'not_found')],
    });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();
    await expect(flow.cancel()).resolves.toBeUndefined();
    expect(calls).toEqual(['start claude/a-1', 'delete claude/a-1']);
  });

  it('outra falha do DELETE é devolvida, a consulta continua e dá para tentar de novo', async () => {
    const clock = manualClock();
    const failure = new ApiError('network');
    const { client, calls } = fakeClient({
      start: state({}),
      polls: [state({ state: 'verifying' })],
      cancels: [failure, 'ok'],
    });
    const seen: string[] = [];
    const flow = startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push(next.state), onError: () => undefined },
      clock.schedule,
    );
    await settle();

    await expect(flow.cancel()).rejects.toBe(failure);
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);
    clock.fire();
    await settle();
    expect(seen).toEqual(['waiting', 'verifying']);

    await expect(flow.cancel()).resolves.toBeUndefined();
    expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(2);
    expect(clock.pending()).toEqual([]);
  });

  it('dois toques seguidos mandam um DELETE só', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();
    await Promise.all([flow.cancel(), flow.cancel()]);
    expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(1);
  });

  it('antes do POST responder espera por ele', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    const done = flow.cancel();
    expect(calls).toEqual(['start claude/a-1']);
    await done;
    expect(calls).toEqual(['start claude/a-1', 'delete claude/a-1']);
  });

  it('login que já terminou não manda DELETE', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({ state: 'succeeded', account: 'a@b.c' }), polls: [] });
    const flow = startLoginFlow(client, 'claude', 'a-1', quiet, clock.schedule);
    await settle();
    await flow.cancel();
    expect(calls).toEqual(['start claude/a-1']);
  });
});

describe('startLoginFlow: enviar o código', () => {
  const sent = state({ codeSent: true });

  it('manda o código, mostra o estado devolvido e não cria uma segunda fila de consultas', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({ start: state({}), polls: [], send: sent });
    const seen: Array<{ state: string; codeSent: boolean }> = [];
    const flow = startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push({ state: next.state, codeSent: next.codeSent }), onError: () => undefined },
      clock.schedule,
    );
    await settle();
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);

    await flow.sendCode('abc123');
    expect(calls).toContain('code claude/a-1 abc123');
    expect(seen.at(-1)).toEqual({ state: 'waiting', codeSent: true });
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);
  });

  it('uma consulta que saiu antes do código e responde "sem código" é descartada', async () => {
    const clock = manualClock();
    const { client } = fakeClient({
      start: state({}),
      polls: [state({ codeSent: false }), state({ codeSent: true }), state({ state: 'verifying', codeSent: false })],
      send: sent,
    });
    const seen: Array<{ state: string; codeSent: boolean }> = [];
    const flow = startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push({ state: next.state, codeSent: next.codeSent }), onError: () => undefined },
      clock.schedule,
    );
    await settle();
    await flow.sendCode('abc123');
    seen.length = 0;

    clock.fire(); // resposta velha: waiting sem código
    await settle();
    expect(seen).toEqual([]);
    expect(clock.pending()).toEqual([LOGIN_POLL_MS]);

    clock.fire(); // waiting com o código enviado
    await settle();
    expect(seen).toEqual([{ state: 'waiting', codeSent: true }]);

    clock.fire(); // outras etapas passam, mesmo sem a marca
    await settle();
    expect(seen.at(-1)).toEqual({ state: 'verifying', codeSent: false });
  });

  it('antes de enviar nada, a resposta "sem código" é mostrada como sempre', async () => {
    const clock = manualClock();
    const { client } = fakeClient({ start: state({}), polls: [state({ codeSent: false })] });
    const seen: boolean[] = [];
    startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push(next.codeSent), onError: () => undefined },
      clock.schedule,
    );
    await settle();
    clock.fire();
    await settle();
    expect(seen).toEqual([false, false]);
  });

  it('o envio que falha devolve o erro, não muda nada e não passa a descartar consultas', async () => {
    const clock = manualClock();
    const refused = new ApiError('unexpected', 409, null, 'invalid_state');
    const { client } = fakeClient({ start: state({}), polls: [state({ codeSent: false })], send: refused });
    const seen: boolean[] = [];
    const flow = startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push(next.codeSent), onError: () => undefined },
      clock.schedule,
    );
    await settle();
    await expect(flow.sendCode('abc')).rejects.toBe(refused);
    expect(seen).toEqual([false]);
    clock.fire();
    await settle();
    expect(seen).toEqual([false, false]);
  });

  it('a resposta do envio com um estado final encerra: nada de nova consulta nem de DELETE', async () => {
    const clock = manualClock();
    const { client, calls } = fakeClient({
      start: state({}),
      polls: [],
      send: state({ state: 'succeeded', codeSent: true, account: 'a@b.c' }),
    });
    const seen: string[] = [];
    const flow = startLoginFlow(
      client,
      'claude',
      'a-1',
      { onState: (next) => seen.push(next.state), onError: () => undefined },
      clock.schedule,
    );
    await settle();
    await flow.sendCode('abc');
    expect(seen.at(-1)).toBe('succeeded');
    expect(clock.pending()).toEqual([]);
    flow.abandon();
    await settle();
    expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(0);
  });
});
