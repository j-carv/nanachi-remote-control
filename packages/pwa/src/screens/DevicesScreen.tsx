import { useMemo, useState } from 'react';
import type { DevicesResponse } from '@nanachi/shared';
import { createApiClient, type ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
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
    <main className="screen">
      <ScreenHeader
        title="Dispositivos desta máquina"
        subtitle={machine.name}
        onBack={() => nav.back()}
      />

      <ErrorNotice error={error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />

      {list.data === null && error === null && <p className="muted">Carregando…</p>}

      <ul className="item-list">
        {list.data?.map((device) => (
          <li key={device.id} className="item-row">
            <div className="item-main device-main">
              <span className="item-title">
                {device.name}
                {device.current && <span className="badge device-current">este aparelho</span>}
              </span>
              <span className="muted small">
                Criado {formatRelativeTime(device.createdAt, now)} · visto por último{' '}
                {device.lastSeenAt === null ? 'nunca' : formatRelativeTime(device.lastSeenAt, now)}
              </span>
            </div>
            <button
              type="button"
              className="button ghost danger"
              onClick={() => void revoke(device)}
            >
              Revogar
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
