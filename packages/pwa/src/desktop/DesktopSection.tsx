import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, KeyRound, Monitor, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { CopyButton } from '../components/CopyButton.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from '../components/ListGroup.js';
import { StatusDot, TONE_TEXT } from '../components/StatusDot.js';
import { getDesktopBridge, type NanachiDesktopBridge } from './bridge.js';
import { PairingCodeSheet } from './PairingCodeSheet.js';
import {
  parseDaemonStatus,
  parseTailscaleStatus,
  parseUpdateCheck,
  type DaemonStatus,
  type TailscaleStatus,
  type UpdateCheckResult,
} from './schema.js';
import { describeDaemon, describeTailscale, describeUpdate, phoneSteps } from './view.js';

/** What went wrong, as a kind: the text is chosen at render, so it follows the language. */
export type DesktopFailure = 'action' | 'update';
const rowButtonClass = `${listRowClass} w-full text-left transition-colors hover:bg-accent active:bg-accent disabled:pointer-events-none disabled:opacity-50`;

/** Where a status comes from: one read, then pushes from the main process. Module-level, so the effect stays stable. */
interface StatusSource<T> {
  read(bridge: NanachiDesktopBridge): Promise<unknown>;
  subscribe(bridge: NanachiDesktopBridge, callback: (raw: unknown) => void): () => void;
  parse(raw: unknown): T | null;
}

const DAEMON_SOURCE: StatusSource<DaemonStatus> = {
  read: (bridge) => bridge.status(),
  subscribe: (bridge, callback) => bridge.onStatus(callback),
  parse: parseDaemonStatus,
};

const TAILSCALE_SOURCE: StatusSource<TailscaleStatus> = {
  read: (bridge) => bridge.tailscale.status(),
  subscribe: (bridge, callback) => bridge.tailscale.onStatus(callback),
  parse: parseTailscaleStatus,
};

