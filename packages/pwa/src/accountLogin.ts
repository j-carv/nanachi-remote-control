import type { AccountLoginState } from '@nanachi/shared';
import { ApiError, type ApiClient } from './api.js';

/** How often the login sheet asks the daemon for the state of the login. */
export const LOGIN_POLL_MS = 1500;

/** What the login sheet shows. It follows the daemon's state, plus "starting" before the first answer. */
export type LoginStep =
  | { kind: 'starting' }
  /** There is a link to open (and a one-time code to type, or a code to paste back). */
  | { kind: 'link'; url: string; userCode: string | null; needsCode: boolean; codeSent: boolean }
  | { kind: 'verifying' }
  | { kind: 'success'; account: string | null }
  | { kind: 'failure'; error: string; output: string }
  | { kind: 'cancelled' };

const GENERIC_FAILURE = 'o login falhou';

/** The sheet's step for the daemon's login state (`null`: the first answer has not arrived). */
export function loginStepOf(login: AccountLoginState | null): LoginStep {
  if (login === null) return { kind: 'starting' };
  switch (login.state) {
    case 'starting':
      return { kind: 'starting' };
    case 'waiting':
      // `waiting` means the link was printed; without it there is nothing to show yet.
      if (login.url === null) return { kind: 'starting' };
      return { kind: 'link', url: login.url, userCode: login.userCode, needsCode: login.needsCode, codeSent: login.codeSent };
    case 'verifying':
      return { kind: 'verifying' };
    case 'succeeded':
      return { kind: 'success', account: login.account };
    case 'failed':
      return { kind: 'failure', error: login.error ?? GENERIC_FAILURE, output: login.output };
    case 'cancelled':
      return { kind: 'cancelled' };
  }
}

