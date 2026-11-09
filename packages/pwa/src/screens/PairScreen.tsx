import { useEffect, useId, useState, type FormEvent } from 'react';
import type { TFunction } from 'i18next';
import { ChevronLeft, CircleExclamationPoint, Link2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PairResponse } from '@nanachi/shared';
import { ApiError, pair, pairTailscale, pairTailscaleStatus } from '../api.js';
import { describeError as describeApiError } from '../errorMessages.js';
import { isSafePairingBaseUrl, normalizeBaseUrl } from '../machines.js';
import { PAIR_CODE_PATTERN } from '../pairLink.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Screen } from '../components/Screen.js';

interface PairScreenProps {
  initialBaseUrl: string;
  canCancel: boolean;
  onCancel(): void;
  onPaired(result: PairResponse, baseUrl: string): void;
  /** Code to fill in, when a pair link could not pair with it (see App.tsx). */
  initialCode?: string | undefined;
  /** Error of that attempt. It is described in the current language, so it is kept as the error, not as text. */
  initialError?: unknown;
}

/** Espera o usuário terminar de digitar o endereço antes de perguntar ao PC pelo Tailscale. */
const TAILSCALE_CHECK_DELAY_MS = 300;

function describeError(error: unknown, t: TFunction<'pairing'>): string {
  if (error instanceof ApiError && error.kind === 'invalid_input') return t('errors.invalidInput');
  if (error instanceof ApiError) return describeApiError(error);
  return t('errors.unexpected');
}

/** Login do Tailscale que o PC aceita para este aparelho, ou null quando não vale (ou não dá para saber). */
function useTailscaleLogin(baseUrl: string): string | null {
  const [login, setLogin] = useState<string | null>(null);

  useEffect(() => {
    setLogin(null);
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === null || !isSafePairingBaseUrl(normalized, window.location.origin)) return;

    let active = true;
    const timer = window.setTimeout(() => {
      pairTailscaleStatus(normalized).then(
        (status) => {
          if (active && status.available && status.login !== undefined) setLogin(status.login);
        },
        () => undefined,
      );
    }, TAILSCALE_CHECK_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [baseUrl]);

  return login;
}

export function PairScreen({ initialBaseUrl, canCancel, onCancel, onPaired, initialCode, initialError }: PairScreenProps) {
  const { t } = useTranslation('pairing');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [code, setCode] = useState(initialCode ?? '');
  const [deviceName, setDeviceName] = useState(() => t('defaultDeviceName'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    initialError === undefined ? null : describeError(initialError, t),
  );
  const tailscaleLogin = useTailscaleLogin(baseUrl);
  const urlId = useId();
  const codeId = useId();
  const nameId = useId();

  /** Endereço válido e seguro para pareamento, ou a mensagem que explica por que não. */
  function checkedBaseUrl(): string | null {
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === null) {
      setError(t('errors.addressScheme'));
      return null;
    }
    if (!isSafePairingBaseUrl(normalized, window.location.origin)) {
      setError(t('errors.https'));
      return null;
    }
    return normalized;
  }

  async function handleTailscale() {
    if (submitting) return;
    const normalized = checkedBaseUrl();
    if (normalized === null) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await pairTailscale({ baseUrl: normalized, deviceName });
      onPaired(result, normalized);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.kind === 'forbidden' ? t('errors.tailscaleUnavailable') : describeError(caught, t));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const normalized = checkedBaseUrl();
    if (normalized === null) return;
    if (!PAIR_CODE_PATTERN.test(code)) {
      setError(t('errors.codeLength'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await pair({ baseUrl: normalized, code, deviceName });
      onPaired(result, normalized);
    } catch (caught) {
      setError(describeError(caught, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen className="gap-6">
      <header className="flex flex-col gap-2 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-base leading-6 text-muted-foreground">
          {tailscaleLogin === null ? t('intro') : t('introTailscale')}
        </p>
      </header>

      <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor={urlId}>{t('fields.address')}</Label>
          <Input
            id={urlId}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={nameId}>{t('fields.deviceName')}</Label>
          <Input
            id={nameId}
            type="text"
            maxLength={64}
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            required
          />
        </div>

        {error !== null && (
          <p role="alert" className="flex animate-enter gap-3 rounded-lg bg-destructive/10 p-4 text-sm leading-5">
            <CircleExclamationPoint className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
            {error}
          </p>
        )}

        {tailscaleLogin !== null && (
          <div className="flex flex-col gap-3">
            <Button type="button" size="wide" onClick={() => void handleTailscale()} disabled={submitting}>
              <ShieldCheck aria-hidden="true" />
              {submitting ? t('tailscale.signingIn') : t('tailscale.signIn')}
            </Button>
            <p className="text-center text-sm text-muted-foreground">{t('tailscale.connectedAs', { login: tailscaleLogin })}</p>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              {t('tailscale.or')}
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor={codeId}>{t('fields.code')}</Label>
          <Input
            id={codeId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]{6}"
            placeholder="000000"
            className="h-12 font-mono text-xl tracking-[0.3em]"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            required={tailscaleLogin === null}
          />
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <Button type="submit" size="wide" variant={tailscaleLogin === null ? 'default' : 'secondary'} disabled={submitting}>
            <Link2 aria-hidden="true" />
            {submitting && tailscaleLogin === null ? t('submitting') : t('submit')}
          </Button>
          {canCancel && (
            <Button variant="ghost" size="wide" type="button" onClick={onCancel} disabled={submitting}>
              <ChevronLeft aria-hidden="true" />
              {t('actions.back', { ns: 'common' })}
            </Button>
          )}
        </div>
      </form>
    </Screen>
  );
}
