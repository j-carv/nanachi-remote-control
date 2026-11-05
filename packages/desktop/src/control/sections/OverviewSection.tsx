import { ChevronRight, FolderOpen, MessagesSquare, Network, Play, RotateCw, Server, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ControlSection, OverviewInfo } from '../../common/control-api.js';
import type { DaemonStatus, TailscaleStatus } from '../../common/types.js';
import { restartedMessage } from '../lib/save.js';
import { daemonSummary, tailscaleSummary, type StatusSummary } from '../lib/status.js';
import { useApi } from '../state/api.js';
import { useReported } from '../state/reported.js';
import { useShell } from '../state/shell.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { CopyButton } from '../ui/CopyButton.js';
import { cx } from '../ui/cx.js';
import { Notice } from '../ui/Notice.js';
import { StatusDot } from '../ui/StatusDot.js';
import { ErrorState, GroupSkeleton } from '../ui/States.js';
import { Fact, Group, Row, SectionHeading } from '../ui/Surface.js';
import { useToast } from '../ui/Toast.js';
import { TONE_TEXT } from '../ui/tone.js';
import { Page } from './Page.js';
import { RestartDialog } from './RestartDialog.js';

function StatusWord({ summary }: { summary: StatusSummary }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[13px] font-medium', TONE_TEXT[summary.tone])}>
      <StatusDot tone={summary.tone} pulse={summary.pulse} />
      {summary.word}
    </span>
  );
}

export interface OverviewViewProps {
  info: OverviewInfo;
  restarting: boolean;
  tailscaleBusy: boolean;
  onRestart: () => void;
  onStartTailscale: () => void;
  onTailscaleLogin: (url: string) => void;
  onNavigate: (section: ControlSection) => void;
  onOpenDataFolder: () => void;
}

/**
 * What the daemon card offers for the process: restart a daemon Desktop runs, and start again one that stopped or failed
 * (a failed start leaves nothing owned, `mode` is `none`, and that is exactly when a retry is wanted). A daemon Desktop did
 * not start is not Desktop's to restart.
 */
export function daemonAction(daemon: DaemonStatus): { label: string; icon: 'restart' | 'start' } | null {
  if (daemon.mode === 'attached') return null;
  if (daemon.state === 'error') return { label: 'Tentar de novo', icon: 'restart' };
  if (daemon.state === 'stopped') return { label: 'Iniciar', icon: 'start' };
  return { label: 'Reiniciar', icon: 'restart' };
}

function DaemonRow({ daemon, restarting, onRestart }: { daemon: DaemonStatus; restarting: boolean; onRestart: () => void }) {
  const summary = daemonSummary(daemon);
  const action = daemonAction(daemon);
  return (
    <Row
      icon={Server}
      title={
        <span className="flex items-center gap-2.5">
          Daemon <StatusWord summary={summary} />
        </span>
      }
      description={
        <>
          <div>{summary.detail}</div>
          <div className="mt-0.5 flex flex-wrap gap-x-4">
            <Fact label="Porta">{daemon.port}</Fact>
            {daemon.version ? <Fact label="Versão">{daemon.version}</Fact> : null}
            {daemon.pid !== null ? <Fact label="PID">{daemon.pid}</Fact> : null}
          </div>
        </>
      }
      trailing={
        action ? (
          <Button icon={action.icon === 'start' ? <Play aria-hidden="true" /> : <RotateCw aria-hidden="true" />} loading={restarting} onClick={onRestart}>
            {action.label}
          </Button>
        ) : null
      }
    />
  );
}

function TailscaleRow({ status, busy, onStart, onLogin, onNavigate }: { status: TailscaleStatus; busy: boolean; onStart: () => void; onLogin: (url: string) => void; onNavigate: () => void }) {
  const summary = tailscaleSummary(status);
  const address = status.state === 'running' ? `https://${status.dnsName}` : null;
  let trailing = null;
  if (status.state === 'off') {
    trailing = (
      <Button variant="secondary" loading={busy} onClick={onStart}>
        Ligar
      </Button>
    );
  } else if (status.state === 'needs_login') {
    trailing = (
      <Button variant="primary" onClick={() => onLogin(status.authUrl)}>
        Entrar no Tailscale
      </Button>
    );
  } else if (status.state === 'running' && address) {
    trailing = (
      <>
        <CopyButton text={address} label="Copiar endereço" />
        <Button variant="ghost" onClick={onNavigate}>
          Gerenciar
        </Button>
      </>
    );
  } else if (status.state === 'error') {
    trailing = (
      <Button variant="ghost" onClick={onNavigate}>
        Ver detalhes
      </Button>
    );
  }
  return (
    <Row
      icon={Network}
      title={
        <span className="flex items-center gap-2.5">
          Tailscale <StatusWord summary={summary} />
        </span>
      }
      description={
        address ? (
          <>
            <div>Endereço para o iPhone</div>
            <div className="selectable mt-0.5 truncate font-mono text-[12px] text-foreground">{address}</div>
          </>
        ) : (
          summary.detail
        )
      }
      trailing={trailing}
    />
  );
}

