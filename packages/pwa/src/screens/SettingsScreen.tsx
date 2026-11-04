import { useEffect, useState } from 'react';
import { createApiClient, ApiError, type ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { AgentAccountsSection } from '../components/AgentAccountsSection.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { groupMachinesByKey, sameApplicationKey } from '../push/pushSetup.js';
import { isPushSupported } from '../push/support.js';
import { toSubscriptionRequest } from '../push/subscription.js';
import { urlBase64ToUint8Array } from '../push/vapid.js';

interface SettingsScreenProps {
  machines: readonly Machine[];
  /** Máquina cuja chave VAPID é usada para a inscrição deste celular. */
  selected: Machine;
  nav: Navigator;
}

const UNSUPPORTED_TEXT =
  'Notificações não estão disponíveis neste navegador. No iPhone, abra pelo ícone da Tela de Início (iOS 16.4+).';
const OTHER_KEY_TEXT =
  'usa outra chave de notificação, então não recebe avisos deste celular. Copie o vapid.json do PC principal (veja o README) e ative de novo.';
const UNREACHABLE_TEXT = 'não respondeu agora. Ative de novo quando ela estiver online.';
const REJECTED_TEXT = 'não aceitou a inscrição. Tente ativar de novo.';

function readSupport(): boolean {
  return isPushSupported({
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
  });
}

function clientFor(machine: Machine): ApiClient {
  return createApiClient({ baseUrl: machine.baseUrl, token: machine.token });
}

/** Erro da API tem texto próprio; falha do navegador (ex.: recusou a inscrição) tem outro. */
function failureText(error: unknown): string {
  if (error instanceof ApiError) return describeError(error);
  return 'Não consegui ativar as notificações neste navegador. Tente de novo.';
}

/**
 * Ajustes: ativa/desativa Web Push deste celular nas máquinas pareadas. Um PushSubscription é
 * único por chave VAPID, então a inscrição usa a chave da máquina escolhida e só vale nas
 * máquinas com a mesma chave.
 */
export function SettingsScreen({ machines, selected, nav }: SettingsScreenProps) {
  const [supported] = useState(readSupport);
  const [permission, setPermission] = useState<NotificationPermission | null>(() =>
    supported ? Notification.permission : null,
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then(
        (subscription) => {
          if (active) setSubscribed(subscription !== null);
        },
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [supported]);

  async function activate() {
    // O pedido de permissão é a primeira coisa do clique (o iOS exige o gesto do usuário).
    const asked = Notification.requestPermission();
    setBusy(true);
    setFailure(null);
    setNotes([]);
    try {
      const answer = await asked;
      setPermission(answer);
      if (answer !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;
      const chosen = clientFor(selected);
      const selectedKey = await chosen.getPushKey();
      const keyBytes = urlBase64ToUint8Array(selectedKey);

      let subscription = await registration.pushManager.getSubscription();
      if (subscription !== null && !sameApplicationKey(subscription.options.applicationServerKey, keyBytes)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes,
      });

      const request = toSubscriptionRequest(subscription.toJSON());
      if (request === null) {
        setFailure('O navegador não devolveu a inscrição. Tente de novo.');
        return;
      }
      await chosen.subscribePush(request);
      setSubscribed(true);

      const others = await Promise.all(
        machines
          .filter((machine) => machine.id !== selected.id)
          .map(async (machine) => ({
            machineId: machine.id,
            name: machine.name,
            publicKey: await clientFor(machine).getPushKey().catch(() => null),
          })),
      );
      const groups = groupMachinesByKey(selectedKey, others);
      const lines: string[] = [];
      // Mesma chave = mesma inscrição vale nelas também.
      for (const group of groups.sameKey) {
        const machine = machines.find((item) => item.id === group.machineId);
        if (machine === undefined) continue;
        const accepted = await clientFor(machine).subscribePush(request).then(
          () => true,
          () => false,
        );
        lines.push(`${machine.name}: ${accepted ? 'ativa.' : REJECTED_TEXT}`);
      }
      for (const machine of groups.otherKey) lines.push(`${machine.name}: ${OTHER_KEY_TEXT}`);
      for (const machine of groups.unreachable) lines.push(`${machine.name}: ${UNREACHABLE_TEXT}`);
      setNotes(lines);
    } catch (caught) {
      setFailure(failureText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    setBusy(true);
    setFailure(null);
    setNotes([]);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription !== null) {
        const endpoint = subscription.endpoint;
        // Best effort: máquina que nunca recebeu esta inscrição responde 404, e tudo bem.
        await Promise.all(
          machines.map((machine) => clientFor(machine).unsubscribePush(endpoint).catch(() => undefined)),
        );
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch (caught) {
      setFailure(failureText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <ScreenHeader title="Ajustes" onBack={() => nav.back()} />

      <AgentAccountsSection key={selected.id} machine={selected} nav={nav} />

      <section className="card">
        <h2 className="section-title">Dispositivos</h2>
        <p className="muted">Celulares e navegadores pareados com {selected.name}.</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => nav.push({ kind: 'devices' })}
        >
          Dispositivos desta máquina
        </button>
      </section>

      <section className="card">
        <h2 className="section-title">Notificações</h2>
        {!supported ? (
          <p className="muted">{UNSUPPORTED_TEXT}</p>
        ) : (
          <>
            <p className="muted">
              {subscribed
                ? 'Ativas neste celular: aviso quando o agente termina, pede aprovação, dá erro ou envia um arquivo.'
                : 'Desativadas neste celular.'}
            </p>
            {permission === 'denied' && (
              <p className="error" role="alert">
                As notificações estão bloqueadas. Libere-as nos ajustes do iPhone para este app.
              </p>
            )}
            {subscribed ? (
              <button type="button" className="button danger" disabled={busy} onClick={() => void deactivate()}>
                Desativar
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={busy || machines.length === 0}
                onClick={() => void activate()}
              >
                {busy ? 'Ativando…' : 'Ativar'}
              </button>
            )}
            {failure !== null && (
              <p className="error" role="alert">
                {failure}
              </p>
            )}
            {notes.length > 0 && (
              <ul className="notes">
                {notes.map((note) => (
                  <li key={note} className="muted small">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </main>
  );
}
