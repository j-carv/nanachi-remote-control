import { useEffect, useId, useState } from 'react';
import { Bell, BellOff, ChevronRight, Smartphone } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { createApiClient, ApiError, type ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { AgentAccountsSection } from '../components/AgentAccountsSection.js';
import { LanguageSection } from '../components/LanguageSection.js';
import { NanachiMcpSection } from '../components/NanachiMcpSection.js';
import { LearningSection } from '../components/LearningSection.js';
import { ListGroup, listMainClass, listRowClass, listRowPressClass, SectionHeading } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DesktopSection } from '../desktop/DesktopSection.js';
import { currentLanguage, type Language } from '../i18n/index.js';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { groupMachinesByKey, sameApplicationKey, type MachinePublicKey } from '../push/pushSetup.js';
import { isPushSupported } from '../push/support.js';
import {
  resendSubscriptionLanguage,
  subscriptionInLanguage,
  toSubscriptionRequest,
} from '../push/subscription.js';
import { urlBase64ToUint8Array } from '../push/vapid.js';
import { WhisperSettings } from '../whisper/WhisperSettings.js';
import { TranscriptionSettings } from '../whisper/TranscriptionSettings.js';

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

/** VAPID public key of each other paired machine (publicKey is null when it did not answer). */
async function keysOfOtherMachines(machines: readonly Machine[], selected: Machine): Promise<MachinePublicKey[]> {
  return Promise.all(
    machines
      .filter((machine) => machine.id !== selected.id)
      .map(async (machine) => ({
        machineId: machine.id,
        name: machine.name,
        publicKey: await clientFor(machine).getPushKey().catch(() => null),
      })),
  );
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

      const parsed = toSubscriptionRequest(subscription.toJSON());
      if (parsed === null) {
        setFailure(t('notifications.noSubscription'));
        return;
      }
      // The language goes with the subscription: the daemon writes this phone's push texts in it.
      const request = subscriptionInLanguage(parsed, currentLanguage());
      await chosen.subscribePush(request);
      setSubscribed(true);

      const groups = groupMachinesByKey(selectedKey, await keysOfOtherMachines(machines, selected));
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

  /**
   * Language changed while push is on: sends the subscription again, with the new language, to the machines that hold
   * it (the selected one and those with the same key). Without this phone's subscription for the selected key it does
   * nothing; activation handles that case.
   */
  async function resendLanguage(language: Language) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription === null) return;
      const chosen = clientFor(selected);
      const selectedKey = await chosen.getPushKey();
      if (!sameApplicationKey(subscription.options.applicationServerKey, urlBase64ToUint8Array(selectedKey))) return;
      const sameKeyIds = new Set(
        groupMachinesByKey(selectedKey, await keysOfOtherMachines(machines, selected)).sameKey.map((group) => group.machineId),
      );
      const targets = [chosen, ...machines.filter((machine) => sameKeyIds.has(machine.id)).map((machine) => clientFor(machine))];
      await resendSubscriptionLanguage({ subscription: subscription.toJSON(), language, targets });
    } catch {
      // Best effort: without network or a service worker, the daemon keeps the old language until the next change.
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
      <NanachiMcpSection key={selected.id} machine={selected} />
      <LearningSection key={selected.id} machine={selected} />

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

      <TranscriptionSettings key={`transcription-${selected.id}`} machine={selected} />
      <WhisperSettings key={selected.id} machine={selected} />
      <LanguageSection onChange={(language) => void resendLanguage(language)} />

      <DesktopSection />
    </Screen>
  );
}
