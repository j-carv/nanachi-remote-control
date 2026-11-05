import { Monitor, Plus, RotateCw, ShieldOff, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DeviceInfo } from '../../common/control-api.js';
import type { PairingCode } from '../../common/types.js';
import { isCalmError } from '../lib/errors.js';
import { formatCountdown, formatDate, formatDateTime, formatPairingCode, formatRelative, remainingFraction } from '../lib/format.js';
import { useApi } from '../state/api.js';
import { settle, useResource } from '../state/resource.js';
import { useShell } from '../state/shell.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { CopyButton } from '../ui/CopyButton.js';
import { cx } from '../ui/cx.js';
import { Dialog } from '../ui/Dialog.js';
import { StatusDot } from '../ui/StatusDot.js';
import { EmptyState, ErrorState, GroupSkeleton } from '../ui/States.js';
import { Group } from '../ui/Surface.js';
import { useToast } from '../ui/Toast.js';
import { Page } from './Page.js';

/* ----------------------------------------------------------------- pairing */

export interface PairingViewProps {
  code: string;
  remainingMs: number;
  fraction: number;
  regenerating: boolean;
  onRegenerate: () => void;
  onClose: () => void;
}

/** The pairing code, its countdown and the steps. A code is single-use and short-lived, so expiry is a state, not an error. */
export function PairingView({ code, remainingMs, fraction, regenerating, onRegenerate, onClose }: PairingViewProps) {
  const expired = remainingMs <= 0;
  return (
    <section aria-label="Parear novo aparelho" className="animate-page rounded-lg border border-border bg-card">
      <div className="flex flex-wrap gap-x-10 gap-y-5 px-5 py-5">
        <div className="min-w-[220px]">
          <div className="text-[13px] text-muted-foreground">Código de pareamento</div>
          <div className="mt-1 flex items-center gap-2">
            <span
              aria-label={`Código ${code.split('').join(' ')}`}
              className={cx('selectable font-mono text-[34px] leading-[44px] font-medium tracking-[0.06em] tabular-nums', expired && 'text-muted-foreground line-through decoration-1')}
            >
              {formatPairingCode(code)}
            </span>
            {expired ? null : <CopyButton text={code} label="Copiar código" />}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div role="progressbar" aria-label="Tempo restante do código" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="h-1 w-40 overflow-hidden rounded-full bg-muted">
              <div className={cx('h-full rounded-full transition-[width] duration-1000 ease-linear', fraction < 0.2 ? 'bg-attention' : 'bg-foreground/70')} style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
            <span className={cx('text-[13px] tabular-nums', expired ? 'text-attention' : 'text-muted-foreground')} role="timer" aria-live="off">
              {expired ? 'Expirou' : `Expira em ${formatCountdown(remainingMs)}`}
            </span>
          </div>
        </div>
        <ol className="min-w-[240px] flex-1 list-decimal space-y-1.5 pl-5 text-[13px] leading-5 text-muted-foreground marker:text-muted-foreground">
          <li>Abra o Nanachi no iPhone e escolha parear com um código.</li>
          <li>Digite os seis dígitos antes que o tempo acabe.</li>
          <li>Cada código vale uma vez. Se expirar, gere outro.</li>
        </ol>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
        <Button variant={expired ? 'primary' : 'secondary'} icon={<RotateCw aria-hidden="true" />} loading={regenerating} onClick={onRegenerate}>
          {expired ? 'Gerar novo código' : 'Gerar outro'}
        </Button>
      </div>
    </section>
  );
}

function PairingPanel({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const [issued, setIssued] = useState<{ code: PairingCode; startedAt: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const active = useRef(true);

  const generate = async (): Promise<void> => {
    setRegenerating(true);
    setFailed(null);
    const result = await settle(() => api.devices.pairingCode());
    if (!active.current) return;
    setRegenerating(false);
    if (result.ok) {
      setIssued({ code: result.value, startedAt: Date.now() });
      setNow(Date.now());
    } else {
      setFailed(result.message);
    }
  };

  useEffect(() => {
    active.current = true;
    void generate();
    return () => {
      active.current = false;
    };
    // generate once, when the panel opens
  }, []);

  const expiresAt = issued?.code.expiresAt ?? 0;
  const expired = issued !== null && expiresAt <= now;
  useEffect(() => {
    if (!issued || expired) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [issued, expired]);

  if (failed) {
    return (
      <section aria-label="Parear novo aparelho" role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-destructive/8 px-4 py-3.5 text-[13px]">
        <span className="min-w-0 flex-1">{failed}</span>
        <Button icon={<RotateCw aria-hidden="true" />} loading={regenerating} onClick={() => void generate()}>
          Tentar de novo
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </section>
    );
  }
  if (!issued) {
    return (
      <section aria-label="Parear novo aparelho" aria-busy="true" className="flex h-[148px] items-center justify-center rounded-lg border border-border bg-card text-[13px] text-muted-foreground">
        Gerando o código…
      </section>
    );
  }
  return (
    <PairingView
      code={issued.code.code}
      remainingMs={Math.max(0, expiresAt - now)}
      fraction={remainingFraction(expiresAt, issued.startedAt, now)}
      regenerating={regenerating}
      onRegenerate={() => void generate()}
      onClose={onClose}
    />
  );
}

/* ------------------------------------------------------------------- table */

export interface DevicesTableProps {
  devices: DeviceInfo[];
  now: number;
  onRevoke: (device: DeviceInfo) => void;
}

const HEAD = 'px-4 py-2 text-left text-xs font-medium text-muted-foreground';

/** Active devices first, then the revoked ones, each group newest use first. */
export function sortDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) => {
    if (a.revoked !== b.revoked) return a.revoked ? 1 : -1;
    return (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt);
  });
}

