import { useState, type FormEvent } from 'react';
import type { PairResponse } from '@nanachi/shared';
import { ApiError, pair } from '../api.js';
import { describeError as describeApiError } from '../errorMessages.js';
import { isSafePairingBaseUrl, normalizeBaseUrl } from '../machines.js';

interface PairScreenProps {
  initialBaseUrl: string;
  canCancel: boolean;
  onCancel(): void;
  onPaired(result: PairResponse, baseUrl: string): void;
}

const DEFAULT_DEVICE_NAME = 'iPhone';
const CODE_PATTERN = /^[0-9]{6}$/;

const PAIR_INPUT_TEXT = 'Revise o endereço, o código (6 dígitos) e o nome do dispositivo.';
const PAIR_HTTPS_TEXT =
  'Use https:// no endereço do PC (ex.: https://pc-sala.seu-tailnet.ts.net). http:// só vale para localhost, 127.0.0.1 ou a própria origem desta app.';

function describeError(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'invalid_input') return PAIR_INPUT_TEXT;
  if (error instanceof ApiError) return describeApiError(error);
  return 'Erro inesperado ao parear.';
}

export function PairScreen({ initialBaseUrl, canCancel, onCancel, onPaired }: PairScreenProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(DEFAULT_DEVICE_NAME);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === null) {
      setError('O endereço precisa começar com http:// ou https://.');
      return;
    }
    if (!isSafePairingBaseUrl(normalized, window.location.origin)) {
      setError(PAIR_HTTPS_TEXT);
      return;
    }
    if (!CODE_PATTERN.test(code)) {
      setError('O código tem 6 dígitos.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await pair({ baseUrl: normalized, code, deviceName });
      onPaired(result, normalized);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <h1>Parear máquina</h1>
        <p className="muted">
          Gere um código de 6 dígitos no PC e digite aqui. Ele vale por 5 minutos.
        </p>
      </header>

      <form className="card form" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span>Endereço do PC</span>
          <input
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
        </label>

        <label className="field">
          <span>Código</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]{6}"
            placeholder="000000"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            required
          />
        </label>

        <label className="field">
          <span>Nome deste dispositivo</span>
          <input
            type="text"
            maxLength={64}
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            required
          />
        </label>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button className="button primary" type="submit" disabled={submitting}>
          {submitting ? 'Pareando…' : 'Parear'}
        </button>

        {canCancel && (
          <button className="button ghost" type="button" onClick={onCancel} disabled={submitting}>
            Voltar
          </button>
        )}
      </form>
    </main>
  );
}
