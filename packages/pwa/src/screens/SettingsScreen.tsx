import { useEffect, useId, useState } from 'react';
import { Bell, BellOff, ChevronRight, Smartphone } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { createApiClient, ApiError, type ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { AgentAccountsSection } from '../components/AgentAccountsSection.js';
import { LanguageSection } from '../components/LanguageSection.js';
import { ListGroup, listMainClass, listRowClass, listRowPressClass, SectionHeading } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DesktopSection } from '../desktop/DesktopSection.js';
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
function failureText(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof ApiError) return describeError(error);
  return t('notifications.browserFailed');
}

/**
 * Ajustes: ativa/desativa Web Push deste celular nas máquinas pareadas. Um PushSubscription é
 * único por chave VAPID, então a inscrição usa a chave da máquina escolhida e só vale nas
 * máquinas com a mesma chave.
 */
export function SettingsScreen({ machines, selected, nav }: SettingsScreenProps) {
  const { t } = useTranslation('settings');
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
        setFailure(t('notifications.noSubscription'));
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
        lines.push(t(accepted ? 'notifications.machineActive' : 'notifications.machineRejected', { name: machine.name }));
      }
      for (const machine of groups.otherKey) lines.push(t('notifications.machineOtherKey', { name: machine.name }));
      for (const machine of groups.unreachable) lines.push(t('notifications.machineUnreachable', { name: machine.name }));
      setNotes(lines);
    } catch (caught) {
      setFailure(failureText(caught, t));
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
      setFailure(failureText(caught, t));
    } finally {
      setBusy(false);
    }
  }

  const pushDescription = busy
    ? subscribed
      ? t('notifications.disabling')
      : t('notifications.enabling')
    : subscribed
      ? t('notifications.enabled')
      : t('notifications.disabled');

  return (
    <Screen>
      <ScreenHeader title={t('title')} onBack={() => nav.back()} />

      <AgentAccountsSection key={selected.id} machine={selected} nav={nav} />

      <section aria-labelledby="devices-title" className="flex flex-col gap-2">
        <SectionHeading icon={Smartphone} id="devices-title">
          {t('devices.heading')}
        </SectionHeading>
        <ListGroup>
          <li>
            <button type="button" className={`${listRowClass} ${listRowPressClass}`} onClick={() => nav.push({ kind: 'devices' })}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base">{t('devices.row')}</span>
                <span className="text-sm text-muted-foreground">{t('devices.rowHint', { name: selected.name })}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        </ListGroup>
      </section>

      <section aria-labelledby="push-title" className="flex flex-col gap-2">
        <SectionHeading icon={subscribed ? Bell : BellOff} id="push-title">
          {t('notifications.heading')}
        </SectionHeading>
        {!supported ? (
          <p className="pl-1 text-sm text-muted-foreground">{t('notifications.unsupported')}</p>
        ) : (
          <>
            <ListGroup>
              <li className={listRowClass}>
                <label htmlFor={pushId} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-base">{t('notifications.toggle')}</span>
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
                {t('notifications.blocked')}
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

      <LanguageSection />

      <DesktopSection />
    </Screen>
  );
}
