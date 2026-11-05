import { useMemo, useState } from 'react';
import { ShieldOff, Smartphone } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { DevicesResponse } from '@nanachi/shared';
import { createApiClient, type ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listRowClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { formatRelativeTime } from '../relativeTime.js';
import { useAsync } from '../useAsync.js';

interface DevicesScreenProps {
  /** Máquina cujos dispositivos são listados. */
  machine: Machine;
  nav: Navigator;
  /** Este celular foi revogado: a app esquece a máquina e leva ao pareamento. */
  onRevokedSelf(): void;
}

type Device = DevicesResponse['devices'][number];

function revokeMessage(device: Device, t: TFunction<'devices'>): string {
  return t(device.current ? 'confirmCurrent' : 'confirmOther', { name: device.name });
}

/** Dispositivos pareados com a máquina. Revogar é imediato (derruba o WS e as notificações). */
export function DevicesScreen({ machine, nav, onRevokedSelf }: DevicesScreenProps) {
  const { t } = useTranslation('devices');
  const api: ApiClient = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const list = useAsync(() => api.devices(), [api]);
  const [actionError, setActionError] = useState<unknown>(null);
  const error = actionError ?? list.error;
  const now = Date.now();

  async function revoke(device: Device) {
    if (!window.confirm(revokeMessage(device, t))) return;
    try {
      await api.revokeDevice(device.id);
    } catch (caught) {
      setActionError(caught);
      return;
    }
    if (device.current) {
      onRevokedSelf();
      return;
    }
    setActionError(null);
    list.reload();
  }

  return (
    <Screen>
      <ScreenHeader
        title={t('title')}
        subtitle={machine.name}
        onBack={() => nav.back()}
      />

      <ErrorNotice error={error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />

      {list.data === null && error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}

      {list.data !== null && list.data.length > 0 && (
        <ListGroup label={t('list')}>
          {list.data.map((device, index) => (
            <li key={device.id} className={`${listRowClass} animate-enter`} style={staggerDelay(index)}>
              <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-base font-medium">{device.name}</span>
                  {device.current && <Badge>{t('current')}</Badge>}
                </span>
                <span className="text-sm text-muted-foreground">
                  {device.lastSeenAt === null
                    ? t('metaNeverSeen', { created: formatRelativeTime(device.createdAt, now) })
                    : t('meta', {
                        created: formatRelativeTime(device.createdAt, now),
                        lastSeen: formatRelativeTime(device.lastSeenAt, now),
                      })}
                </span>
              </div>
              <Button
                variant="destructive-ghost"
                className="shrink-0 px-3"
                aria-label={t('revokeLabel', { name: device.name })}
                onClick={() => void revoke(device)}
              >
                <ShieldOff aria-hidden="true" />
                {t('revoke')}
              </Button>
            </li>
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}