function useBridgeStatus<T>(bridge: NanachiDesktopBridge, source: StatusSource<T>): [T | null, (value: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let active = true;
    let pushed = false;
    const apply = (raw: unknown): void => {
      const parsed = source.parse(raw);
      if (active && parsed !== null) setValue(parsed);
    };
    // A push is newer than a read that was still on its way.
    Promise.resolve()
      .then(() => source.read(bridge))
      .then((raw) => {
        if (!pushed) apply(raw);
      })
      .catch(() => undefined);
    const unsubscribe = source.subscribe(bridge, (raw) => {
      pushed = true;
      apply(raw);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, source]);
  return [value, setValue];
}

export interface DesktopPanelViewProps {
  version: string;
  daemon: DaemonStatus | null;
  autostart: boolean | null;
  autostartBusy: boolean;
  tailscale: TailscaleStatus | null;
  tailscaleBusy: boolean;
  update: UpdateCheckResult | null;
  checking: boolean;
  failure: DesktopFailure | null;
  onAutostart(next: boolean): void;
  onPairing(): void;
  onCheckUpdate(): void;
  onTailscale(next: boolean): void;
}

/** The "Desktop" group of Settings, from plain props. */
export function DesktopPanelView(props: DesktopPanelViewProps) {
  const { t } = useTranslation('desktop');
  const autostartId = useId();
  const tailscaleId = useId();
  const daemon = props.daemon === null ? null : describeDaemon(props.daemon);
  const tailscale = props.tailscale === null ? null : describeTailscale(props.tailscale);
  const update = describeUpdate(props.version, props.update, props.checking);

  return (
    <section aria-labelledby="desktop-title" className="flex flex-col gap-2" data-slot="desktop-section">
      <SectionHeading icon={Monitor} id="desktop-title">
        {t('title')}
      </SectionHeading>

      <ListGroup label={t('group')}>
        <li className={listRowClass} data-slot="desktop-daemon" data-state={props.daemon?.state ?? 'unknown'}>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base">{t('daemon.label')}</span>
            {daemon === null ? (
              <span className="text-sm text-muted-foreground">{t('daemon.checking')}</span>
            ) : (
              <>
                <span className={cn('flex items-center gap-2 text-sm', TONE_TEXT[daemon.tone])}>
                  <StatusDot tone={daemon.tone} pulse={daemon.pulse} />
                  <span data-slot="desktop-daemon-title">{daemon.title}</span>
                </span>
                {daemon.detail !== null && <span className="text-sm text-muted-foreground">{daemon.detail}</span>}
              </>
            )}
          </span>
        </li>

        <li className={listRowClass} data-slot="desktop-autostart">
          <label htmlFor={autostartId} className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base">{t('autostart.title')}</span>
            <span className="text-sm text-muted-foreground">{t('autostart.description')}</span>
          </label>
          <Switch
            id={autostartId}
            checked={props.autostart === true}
            disabled={props.autostart === null || props.autostartBusy}
            onCheckedChange={props.onAutostart}
          />
        </li>

        <li>
          <button type="button" className={rowButtonClass} data-slot="desktop-pairing" onClick={props.onPairing}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base">{t('pairing.row')}</span>
              <span className="text-sm text-muted-foreground">{t('pairing.rowHint')}</span>
            </span>
            <KeyRound className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </li>

        <li>
          <button
            type="button"
            className={rowButtonClass}
            data-slot="desktop-update"
            disabled={props.checking}
            onClick={props.onCheckUpdate}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base">{t('update.row')}</span>
              <span className={cn('text-sm', TONE_TEXT[update.tone])} data-slot="desktop-update-summary">
                {update.summary}
              </span>
            </span>
            <RefreshCw
              className={cn('size-5 shrink-0 text-muted-foreground', props.checking && 'animate-spin motion-reduce:animate-none')}
              aria-hidden="true"
            />
          </button>
        </li>
        {update.link !== null && (
          <li>
            <a
              href={update.link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${rowButtonClass} font-medium`}
              data-slot="desktop-update-link"
            >
              <span className="min-w-0 flex-1 text-base">{update.link.label}</span>
              <ExternalLink className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </a>
          </li>
        )}
      </ListGroup>

      {daemon !== null && daemon.problem !== null && (
        <div className="flex flex-col gap-2" data-slot="desktop-daemon-problem">
          <ErrorNotice message={daemon.problem} />
          {daemon.logTail.length > 0 && (
            <details className="pl-1 text-sm text-muted-foreground">
              <summary className="min-h-11 cursor-pointer py-2">{t('daemon.logTail')}</summary>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 text-foreground">
                {daemon.logTail.join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <ListGroup label={t('tailscale.title')}>
          <li className={listRowClass} data-slot="desktop-tailscale">
            <label htmlFor={tailscaleId} className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base">{t('tailscale.title')}</span>
              <span className="text-sm text-muted-foreground">{t('tailscale.description')}</span>
            </label>
            <Switch
              id={tailscaleId}
              checked={tailscale?.checked === true}
              disabled={tailscale === null || props.tailscaleBusy}
              onCheckedChange={props.onTailscale}
            />
          </li>

          {tailscale !== null && tailscale.checked && (
            <li
              className={cn(listRowClass, 'items-start py-3')}
              data-slot="desktop-tailscale-status"
              data-state={props.tailscale?.state}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('flex items-center gap-2 text-base', TONE_TEXT[tailscale.tone])}>
                  <StatusDot tone={tailscale.tone} pulse={tailscale.pulse} />
                  {tailscale.title}
                </span>
                {tailscale.detail !== null && <span className="text-sm text-muted-foreground">{tailscale.detail}</span>}
              </span>
            </li>
          )}

          {tailscale !== null && tailscale.authUrl !== null && (
            <li className={listRowClass}>
              <Button asChild variant="secondary" className="flex-1">
                <a href={tailscale.authUrl} target="_blank" rel="noopener noreferrer" data-slot="desktop-tailscale-login">
                  {t('tailscale.login')}
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            </li>
          )}

          {tailscale !== null && tailscale.address !== null && (
            <>
              <li className={listRowClass}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm text-muted-foreground">{t('tailscale.address')}</span>
                  <span className="font-mono text-sm break-all" data-slot="desktop-tailscale-address">
                    {tailscale.address}
                  </span>
                </span>
                <CopyButton text={tailscale.address} label={t('tailscale.copyAddress')} />
              </li>
              <li className="flex flex-col gap-2 px-4 py-3" data-slot="desktop-tailscale-steps">
                <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  {phoneSteps(tailscale.address).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <p className="text-sm text-muted-foreground">{t('tailscale.requirements')}</p>
              </li>
            </>
          )}
        </ListGroup>
        {tailscale !== null && tailscale.problem !== null && <ErrorNotice message={tailscale.problem} />}
      </div>

      {props.failure !== null && (
        <p role="alert" className="pl-1 text-sm text-destructive">
          {t(`failure.${props.failure}`)}
        </p>
      )}
    </section>
  );
}

function DesktopPanel({ bridge }: { bridge: NanachiDesktopBridge }) {
  const [daemon] = useBridgeStatus(bridge, DAEMON_SOURCE);
  const [tailscale, setTailscale] = useBridgeStatus(bridge, TAILSCALE_SOURCE);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<DesktopFailure | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => bridge.getAutostart())
      .then((value) => {
        if (active && typeof value === 'boolean') setAutostart(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  async function changeAutostart(next: boolean) {
    setAutostartBusy(true);
    setFailure(null);
    try {
      const effective = await bridge.setAutostart(next);
      setAutostart(typeof effective === 'boolean' ? effective : next);
    } catch {
      setFailure('action');
    } finally {
      setAutostartBusy(false);
    }
  }

  async function changeTailscale(next: boolean) {
    setTailscaleBusy(true);
    setFailure(null);
    try {
      const answer = parseTailscaleStatus(await (next ? bridge.tailscale.start() : bridge.tailscale.stop()));
      if (answer !== null) setTailscale(answer);
    } catch {
      setFailure('action');
    } finally {
      setTailscaleBusy(false);
    }
  }

  async function checkUpdate() {
    setChecking(true);
    setFailure(null);
    try {
      const result = parseUpdateCheck(await bridge.checkForUpdate());
      if (result === null) setFailure('update');
      else setUpdate(result);
    } catch {
      setFailure('update');
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <DesktopPanelView
        version={bridge.version}
        daemon={daemon}
        autostart={autostart}
        autostartBusy={autostartBusy}
        tailscale={tailscale}
        tailscaleBusy={tailscaleBusy}
        update={update}
        checking={checking}
        failure={failure}
        onAutostart={(next) => void changeAutostart(next)}
        onPairing={() => setPairingOpen(true)}
        onCheckUpdate={() => void checkUpdate()}
        onTailscale={(next) => void changeTailscale(next)}
      />
      {pairingOpen && <PairingCodeSheet bridge={bridge} onClose={() => setPairingOpen(false)} />}
    </>
  );
}

/**
 * Grupo "Desktop" dos Ajustes. Só existe dentro do Nanachi Desktop (Electron): fora dele `window.nanachiDesktop` não
 * existe e a seção não renderiza nada.
 */
export function DesktopSection() {
  const [bridge] = useState(() => getDesktopBridge());
  return bridge === null ? null : <DesktopPanel bridge={bridge} />;
}
