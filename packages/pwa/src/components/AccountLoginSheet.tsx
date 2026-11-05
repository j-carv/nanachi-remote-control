import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, CircleCheck, ExternalLink, LoaderCircle } from 'lucide-react';
import type { AccountLoginState } from '@nanachi/shared';
import {
  canSendLoginCode,
  isFatalLoginError,
  isLoginFinal,
  isSecureLoginUrl,
  loginClosable,
  loginStatusText,
  loginStepOf,
  startLoginFlow,
  type LoginFlow,
  type LoginStep,
} from '../accountLogin.js';
import type { ApiClient } from '../api.js';
import { describeAccountError, describeLoginPollError } from '../errorMessages.js';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyButton } from './CopyButton.js';
import { ErrorNotice } from './ErrorNotice.js';
import { useModalOverlay } from './useModalOverlay.js';

/** How long "Conta conectada" stays on screen before the sheet closes on its own. */
const SUCCESS_CLOSE_MS = 1600;

interface AccountLoginBodyProps {
  /** Null when the login never started: only `problem` is shown. */
  step: LoginStep | null;
  /** The code field (Claude): what is typed, whether it is being sent, and why the last send failed. */
  code: string;
  sending: boolean;
  codeProblem: string | null;
  /** A failed poll or start, as text. Shown under the status. */
  problem: string | null;
  onCodeChange(code: string): void;
  onSendCode(): void;
}

/** The status line: a spinner while the login moves, a check mark when it worked. */
function LoginStatus({ step }: { step: LoginStep }) {
  const working = step.kind === 'starting' || step.kind === 'link' || step.kind === 'verifying';
  return (
    <p
      data-slot="login-status"
      data-step={step.kind}
      role="status"
      className="flex items-center gap-2 text-base text-foreground"
    >
      {working && (
        <LoaderCircle className="size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
      )}
      {step.kind === 'success' && <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />}
      <span className="min-w-0 [overflow-wrap:anywhere]">{loginStatusText(step)}</span>
    </p>
  );
}

/** What the login sheet shows for a step. Kept apart from the sheet so the markup can be rendered without a Drawer. */
export function AccountLoginBody({ step, code, sending, codeProblem, problem, onCodeChange, onSendCode }: AccountLoginBodyProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step !== null && canSendLoginCode(step, code) && !sending) onSendCode();
  }

  return (
    <div data-slot="login-body" className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-2">
      {step?.kind === 'link' && (
        <>
          <p className="text-base leading-6 text-foreground/90">Abra o link e entre com a conta que você quer adicionar</p>
          <div className="flex flex-col gap-2">
            {isSecureLoginUrl(step.url) && (
              <div className="flex gap-2">
                <Button asChild className="flex-1">
                  <a data-slot="login-link" href={step.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Abrir link
                  </a>
                </Button>
                <CopyButton text={step.url} label="Copiar link" />
              </div>
            )}
            {step.needsCode && (
              <p className="text-sm text-muted-foreground">O PC também pode abrir uma aba de login; pode ignorar.</p>
            )}
          </div>

          {step.userCode !== null && (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm text-muted-foreground">Digite este código na página</span>
                <span data-slot="login-user-code" className="font-mono text-3xl font-semibold tracking-widest select-all">
                  {step.userCode}
                </span>
              </div>
              <CopyButton text={step.userCode} label="Copiar código" />
            </div>
          )}

          {step.needsCode && !step.codeSent && (
            <form onSubmit={submit} className="flex flex-col gap-2">
              <Label htmlFor="login-code" className="text-base leading-6 font-normal text-foreground/90">
                Depois de entrar, copie o código que aparece e cole aqui
              </Label>
              <div className="flex gap-2">
                <Input
                  id="login-code"
                  data-slot="login-code"
                  value={code}
                  disabled={sending}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="send"
                  className="font-mono"
                  onChange={(event) => onCodeChange(event.target.value)}
                />
                <Button type="submit" disabled={sending || !canSendLoginCode(step, code)}>
                  {sending ? 'Enviando…' : 'Enviar'}
                </Button>
              </div>
              {codeProblem !== null && <ErrorNotice message={codeProblem} />}
            </form>
          )}
        </>
      )}

      {step === null ? null : step.kind === 'failure' ? (
        <>
          <ErrorNotice message={loginStatusText(step)} />
          {step.output.trim() !== '' && (
            <details data-slot="login-output" className="group text-sm">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
                Ver a saída do login
                <ChevronDown
                  className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </summary>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {step.output}
              </pre>
            </details>
          )}
        </>
      ) : (
        <LoginStatus step={step} />
      )}

      {problem !== null && <ErrorNotice message={problem} />}
    </div>
  );
}