function capitalized(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The status line of a step. */
export function loginStatusText(step: LoginStep): string {
  switch (step.kind) {
    case 'starting':
      return 'Preparando…';
    case 'link':
      return step.codeSent ? 'Código enviado. Aguardando o login terminar…' : 'Aguardando você entrar…';
    case 'verifying':
      return 'Verificando…';
    case 'success':
      return step.account === null ? 'Conta conectada' : `Conta conectada: ${step.account}`;
    case 'failure':
      return capitalized(step.error);
    case 'cancelled':
      return 'Login cancelado.';
  }
}

/** The code field's "Enviar" works while the login waits for a code that was not sent yet and something is typed. */
export function canSendLoginCode(step: LoginStep, draft: string): boolean {
  return step.kind === 'link' && step.needsCode && !step.codeSent && draft.trim() !== '';
}

/** The sign-in link is only offered when it is a plain https URL. */
export function isSecureLoginUrl(url: string): boolean {
  return url.startsWith('https://');
}

/**
 * The sheet may just be closed (no login to cancel): the login is over, or it can no longer be reached (`unreachable`:
 * it never started, the daemon forgot it, or this phone lost its access). While it runs, closing means cancelling it.
 */
export function loginClosable(step: LoginStep, unreachable: boolean): boolean {
  return unreachable || step.kind === 'success' || step.kind === 'failure' || step.kind === 'cancelled';
}

/** `succeeded`, `failed` and `cancelled` are the end of a login: the daemon changes nothing after them. */
export function isLoginFinal(state: AccountLoginState['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/** The part of the API client the login flow uses. */
export type LoginFlowClient = Pick<
  ApiClient,
  'startAccountLogin' | 'fetchAccountLogin' | 'sendAccountLoginCode' | 'cancelAccountLogin'
>;

/** Runs `callback` after `ms` and returns the function that cancels it. */
export type LoginSchedule = (callback: () => void, ms: number) => () => void;

export interface LoginFlowHandlers {
  onState(login: AccountLoginState): void;
  /**
   * The login could not start or a poll failed. `fatal`: it can never work later (the daemon forgot
   * the login, or this phone lost its access), so the polling has stopped and there is nothing left to cancel.
   * Otherwise a failed poll is reported and the polling goes on.
   */
  onError(error: unknown, fatal: boolean): void;
}

const browserSchedule: LoginSchedule = (callback, ms) => {
  const timer = window.setTimeout(callback, ms);
  return () => window.clearTimeout(timer);
};

/** An error after which the login can never be followed or cancelled: the daemon forgot it, or the access is gone. */
export function isFatalLoginError(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'not_found' || error.kind === 'unauthorized');
}

/** What the sheet does with a login it opened. */
export interface LoginFlow {
  /**
   * Sends the code the user pasted and applies the state it answers with. Throws the `ApiError` when it fails. After
   * it worked, a poll that still says "waiting, no code yet" is an answer from before the send and is dropped, so the
   * empty form does not come back.
   */
  sendCode(code: string): Promise<void>;
  /**
   * "Cancelar": deletes the login in the PC and stops following it. A login the daemon no longer knows (404) counts as
   * cancelled. Any other failure throws and leaves the flow running, so the sheet can say so and try again. Nothing is
   * sent when the login already ended or never started.
   */
  cancel(): Promise<void>;
  /**
   * The sheet is gone (unmounted, closed by the back gesture, navigation): stops following the login and, when it has not
   * ended, deletes it in the PC without waiting and without reporting. Answers that arrive afterwards are dropped.
   */
  abandon(): void;
}

/**
 * Starts the login of an account and follows it: one POST, then a GET every `LOGIN_POLL_MS` until a final state. The
 * next GET is scheduled after the previous answer, so there are never two in flight. A login counts as ended after a
 * final state or a fatal poll error: from then on nothing is polled and nothing is cancelled.
 */
export function startLoginFlow(
  client: LoginFlowClient,
  agentId: string,
  accountId: string,
  handlers: LoginFlowHandlers,
  schedule: LoginSchedule = browserSchedule,
): LoginFlow {
  let active = true;
  let ended = false;
  let codeWasSent = false;
  let cancelTimer: (() => void) | null = null;
  let cancelling: Promise<void> | null = null;

  function stopPolling(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  /** Shows `login` and, after a final state, ends the flow. Returns false when it was dropped. */
  function apply(login: AccountLoginState, fromPoll: boolean): boolean {
    if (!active) return false;
    // A poll that left before the code went out can answer after it: it says "waiting" and "no code yet".
    if (fromPoll && codeWasSent && login.state === 'waiting' && !login.codeSent) return false;
    handlers.onState(login);
    if (isLoginFinal(login.state)) {
      ended = true;
      stopPolling();
    }
    return true;
  }

  function schedulePoll(): void {
    if (!active || ended) return;
    cancelTimer = schedule(poll, LOGIN_POLL_MS);
  }

  function poll(): void {
    cancelTimer = null;
    client.fetchAccountLogin(agentId, accountId).then(
      (login) => {
        apply(login, true);
        schedulePoll();
      },
      (error: unknown) => {
        if (!active) return;
        const fatal = isFatalLoginError(error);
        if (fatal) ended = true;
        handlers.onError(error, fatal);
        if (!fatal) schedulePoll();
      },
    );
  }

  /** Settles once the POST has answered: true when the daemon started a login, false when the POST failed. */
  const startedOk: Promise<boolean> = client.startAccountLogin(agentId, accountId).then(
    (login) => {
      // An answer that comes after abandon still tells whether there is something to delete.
      if (isLoginFinal(login.state)) ended = true;
      if (apply(login, false)) schedulePoll();
      return true;
    },
    (error: unknown) => {
      if (active) handlers.onError(error, false);
      return false;
    },
  );

  async function deleteLogin(): Promise<void> {
    if (!(await startedOk) || ended) return;
    try {
      await client.cancelAccountLogin(agentId, accountId);
    } catch (error) {
      // The daemon no longer has this login: it is as cancelled as it can be.
      if (!(error instanceof ApiError && error.kind === 'not_found')) throw error;
    }
  }

  return {
    async sendCode(code) {
      const login = await client.sendAccountLoginCode(agentId, accountId, code);
      codeWasSent = true;
      apply(login, false);
    },

    cancel() {
      if (cancelling !== null) return cancelling;
      const attempt = deleteLogin().then(
        () => {
          active = false;
          ended = true;
          stopPolling();
        },
        (error: unknown) => {
          cancelling = null;
          throw error;
        },
      );
      cancelling = attempt;
      return attempt;
    },

    abandon() {
      const needsDelete = active && !ended;
      active = false;
      stopPolling();
      if (needsDelete) void deleteLogin().catch(() => undefined);
    },
  };
}