export function DevicesTable({ devices, now, onRevoke }: DevicesTableProps) {
  return (
    <Group>
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Aparelhos pareados</caption>
        <colgroup>
          <col />
          <col className="w-[116px]" />
          <col className="w-[132px]" />
          <col className="w-[104px]" />
          <col className="w-[104px]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={HEAD}>
              Nome
            </th>
            <th scope="col" className={HEAD}>
              Criado
            </th>
            <th scope="col" className={HEAD}>
              Último uso
            </th>
            <th scope="col" className={HEAD}>
              Status
            </th>
            <th scope="col" className={HEAD}>
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {devices.map((device) => (
            <tr key={device.id} data-slot="device-row" data-revoked={device.revoked} className={cx('h-12', device.revoked && 'text-muted-foreground')}>
              <th scope="row" className="px-4 text-left font-normal">
                <span className="flex items-center gap-2.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                    {device.isThisApp ? <Monitor aria-hidden="true" /> : <Smartphone aria-hidden="true" />}
                  </span>
                  <span className={cx('truncate font-medium', !device.revoked && 'text-foreground')} title={device.name}>
                    {device.name}
                  </span>
                  {device.isThisApp ? <Badge>Este app</Badge> : null}
                </span>
              </th>
              <td className="px-4 whitespace-nowrap tabular-nums">{formatDate(device.createdAt)}</td>
              <td className="px-4 whitespace-nowrap tabular-nums" title={device.lastSeenAt === null ? undefined : formatDateTime(device.lastSeenAt)}>
                {formatRelative(device.lastSeenAt, now)}
              </td>
              <td className="px-4">
                <span className={cx('inline-flex items-center gap-1.5', device.revoked ? 'text-muted-foreground' : 'text-foreground')}>
                  <StatusDot tone={device.revoked ? 'muted' : 'success'} />
                  {device.revoked ? 'Revogado' : 'Ativo'}
                </span>
              </td>
              <td className="px-3 text-right">
                {device.isThisApp || device.revoked ? null : (
                  <Button variant="danger-ghost" size="sm" aria-label={`Revogar ${device.name}`} onClick={() => onRevoke(device)}>
                    Revogar
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Group>
  );
}

/* ----------------------------------------------------------------- section */

export function DevicesSection() {
  const api = useApi();
  const shell = useShell();
  const toast = useToast();
  const devices = useResource(() => api.devices.list());
  const [pairing, setPairing] = useState(false);
  const [target, setTarget] = useState<DeviceInfo | null>(null);
  const [revoking, setRevoking] = useState(false);
  const { takePairingRequest } = shell;

  useEffect(() => {
    if (takePairingRequest()) setPairing(true);
  }, [takePairingRequest]);

  const revoke = async (): Promise<void> => {
    if (!target) return;
    setRevoking(true);
    const result = await settle(() => api.devices.revoke(target.id));
    setRevoking(false);
    setTarget(null);
    if (result.ok) {
      devices.setData(result.value);
      toast({ tone: 'success', message: `${target.name} não tem mais acesso.` });
      void shell.reloadOverview(true);
    } else {
      toast({ tone: 'error', title: 'Não foi possível revogar', message: result.message });
    }
  };

  const now = Date.now();
  let body;
  if (devices.state.status === 'loading') body = <GroupSkeleton rows={3} />;
  else if (devices.state.status === 'error') body = <ErrorState error={devices.state.error} onRetry={() => void devices.reload()} />;
  else if (devices.state.data.length === 0) {
    body = (
      <div className="rounded-lg border border-border bg-card">
        <EmptyState
          icon={Smartphone}
          title="Nenhum aparelho pareado"
          description="Gere um código aqui e digite no Nanachi do iPhone para ele poder usar este PC."
          action={
            <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setPairing(true)}>
              Parear novo aparelho
            </Button>
          }
        />
      </div>
    );
  } else body = <DevicesTable devices={sortDevices(devices.state.data)} now={now} onRevoke={setTarget} />;

  return (
    <Page
      section="devices"
      actions={
        pairing || (devices.state.status === 'error' && isCalmError(devices.state.error.code)) ? null : (
          <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setPairing(true)}>
            Parear novo aparelho
          </Button>
        )
      }
    >
      {pairing ? <PairingPanel onClose={() => setPairing(false)} /> : null}
      {body}
      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        dismissible={!revoking}
        title={target ? `Revogar ${target.name}?` : 'Revogar aparelho?'}
        description="O aparelho perde o acesso agora. Para voltar a usar este PC, ele precisa ser pareado de novo com um código."
        footer={
          <>
            <Button disabled={revoking} onClick={() => setTarget(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" icon={<ShieldOff aria-hidden="true" />} loading={revoking} onClick={() => void revoke()}>
              Revogar
            </Button>
          </>
        }
      />
    </Page>
  );
}
