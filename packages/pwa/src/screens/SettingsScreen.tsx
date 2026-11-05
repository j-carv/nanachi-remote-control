import { useEffect, useId, useState } from 'react';
import { Bell, BellOff, ChevronRight, Smartphone } from 'lucide-react';
import { createApiClient, ApiError, type ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { AgentAccountsSection } from '../components/AgentAccountsSection.js';
import { ListGroup, listMainClass, listRowClass, SectionHeading } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
  const pushId = useId();

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

  const pushDescription = busy
    ? subscribed
      ? 'Desativando…'
      : 'Ativando…'
    : subscribed
      ? 'Ativas neste celular: aviso quando o agente termina, pede aprovação, dá erro ou envia um arquivo.'
      : 'Desativadas neste celular.';

  return (
    <Screen>
      <ScreenHeader title="Ajustes" onBack={() => nav.back()} />

      <AgentAccountsSection key={selected.id} machine={selected} nav={nav} />

      <section aria-labelledby="devices-title" className="flex flex-col gap-2">
        <SectionHeading icon={Smartphone} id="devices-title">
          Dispositivos
        </SectionHeading>
        <ListGroup>
          <li>
            <button type="button" className={`${listRowClass} w-full text-left transition-colors hover:bg-accent active:bg-accent`} onClick={() => nav.push({ kind: 'devices' })}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base">Dispositivos desta máquina</span>
                <span className="text-sm text-muted-foreground">Celulares e navegadores pareados com {selected.name}.</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        </ListGroup>
      </section>

      <section aria-labelledby="push-title" className="flex flex-col gap-2">
        <SectionHeading icon={subscribed ? Bell : BellOff} id="push-title">
          Notificações
        </SectionHeading>
        {!supported ? (
          <p className="pl-1 text-sm text-muted-foreground">{UNSUPPORTED_TEXT}</p>
        ) : (
          <>
            <ListGroup>
              <li className={listRowClass}>
                <label htmlFor={pushId} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-base">Avisos neste celular</span>
                  <span className="text-sm text-muted-foreground">{pushDescription}</span>
                </label>
                <Switch
                  id={pushId}
                  checked={subscribed}
                  disabled={busy || (!subscribed && machines.length === 0)}
                  onCheckedChange={(next) => void (next ? activate() : deactivate())}
                />
              </li>
            </ListGroup>
            {permission === 'denied' && (
              <p role="alert" className="pl-1 text-sm text-destructive">
                As notificações estão bloqueadas. Libere-as nos ajustes do iPhone para este app.
              </p>
            )}
            {failure !== null && (
              <p role="alert" className="pl-1 text-sm text-destructive">
                {failure}
              </p>
            )}
            {notes.length > 0 && (
              <ul className="flex flex-col gap-1 pl-1">
                {notes.map((note) => (
                  <li key={note} className="text-sm text-muted-foreground">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </Screen>
  );
}
