import { useMemo, useState } from 'react';
import { ShieldOff, Smartphone } from 'lucide-react';
import type { DevicesResponse } from '@nanachi/shared';
import { createApiClient, type ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, listRowClass } from '../components/ListGroup.js';
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

function revokeMessage(device: Device): string {
  if (device.current) {
    return `Revogar "${device.name}"? Este é este aparelho: ele perde o acesso e precisa parear de novo.`;
  }
  return `Revogar "${device.name}"? Ele perde o acesso a esta máquina na hora.`;
}

/** Dispositivos pareados com a máquina. Revogar é imediato (derruba o WS e as notificações). */
export function DevicesScreen({ machine, nav, onRevokedSelf }: DevicesScreenProps) {
  const api: ApiClient = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const list = useAsync(() => api.devices(), [api]);
  const [actionError, setActionError] = useState<unknown>(null);
  const error = actionError ?? list.error;
  const now = Date.now();

  async function revoke(device: Device) {
    if (!window.confirm(revokeMessage(device))) return;
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
        title="Dispositivos desta máquina"
        subtitle={machine.name}
        onBack={() => nav.back()}
      />

      <ErrorNotice error={error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />

      {list.data === null && error === null && <p className="pl-1 text-muted-foreground">Carregando…</p>}

      {list.data !== null && list.data.length > 0 && (
        <ListGroup label="Dispositivos">
          {list.data.map((device) => (
            <li key={device.id} className={listRowClass}>
              <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-base font-medium">{device.name}</span>
                  {device.current && <Badge>este aparelho</Badge>}
                </span>
                <span className="text-sm text-muted-foreground">
                  Criado {formatRelativeTime(device.createdAt, now)} · visto por último{' '}
                  {device.lastSeenAt === null ? 'nunca' : formatRelativeTime(device.lastSeenAt, now)}
                </span>
              </div>
              <Button
                variant="destructive-ghost"
                className="shrink-0 px-3"
                aria-label={`Revogar ${device.name}`}
                onClick={() => void revoke(device)}
              >
                <ShieldOff aria-hidden="true" />
                Revogar
              </Button>
            </li>
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}
