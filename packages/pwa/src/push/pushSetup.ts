/** Máquina pareada com a chave VAPID pública que ela publica (`null` se não respondeu). */
export interface MachinePublicKey {
  machineId: string;
  name: string;
  publicKey: string | null;
}

/**
 * Máquinas agrupadas pela chave VAPID em relação à máquina escolhida para a inscrição.
 * Um PushSubscription é único por chave: `sameKey` recebe a mesma inscrição; `otherKey` precisa
 * do vapid.json compartilhado; `unreachable` não respondeu agora.
 */
export interface KeyGroups {
  sameKey: MachinePublicKey[];
  otherKey: MachinePublicKey[];
  unreachable: MachinePublicKey[];
}

export function groupMachinesByKey(
  selectedKey: string,
  machines: readonly MachinePublicKey[],
): KeyGroups {
  const groups: KeyGroups = { sameKey: [], otherKey: [], unreachable: [] };
  for (const machine of machines) {
    if (machine.publicKey === null) groups.unreachable.push(machine);
    else if (machine.publicKey === selectedKey) groups.sameKey.push(machine);
    else groups.otherKey.push(machine);
  }
  return groups;
}

/** A `applicationServerKey` de uma inscrição existente é a mesma chave que queremos usar? */
export function sameApplicationKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (current === null || current === undefined) return false;
  const bytes = new Uint8Array(current);
  if (bytes.length !== key.length) return false;
  return bytes.every((byte, index) => byte === key[index]);
}
