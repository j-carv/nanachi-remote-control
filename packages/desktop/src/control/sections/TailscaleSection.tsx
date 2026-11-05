import { ExternalLink, Globe, Network, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ControlError } from '../../common/control-api.js';
import type { TailscaleStatus } from '../../common/types.js';
import { toControlError } from '../lib/errors.js';
import { tailscaleSummary } from '../lib/status.js';
import { useApi } from '../state/api.js';
import { useReported } from '../state/reported.js';
import { useShell } from '../state/shell.js';
import { Button } from '../ui/Button.js';
import { CopyButton } from '../ui/CopyButton.js';
import { cx } from '../ui/cx.js';
import { Notice } from '../ui/Notice.js';
import { StatusDot } from '../ui/StatusDot.js';
import { ErrorState, GroupSkeleton } from '../ui/States.js';
import { Group, Row, SectionHeading } from '../ui/Surface.js';
import { Switch } from '../ui/Switch.js';
import { useToast } from '../ui/Toast.js';
import { TONE_TEXT } from '../ui/tone.js';
import { Page } from './Page.js';

export interface TailscaleViewProps {
  status: TailscaleStatus;
  /** A start or stop request is in flight. */
  busy: boolean;
  onToggle: (on: boolean) => void;
  onLogin: (url: string) => void;
  onRetry: () => void;
}

export function TailscaleView({ status, busy, onToggle, onLogin, onRetry }: TailscaleViewProps) {
  const { t } = useTranslation();
  const summary = tailscaleSummary(status, t);
  const steps = (address: string): string[] => [
    t('tailscale.step1'),
    t('tailscale.step2', { address }),
    t('tailscale.step3', { devices: t('sections.devices.label') }),
    t('tailscale.step4'),
  ];
  const on = status.state !== 'off';
  return (
    <>
      <Group>
        <Row
          icon={Network}
          title={
            <span className="flex items-center gap-2.5">
              {t('tailscale.builtIn')}
              <span className={cx('inline-flex items-center gap-1.5 text-[13px] font-medium', TONE_TEXT[summary.tone])}>
                <StatusDot tone={summary.tone} pulse={summary.pulse} />
                {summary.word}
              </span>
            </span>
          }
          id="tailscale-toggle-label"
          description={t('tailscale.description')}
          top
          trailing={<Switch checked={on} disabled={busy} labelledBy="tailscale-toggle-label" onCheckedChange={onToggle} />}
        />
      </Group>

      {status.state === 'needs_login' ? (
        <Notice
          tone="attention"
          title={t('tailscale.loginTitle')}
          action={
            <Button variant="primary" icon={<ExternalLink aria-hidden="true" />} onClick={() => onLogin(status.authUrl)}>
              {t('common.tailscaleLogin')}
            </Button>
          }
        >
          {t('tailscale.loginBody')}
        </Notice>
      ) : null}

      {status.state === 'error' ? (
        <Notice
          tone="destructive"
          title={t('tailscale.failedTitle')}
          action={
            <Button icon={<RotateCw aria-hidden="true" />} loading={busy} onClick={onRetry}>
              {t('common.retry')}
            </Button>
          }
        >
          {status.message}
        </Notice>
      ) : null}

      {status.state === 'running' ? (
        <>
          <section aria-labelledby="ts-connection">
            <SectionHeading id="ts-connection">{t('tailscale.connection')}</SectionHeading>
            <Group>
              <Row
                icon={Globe}
                title={t('common.addressForPhone')}
                description={<span className="selectable block truncate font-mono text-[12px] text-foreground">{`https://${status.dnsName}`}</span>}
                trailing={<CopyButton text={`https://${status.dnsName}`} label={t('common.copyAddress')} />}
              />
              <Row title="Tailnet" description={<span className="selectable">{status.tailnet}</span>} className="min-h-12" />
              <Row
                title={t('tailscale.ipAddresses')}
                description={
                  status.ips.length > 0 ? (
                    <span className="mt-0.5 flex flex-wrap gap-1.5">
                      {status.ips.map((ip) => (
                        <span key={ip} className="selectable rounded-md bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                          {ip}
                        </span>
                      ))}
                    </span>
                  ) : (
                    t('tailscale.noIps')
                  )
                }
              />
            </Group>
          </section>

          <section aria-labelledby="ts-steps">
            <SectionHeading id="ts-steps">{t('tailscale.stepsHeading')}</SectionHeading>
            <ol className="list-decimal space-y-1.5 rounded-lg border border-border bg-card py-3.5 pr-5 pl-9 text-[13px] leading-5 marker:text-muted-foreground">
              {steps(`https://${status.dnsName}`).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>
        </>
      ) : null}

      <p className="px-0.5 text-[13px] leading-5 text-muted-foreground">{t('tailscale.footnote')}</p>
    </>
  );
}

export function TailscaleSection() {
  const { t } = useTranslation();
  const api = useApi();
  const shell = useShell();
  const toast = useToast();
  const reported = useReported();
  const { setTailscale } = shell;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ControlError | null>(null);

  const load = useCallback((): void => {
    setFailed(null);
    api.tailscale.status().then(
      (status) => setTailscale(status),
      (error: unknown) => setFailed(toControlError(error)),
    );
  }, [api, setTailscale]);
  useEffect(() => {
    load();
  }, [load]);

  const change = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      setTailscale(await (on ? api.tailscale.start() : api.tailscale.stop()));
    } catch {
      toast({ tone: 'error', message: on ? t('common.tailscaleStartFailed') : t('tailscale.stopFailed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page section="tailscale">
      {shell.tailscale ? (
        <TailscaleView status={shell.tailscale} busy={busy} onToggle={(on) => void change(on)} onLogin={(url) => reported(() => api.tailscale.openLogin(url), t('common.openLoginFailed'))} onRetry={() => void change(true)} />
      ) : failed ? (
        <ErrorState error={failed} onRetry={load} />
      ) : (
        <GroupSkeleton rows={1} />
      )}
    </Page>
  );
}
