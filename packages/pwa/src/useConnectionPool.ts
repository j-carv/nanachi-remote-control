import { useEffect, useMemo, useState } from 'react';
import { createConnectionPool, type ConnectionPool, type ConnectionStatus } from './connection.js';
import type { Machine } from './machines.js';

export interface ConnectionPoolState {
  pool: ConnectionPool;
  /** Status de conexão de cada máquina (id -> status). */
  statuses: Record<string, ConnectionStatus>;
}

/**
 * Uma conexão WS por máquina, viva enquanto o app estiver montado.
 * O pool é criado sem abrir sockets; a sincronização com a lista acontece no efeito.
 */
export function useConnectionPool(machines: readonly Machine[]): ConnectionPoolState {
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});

  const pool = useMemo(
    () =>
      createConnectionPool({
        createSocket: (url) => new WebSocket(url),
        onStatus: (machineId, status) =>
          setStatuses((previous) => ({ ...previous, [machineId]: status })),
      }),
    [],
  );

  useEffect(() => () => pool.stopAll(), [pool]);
  useEffect(() => {
    pool.sync(machines);
  }, [pool, machines]);

  return { pool, statuses };
}
