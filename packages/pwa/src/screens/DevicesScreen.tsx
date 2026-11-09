import { useMemo, useState } from 'react';
import { ShieldOff, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, createApiClient, type ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listRowClass, staggerDelay } from '../components/ListGroup.js';
import { RevokeDeviceSheet } from '../components/RevokeDeviceSheet.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { canRevoke, sortDevices, type Device } from '../devicesModel.js';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { formatRelativeTime } from '../relativeTime.js';
import { useAsync } from '../useAsync.js';

interface DevicesScreenProps {
  /** Máquina cujos dispositivos são listados. */
  machine: Machine;
  nav: Navigator;
}

/**
 * Dispositivos pareados com a máquina. Revogar pede confirmação e derruba o WS e as notificações do device. Este aparelho
 * não tem o botão (o esquecer da máquina cobre isso) e um device expirado já não tem acesso.
 */
export function DevicesScreen({ machine, nav }: DevicesScreenProps) {
  const { t } = useTranslation('devices');
  const api: ApiClient = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const list = useAsync(() => api.devices(), [api]);
  /** The device whose revocation waits for the confirmation sheet. */
  const [target, setTarget] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(null);
  const now = Date.now();
  const devices = list.data === null ? null : sortDevices(list.data);

  function closeConfirm(): void {
    setTarget(null);
    setRevokeError(null);
  }

  async function confirmRevoke(device: Device): Promise<void> {
    setRevoking(true);
    setRevokeError(null);
    try {
      await api.revokeDevice(device.id);
    } catch (caught) {
      // Already gone (revoked from somewhere else): the list is what is out of date, so it is read again below.
      if (!(caught instanceof ApiError && caught.kind === 'not_found')) {
        setRevokeError(caught);
        setRevoking(false);
        return;
      }
    }
    setRevoking(false);
    closeConfirm();
    list.reload();
  }

  return (
    <Screen>
      <ScreenHeader
        title={t('title')}
        subtitle={machine.name}
        onBack={() => nav.back()}
      />

      <ErrorNotice error={list.error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />

      {devices === null && list.error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}

      {devices !== null && devices.length > 0 && (
        <ListGroup label={t('list')}>
          {devices.map((device, index) => (
            <li key={device.id} className={`${listRowClass} animate-enter`} style={staggerDelay(index)}>
              <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-base font-medium">{device.name}</span>
                  {device.current && <Badge>{t('current')}</Badge>}
                  {device.expired && <Badge variant="outline">{t('expired')}</Badge>}
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
              {canRevoke(device) && (
                <Button
                  variant="destructive-ghost"
                  className="shrink-0 px-3"
                  aria-label={t('revokeLabel', { name: device.name })}
                  onClick={() => {
                    setRevokeError(null);
                    setTarget(device);
                  }}
                >
                  <ShieldOff aria-hidden="true" />
                  {t('revoke')}
                </Button>
              )}
            </li>
          ))}
        </ListGroup>
      )}

      {target !== null && (
        <RevokeDeviceSheet
          name={target.name}
          busy={revoking}
          error={revokeError}
          onCancel={closeConfirm}
          onConfirm={() => void confirmRevoke(target)}
        />
      )}
    </Screen>
  );
}