interface AccountLoginSheetProps {
  api: ApiClient;
  agentId: string;
  agentLabel: string;
  accountId: string;
  accountLabel: string;
  /** The account is connected: refresh the list. Called once, as soon as the login succeeds. */
  onSucceeded(): void;
  onClose(): void;
}

/**
 * Login of one account (docs/PLAN.md, "several accounts per agent"): opens the login in the daemon and follows it every
 * 1,5 s. Claude: link, then the code the user pastes back. Codex: link and a one-time code.
 *
 * While the login runs the sheet only closes by cancelling it: "Cancelar", Esc and the back gesture (through
 * `useModalOverlay`) all delete the login in the PC, and so does leaving the sheet any other way (it unmounting). A
 * finished login, a login that never started, and one the daemon forgot (404) or this phone lost access to can just be
 * closed. A finished login closes by itself after success.
 */
export function AccountLoginSheet({ api, agentId, agentLabel, accountId, accountLabel, onSucceeded, onClose }: AccountLoginSheetProps) {
  const [login, setLogin] = useState<AccountLoginState | null>(null);
  /** The error of the start or of the last poll. Cleared by the next state that arrives. */
  const [error, setError] = useState<unknown>(null);
  /** The login can never be followed again (the daemon forgot it, or the access is gone): there is nothing to cancel. */
  const [fatal, setFatal] = useState(false);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [codeError, setCodeError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const flow = useRef<LoginFlow | null>(null);
  const onSucceededRef = useRef(onSucceeded);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onSucceededRef.current = onSucceeded;
    onCloseRef.current = onClose;
  });
  // Esc reaches both the drawer and `useModalOverlay`, and the success timer can meet a tap: the parent is told once.
  const closedOnce = useRef(false);
  function closeSheet() {
    if (closedOnce.current) return;
    closedOnce.current = true;
    onCloseRef.current();
  }

  useEffect(() => {
    const started = startLoginFlow(api, agentId, accountId, {
      onState: (next) => {
        setLogin(next);
        setError(null);
        // A login that ended on its own after a cancel that failed: that failure is no longer the news.
        if (isLoginFinal(next.state)) setCancelError(null);
      },
      onError: (caught, isFatal) => {
        setError(caught);
        if (isFatal) setFatal(true);
      },
    });
    flow.current = started;
    // Leaving by any road (unmount) deletes a login that is still running; `abandon` does nothing for a finished one.
    return () => {
      flow.current = null;
      started.abandon();
    };
  }, [api, agentId, accountId]);

  const step = loginStepOf(login);
  // The login never started (409 login_in_progress, unknown account): there is nothing to cancel.
  const startFailed = login === null && error !== null;
  const closable = loginClosable(step, startFailed || fatal);

  useEffect(() => {
    if (step.kind !== 'success') return undefined;
    onSucceededRef.current();
    const timer = window.setTimeout(closeSheet, SUCCESS_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [step.kind]);

  async function sendCode() {
    const current = flow.current;
    if (current === null || !canSendLoginCode(step, code) || sending) return;
    setSending(true);
    setCodeError(null);
    try {
      await current.sendCode(code);
      setCode('');
    } catch (caught) {
      setCodeError(caught);
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    const current = flow.current;
    if (current === null || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await current.cancel();
      closeSheet();
    } catch (caught) {
      // The PC did not confirm: the login may still be running. Say so instead of closing as if it were cancelled.
      setCancelError(caught);
      if (isFatalLoginError(caught)) setFatal(true);
      setCancelling(false);
    }
  }

  // Esc and the back gesture: close a login that is over, cancel one that is running.
  useModalOverlay(() => {
    if (cancelling) return;
    if (closable) closeSheet();
    else void cancel();
  });

  const problem =
    cancelError !== null
      ? describeAccountError(cancelError)
      : error === null
        ? null
        : startFailed
          ? describeAccountError(error)
          : describeLoginPollError(error);

  return (
    <Drawer
      open
      dismissible={closable && !cancelling}
      onOpenChange={(open) => {
        if (!open && closable && !cancelling) closeSheet();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Entrar na conta</DrawerTitle>
          <DrawerDescription>
            {agentLabel} · {accountLabel}
          </DrawerDescription>
        </DrawerHeader>
        <AccountLoginBody
          step={startFailed || fatal ? null : step}
          code={code}
          sending={sending}
          codeProblem={codeError === null ? null : describeAccountError(codeError)}
          problem={problem}
          onCodeChange={setCode}
          onSendCode={() => void sendCode()}
        />
        <DrawerFooter className="flex-row">
          {closable ? (
            <Button variant="secondary" className="flex-1" onClick={closeSheet}>
              Fechar
            </Button>
          ) : (
            <Button variant="secondary" className="flex-1" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? 'Cancelando…' : 'Cancelar'}
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
