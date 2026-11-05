import { Monitor, Plus, RotateCw, ShieldOff, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ControlError, DeviceInfo } from '../../common/control-api.js';
import type { PairingCode } from '../../common/types.js';
import { errorMessage, isCalmError } from '../lib/errors.js';
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
import { Group, rowStyle } from '../ui/Surface.js';
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
  const { t } = useTranslation();
  const expired = remainingMs <= 0;
  return (
    <section aria-label={t('devices.pairNew')} className="animate-page rounded-lg border border-border bg-card">
      <div className="flex flex-wrap gap-x-10 gap-y-5 px-5 py-5">
        <div className="min-w-[220px]">
          <div className="text-[13px] text-muted-foreground">{t('devices.pairing.title')}</div>
          <div className="mt-1 flex items-center gap-2">
            <span
              aria-label={t('devices.pairing.codeLabel', { digits: code.split('').join(' ') })}
              className={cx('selectable font-mono text-[34px] leading-[44px] font-medium tracking-[0.06em] tabular-nums', expired && 'text-muted-foreground line-through decoration-1')}
            >
              {formatPairingCode(code)}
            </span>
            {expired ? null : <CopyButton text={code} label={t('devices.pairing.copy')} />}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div role="progressbar" aria-label={t('devices.pairing.timeLeft')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="h-1 w-40 overflow-hidden rounded-full bg-muted">
              <div className={cx('h-full rounded-full transition-[width] duration-1000 ease-linear', fraction < 0.2 ? 'bg-attention' : 'bg-foreground/70')} style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
            <span className={cx('text-[13px] tabular-nums', expired ? 'text-attention' : 'text-muted-foreground')} role="timer" aria-live="off">
              {expired ? t('devices.pairing.expired') : t('devices.pairing.expiresIn', { time: formatCountdown(remainingMs) })}
            </span>
          </div>
        </div>
        <ol className="min-w-[240px] flex-1 list-decimal space-y-1.5 pl-5 text-[13px] leading-5 text-muted-foreground marker:text-muted-foreground">
          <li>{t('devices.pairing.step1')}</li>
          <li>{t('devices.pairing.step2')}</li>
          <li>{t('devices.pairing.step3')}</li>
        </ol>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
        <Button variant={expired ? 'primary' : 'secondary'} icon={<RotateCw aria-hidden="true" />} loading={regenerating} onClick={onRegenerate}>
          {expired ? t('devices.pairing.regenerateExpired') : t('devices.pairing.regenerate')}
        </Button>
      </div>
    </section>
  );
}

function PairingPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const [issued, setIssued] = useState<{ code: PairingCode; startedAt: number } | null>(null);
  const [failed, setFailed] = useState<ControlError | null>(null);
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
      setFailed(result);
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
      <section aria-label={t('devices.pairNew')} role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-destructive/8 px-4 py-3.5 text-[13px]">
        <span className="min-w-0 flex-1">{errorMessage(failed, t)}</span>
        <Button icon={<RotateCw aria-hidden="true" />} loading={regenerating} onClick={() => void generate()}>
          {t('common.retry')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      </section>
    );
  }
  if (!issued) {
    return (
      <section aria-label={t('devices.pairNew')} aria-busy="true" className="flex h-[148px] items-center justify-center rounded-lg border border-border bg-card text-[13px] text-muted-foreground">
        {t('devices.pairing.generating')}
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
  const { t } = useTranslation();
  return (
    <Group>
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">{t('devices.table.caption')}</caption>
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
              {t('devices.table.name')}
            </th>
            <th scope="col" className={HEAD}>
              {t('devices.table.created')}
            </th>
            <th scope="col" className={HEAD}>
              {t('devices.table.lastSeen')}
            </th>
            <th scope="col" className={HEAD}>
              {t('devices.table.status')}
            </th>
            <th scope="col" className={HEAD}>
              <span className="sr-only">{t('devices.table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {devices.map((device, index) => (
            <tr
              key={device.id}
              data-slot="device-row"
              data-revoked={device.revoked}
              style={rowStyle(index)}
              className={cx('animate-row h-12 transition-colors duration-150 ease-[var(--ease-premium)] hover:bg-accent/50', device.revoked && 'text-muted-foreground')}
            >
              <th scope="row" className="px-4 text-left font-normal">
                <span className="flex items-center gap-2.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                    {device.isThisApp ? <Monitor aria-hidden="true" /> : <Smartphone aria-hidden="true" />}
                  </span>
                  <span className={cx('truncate font-medium', !device.revoked && 'text-foreground')} title={device.name}>
                    {device.name}
                  </span>
                  {device.isThisApp ? <Badge>{t('devices.table.thisApp')}</Badge> : null}
                </span>
              </th>
              <td className="px-4 whitespace-nowrap tabular-nums">{formatDate(device.createdAt, t)}</td>
              <td className="px-4 whitespace-nowrap tabular-nums" title={device.lastSeenAt === null ? undefined : formatDateTime(device.lastSeenAt, t)}>
                {formatRelative(device.lastSeenAt, now, t)}
              </td>
              <td className="px-4">
                <span className={cx('inline-flex items-center gap-1.5', device.revoked ? 'text-muted-foreground' : 'text-foreground')}>
                  <StatusDot tone={device.revoked ? 'muted' : 'success'} />
                  {device.revoked ? t('devices.table.revoked') : t('devices.table.active')}
                </span>
              </td>
              <td className="px-3 text-right">
                {device.isThisApp || device.revoked ? null : (
                  <Button variant="danger-ghost" size="sm" aria-label={t('devices.table.revokeLabel', { name: device.name })} onClick={() => onRevoke(device)}>
                    {t('devices.table.revoke')}
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
  const { t } = useTranslation();
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
      toast({ tone: 'success', message: t('devices.revoke.done', { name: target.name }) });
      void shell.reloadOverview(true);
    } else {
      toast({ tone: 'error', title: t('devices.revoke.failedTitle'), message: errorMessage(result, t) });
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
          title={t('devices.empty.title')}
          description={t('devices.empty.description')}
          action={
            <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setPairing(true)}>
              {t('devices.pairNew')}
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
            {t('devices.pairNew')}
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
        title={target ? t('devices.revoke.title', { name: target.name }) : t('devices.revoke.titleFallback')}
        description={t('devices.revoke.description')}
        footer={
          <>
            <Button disabled={revoking} onClick={() => setTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" icon={<ShieldOff aria-hidden="true" />} loading={revoking} onClick={() => void revoke()}>
              {t('devices.revoke.action')}
            </Button>
          </>
        }
      />
    </Page>
  );
}
