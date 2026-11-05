import { afterEach, describe, expect, it } from 'vitest';
import type { ControlError } from '../src/common/control-api.js';
import { setLanguage, translate, type Language, type MessageKey } from '../src/common/i18n/index.js';
import { controlFailure, toControlError } from '../src/main/control-errors.js';
import { DaemonApiError, type DaemonApiErrorKind } from '../src/main/daemon-api.js';
import { PairingError, type PairingErrorKind } from '../src/main/pairing.js';
import { RootsConfigError } from '../src/main/roots-config.js';

afterEach(() => setLanguage('pt-BR'));

const OTHERS = ['en', 'es'] as const satisfies readonly Language[];

interface Expected {
  code: ControlError['code'];
  key: MessageKey;
  params?: Record<string, string | number>;
}

/** Every kind of `DaemonApiError` and what it becomes: the code the renderer branches on and the message key. */
const DAEMON_KINDS: Array<{ error: DaemonApiError; expected: Expected }> = [
  { error: new DaemonApiError('unavailable', 'x'), expected: { code: 'daemon_unavailable', key: 'main.control.daemon.unavailable' } },
  { error: new DaemonApiError('not_paired', 'detail text'), expected: { code: 'not_paired', key: 'main.control.daemon.notPaired', params: { detail: 'detail text' } } },
  { error: new DaemonApiError('unauthorized', 'x', 401), expected: { code: 'unauthorized', key: 'main.control.daemon.unauthorized' } },
  { error: new DaemonApiError('forbidden', 'x', 403), expected: { code: 'unauthorized', key: 'main.control.daemon.forbidden' } },
  { error: new DaemonApiError('rejected', 'x', 409, 'accounts_unsupported'), expected: { code: 'invalid_input', key: 'main.control.rejected.accountsUnsupported' } },
  { error: new DaemonApiError('rejected', 'x', 409, 'account_in_use'), expected: { code: 'invalid_input', key: 'main.control.rejected.accountInUse' } },
  { error: new DaemonApiError('rejected', 'x', 409, 'too_many_accounts'), expected: { code: 'invalid_input', key: 'main.control.rejected.tooManyAccounts' } },
  { error: new DaemonApiError('rejected', 'x', 404, 'not_found'), expected: { code: 'invalid_input', key: 'main.control.rejected.notFound' } },
  { error: new DaemonApiError('rejected', 'x', 400, 'something_else'), expected: { code: 'invalid_input', key: 'main.control.rejected.refused' } },
  { error: new DaemonApiError('rejected', 'x', 400), expected: { code: 'invalid_input', key: 'main.control.rejected.refused' } },
  { error: new DaemonApiError('not_found', 'x', 404), expected: { code: 'unknown', key: 'main.control.daemon.notFound' } },
  { error: new DaemonApiError('busy', 'x', 429), expected: { code: 'unknown', key: 'main.control.daemon.busy' } },
  { error: new DaemonApiError('server', 'x', 503), expected: { code: 'unknown', key: 'main.control.daemon.server', params: { status: 503 } } },
  { error: new DaemonApiError('server', 'x'), expected: { code: 'unknown', key: 'main.control.daemon.server', params: { status: '?' } } },
  { error: new DaemonApiError('bad_response', 'x'), expected: { code: 'unknown', key: 'main.control.daemon.badResponse' } },
];

const PAIRING_KINDS: Array<{ kind: PairingErrorKind; code: ControlError['code'] }> = [
  { kind: 'network', code: 'daemon_unavailable' },
  { kind: 'rejected', code: 'not_paired' },
  { kind: 'cli_failed', code: 'unknown' },
  { kind: 'bad_output', code: 'unknown' },
  { kind: 'rate_limited', code: 'unknown' },
  { kind: 'bad_response', code: 'unknown' },
];