function ActivityRow({ label, value, hint, onOpen }: { label: string; value: number; hint?: string | undefined; onOpen?: (() => void) | undefined }) {
  const content = (
    <>
      <span className="flex-1 text-left text-sm">{label}</span>
      {hint ? <Badge tone="running">{hint}</Badge> : null}
      <span className="min-w-8 text-right text-sm font-medium tabular-nums">{value}</span>
      {onOpen ? <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" /> : <span className="w-4" />}
    </>
  );
  const className = 'flex h-11 w-full items-center gap-3 px-4';
  return onOpen ? (
    <button type="button" onClick={onOpen} className={cx(className, 'focus-inset hover:bg-accent')}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

/** The overview, as plain data in and callbacks out. */
export function OverviewView({ info, restarting, tailscaleBusy, onRestart, onStartTailscale, onTailscaleLogin, onNavigate, onOpenDataFolder }: OverviewViewProps) {
  const { daemon, tailscale, activity } = info;
  return (
    <>
      {daemon.restricted ? (
        <Notice tone="attention" title="Acesso local bloqueado">
          {daemon.message ??
            'O daemon só aceita acessos pelo Tailscale (allowedTailscaleLogins no config.json), então este painel não consegue usá-lo. Esvazie essa lista na pasta de dados do Nanachi.'}
        </Notice>
      ) : null}
      {daemon.state === 'error' ? (
        <Notice tone="destructive" title="O daemon não conseguiu iniciar">
          {daemon.message ?? 'Veja as últimas linhas do log para entender o motivo.'}
          {daemon.logTail.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-default text-foreground">Últimas linhas do log</summary>
              <pre className="selectable mt-1.5 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-foreground">
                {daemon.logTail.join('\n')}
              </pre>
            </details>
          ) : null}
        </Notice>
      ) : null}

      <section aria-labelledby="overview-services">
        <SectionHeading id="overview-services">Serviços</SectionHeading>
        <Group>
          <DaemonRow daemon={daemon} restarting={restarting} onRestart={onRestart} />
          <TailscaleRow status={tailscale} busy={tailscaleBusy} onStart={onStartTailscale} onLogin={onTailscaleLogin} onNavigate={() => onNavigate('tailscale')} />
          <Row
            icon={FolderOpen}
            title="Pasta de dados"
            description={<span className="selectable block truncate font-mono text-[12px]">{info.dataFolder}</span>}
            trailing={
              <Button icon={<FolderOpen aria-hidden="true" />} onClick={onOpenDataFolder}>
                Abrir pasta
              </Button>
            }
          />
        </Group>
      </section>

      <section aria-labelledby="overview-activity">
        <SectionHeading id="overview-activity">Atividade</SectionHeading>
        {activity ? (
          <Group>
            <ActivityRow label="Workspaces" value={activity.workspaces} />
            <ActivityRow label="Sessões" value={activity.sessions} hint={activity.busySessions > 0 ? `${activity.busySessions} em andamento` : undefined} />
            <ActivityRow label="Aparelhos pareados" value={activity.devices} onOpen={() => onNavigate('devices')} />
          </Group>
        ) : (
          <Notice>Os números de atividade não estão disponíveis agora: o daemon não respondeu ou não reconheceu este app.</Notice>
        )}
      </section>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <GroupSkeleton rows={3} />
      <GroupSkeleton rows={3} />
    </>
  );
}

export function OverviewSection() {
  const api = useApi();
  const shell = useShell();
  const toast = useToast();
  const reported = useReported();
  const { reloadOverview } = shell;
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [tailscaleBusy, setTailscaleBusy] = useState(false);

  useEffect(() => {
    void reloadOverview(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reloadOverview(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [reloadOverview]);

  const restart = async (): Promise<void> => {
    setRestarting(true);
    try {
      const result = await api.restartDaemon();
      if (result.ok) toast(restartedMessage(result.value));
      else toast({ tone: 'error', title: 'Não foi possível reiniciar', message: result.message });
    } catch {
      toast({ tone: 'error', message: 'Não foi possível reiniciar o daemon.' });
    } finally {
      setRestarting(false);
      setConfirmRestart(false);
      void reloadOverview(true);
    }
  };

  const startTailscale = async (): Promise<void> => {
    setTailscaleBusy(true);
    try {
      shell.setTailscale(await api.tailscale.start());
    } catch {
      toast({ tone: 'error', message: 'Não foi possível ligar o Tailscale.' });
    } finally {
      setTailscaleBusy(false);
    }
  };

  const actions = (
    <>
      <Button icon={<Smartphone aria-hidden="true" />} onClick={() => shell.navigate('devices', { pairing: true })}>
        Parear iPhone
      </Button>
      <Button variant="primary" icon={<MessagesSquare aria-hidden="true" />} onClick={shell.openSessions}>
        Abrir sessões
      </Button>
    </>
  );

  let body;
  if (shell.overview.status === 'loading') body = <OverviewSkeleton />;
  else if (shell.overview.status === 'error') body = <ErrorState error={shell.overview.error} onRetry={() => void reloadOverview()} />;
  else {
    const info: OverviewInfo = { ...shell.overview.data, daemon: shell.daemon ?? shell.overview.data.daemon, tailscale: shell.tailscale ?? shell.overview.data.tailscale };
    body = (
      <OverviewView
        info={info}
        restarting={restarting}
        tailscaleBusy={tailscaleBusy}
        // Only a daemon that is up has sessions to interrupt; starting one that stopped or failed needs no question.
        onRestart={() => (info.daemon.state === 'running' ? setConfirmRestart(true) : void restart())}
        onStartTailscale={() => void startTailscale()}
        onTailscaleLogin={(url) => reported(() => api.tailscale.openLogin(url), 'Não foi possível abrir a página de login do Tailscale.')}
        onNavigate={(section) => shell.navigate(section)}
        onOpenDataFolder={() => reported(() => api.openDataFolder(), 'Não foi possível abrir a pasta de dados.')}
      />
    );
  }

  return (
    <Page section="overview" actions={actions}>
      {body}
      <RestartDialog
        open={confirmRestart}
        mode="restart"
        busySessions={shell.overview.status === 'ready' ? (shell.overview.data.activity?.busySessions ?? 0) : 0}
        busy={restarting}
        onCancel={() => setConfirmRestart(false)}
        onLater={() => setConfirmRestart(false)}
        onNow={() => void restart()}
      />
    </Page>
  );
}