describe('every DaemonApiError kind in every language', () => {
  it('covers every kind of the type', () => {
    const covered = new Set(DAEMON_KINDS.map((entry) => entry.error.kind));
    const all: DaemonApiErrorKind[] = ['unavailable', 'not_paired', 'unauthorized', 'forbidden', 'not_found', 'rejected', 'busy', 'server', 'bad_response'];
    expect([...covered].sort()).toEqual([...all].sort());
  });

  it.each(['pt-BR', ...OTHERS] as const)('%s: the code is the same, the message is the language\'s', (language) => {
    setLanguage(language);
    for (const { error, expected } of DAEMON_KINDS) {
      const result = toControlError(error);
      expect(result, `${error.kind} ${error.apiCode ?? ''}`).toEqual({
        ok: false,
        code: expected.code,
        message: translate(language, expected.key, expected.params),
      });
      if (language !== 'pt-BR') expect(result.message, `${error.kind} ${error.apiCode ?? ''}`).not.toBe(translate('pt-BR', expected.key, expected.params));
    }
  });

  it('writes the texts of the English and the Spanish messages', () => {
    setLanguage('en');
    expect(toControlError(new DaemonApiError('unavailable', 'x'))).toEqual(
      controlFailure('daemon_unavailable', 'Could not reach the Nanachi daemon. It may be stopped or still starting.'),
    );
    expect(toControlError(new DaemonApiError('server', 'x', 502))).toEqual(controlFailure('unknown', 'The daemon answered with an error (HTTP 502). See the Logs tab.'));
    expect(toControlError(new DaemonApiError('rejected', 'x', 409, 'account_in_use'))).toEqual(controlFailure('invalid_input', 'A session is using this account.'));
    setLanguage('es');
    expect(toControlError(new DaemonApiError('unavailable', 'x'))).toEqual(
      controlFailure('daemon_unavailable', 'No se pudo comunicar con el daemon de Nanachi. Puede estar detenido o aún iniciando.'),
    );
    expect(toControlError(new DaemonApiError('server', 'x', 502))).toEqual(controlFailure('unknown', 'El daemon respondió con un error (HTTP 502). Mira la pestaña Registros.'));
    expect(toControlError(new DaemonApiError('rejected', 'x', 409, 'account_in_use'))).toEqual(controlFailure('invalid_input', 'Hay una sesión usando esta cuenta.'));
  });

  it('the Portuguese messages are the ones the app always had', () => {
    expect(toControlError(new DaemonApiError('busy', 'x', 429)).message).toBe(
      'O daemon pediu calma: houve tentativas demais seguidas. Aguarde um instante e tente de novo.',
    );
    expect(toControlError(new DaemonApiError('forbidden', 'x', 403)).message).toBe(
      'O daemon só aceita acessos pelo Tailscale (allowedTailscaleLogins no config.json), então o Nanachi Desktop não consegue consultá-lo. ' +
        'Deixe essa lista vazia no config.json da pasta de dados do Desktop.',
    );
  });
});

describe('every PairingError kind in every language', () => {
  it.each(['pt-BR', ...OTHERS] as const)('%s: the code follows the kind, the message wraps the detail', (language) => {
    setLanguage(language);
    for (const { kind, code } of PAIRING_KINDS) {
      expect(toControlError(new PairingError(kind, 'the detail')), kind).toEqual({
        ok: false,
        code,
        message: translate(language, 'main.control.pairingFailed', { detail: 'the detail' }),
      });
    }
  });

  it('reads "Could not complete pairing" and "No se pudo completar el emparejamiento"', () => {
    setLanguage('en');
    expect(toControlError(new PairingError('network', 'boom')).message).toBe('Could not complete pairing: boom');
    setLanguage('es');
    expect(toControlError(new PairingError('network', 'boom')).message).toBe('No se pudo completar el emparejamiento: boom');
    setLanguage('pt-BR');
    expect(toControlError(new PairingError('network', 'boom')).message).toBe('Não foi possível concluir o pareamento: boom');
  });
});

describe('the other things a handler can throw', () => {
  it('keeps a RootsConfigError as it is: its message was already written in the language of the moment', () => {
    for (const code of ['invalid_input', 'io'] as const) {
      expect(toControlError(new RootsConfigError(code, 'texto pronto'))).toEqual({ ok: false, code, message: 'texto pronto' });
    }
  });

  it.each([
    ['pt-BR', 'Algo deu errado: boom'],
    ['en', 'Something went wrong: boom'],
    ['es', 'Algo salió mal: boom'],
  ] as const)('%s: an unexpected error is "unknown" with its own text after the wording', (language, message) => {
    setLanguage(language);
    expect(toControlError(new Error('boom'))).toEqual({ ok: false, code: 'unknown', message });
    expect(toControlError('boom')).toEqual({ ok: false, code: 'unknown', message });
    expect(toControlError({ message: 'boom' })).toEqual({ ok: false, code: 'unknown', message });
  });

  it('an error that carries nothing readable still gets a message in the language', () => {
    const hostile = { toString: () => { throw new Error('no'); } };
    setLanguage('en');
    expect(toControlError(hostile).message).toBe('Something went wrong: unknown error');
    setLanguage('es');
    expect(toControlError(hostile).message).toBe('Algo salió mal: error desconocido');
  });
});
