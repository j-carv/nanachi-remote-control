import { ArrowDownToLine, Copy, FolderOpen } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { LogsInfo } from '../../common/control-api.js';
import { copyText } from '../lib/clipboard.js';
import { classifyLogLine, isNearBottom, sameLines } from '../lib/logs.js';
import { useApi } from '../state/api.js';
import { useReported } from '../state/reported.js';
import { plain, useResource } from '../state/resource.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { ErrorState } from '../ui/States.js';
import { Skeleton } from '../ui/Skeleton.js';
import { useToast } from '../ui/Toast.js';
import { Page } from './Page.js';

/** A poll that brings the same lines is not a change. */
function logsEqual(previous: unknown, next: unknown): boolean {
  const a = previous as LogsInfo;
  const b = next as LogsInfo;
  return sameLines(a.daemon, b.daemon) && sameLines(a.tailscale, b.tailscale);
}

export type LogTab = 'daemon' | 'tailscale';

const TABS: ReadonlyArray<{ id: LogTab; label: string }> = [
  { id: 'daemon', label: 'Daemon' },
  { id: 'tailscale', label: 'Tailscale' },
];

const LEVEL_CLASS = { error: 'text-destructive', warn: 'text-attention', info: 'text-foreground' } as const;

export interface LogViewerProps {
  lines: readonly string[];
  emptyText: string;
  /** Reports whether the viewer is following the end of the log (false once the user scrolls up). */
  onFollowChange?: (following: boolean) => void;
  /** Bumped by the parent to jump back to the end and follow again. */
  resumeToken?: number;
}

/**
 * The log text. New lines keep the view at the end while the user is there; scrolling up pauses that (the toolbar says
 * so and offers the way back). Content that does not change is not re-rendered.
 */
export function LogViewer({ lines, emptyText, onFollowChange, resumeToken = 0 }: LogViewerProps) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastResume = useRef(resumeToken);

  const setFollowing = useCallback(
    (value: boolean): void => {
      if (following.current === value) return;
      following.current = value;
      onFollowChange?.(value);
    },
    [onFollowChange],
  );

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    if (lastResume.current !== resumeToken) {
      lastResume.current = resumeToken;
      setFollowing(true);
    }
    if (following.current) element.scrollTop = element.scrollHeight;
  }, [lines, resumeToken, setFollowing]);

  return (
    <div
      ref={box}
      role="log"
      // A log region announces every new line by default; this one refreshes every 2 s, so it would talk over the user.
      aria-live="off"
      aria-label="Linhas do log"
      tabIndex={0}
      onScroll={(event) => setFollowing(isNearBottom(event.currentTarget))}
      className="selectable min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card px-3.5 py-3 font-mono text-[12px] leading-[19px]"
    >
      {lines.length === 0 ? (
        <p className="font-sans text-[13px] text-muted-foreground">{emptyText}</p>
      ) : (
        lines.map((line, index) => (
          <div key={index} data-level={classifyLogLine(line)} className={cx('break-all whitespace-pre-wrap', LEVEL_CLASS[classifyLogLine(line)])}>
            {line === '' ? ' ' : line}
          </div>
        ))
      )}
    </div>
  );
}

export interface LogsViewProps {
  logs: LogsInfo;
  tab: LogTab;
  onTab: (tab: LogTab) => void;
  following: boolean;
  onFollowChange: (following: boolean) => void;
  resumeToken: number;
  onResume: () => void;
  onCopy: () => void;
  onOpenFolder: () => void;
}

export function LogsView({ logs, tab, onTab, following, onFollowChange, resumeToken, onResume, onCopy, onOpenFolder }: LogsViewProps) {
  const lines = tab === 'daemon' ? logs.daemon : logs.tailscale;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <div role="tablist" aria-label="Qual log" className="inline-flex rounded-lg bg-muted p-0.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`logs-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="logs-panel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => onTab(item.id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const next = TABS.find((candidate) => candidate.id !== item.id);
                if (next) {
                  onTab(next.id);
                  document.getElementById(`logs-tab-${next.id}`)?.focus();
                }
              }}
              className={cx(
                'h-7 rounded-md px-3.5 text-[13px] font-medium transition-colors duration-150',
                tab === item.id ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--ui-border),0_1px_2px_rgb(0_0_0/0.06)]' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{lines.length === 1 ? '1 linha' : `${lines.length} linhas`}</span>
        <div className="ml-auto flex items-center gap-2">
          {following ? null : (
            <Button variant="outline" icon={<ArrowDownToLine aria-hidden="true" />} onClick={onResume}>
              Rolagem pausada · ir para o fim
            </Button>
          )}
          <Button icon={<Copy aria-hidden="true" />} disabled={lines.length === 0} onClick={onCopy}>
            Copiar
          </Button>
          <Button icon={<FolderOpen aria-hidden="true" />} onClick={onOpenFolder}>
            Abrir pasta dos logs
          </Button>
        </div>
      </div>
      <div id="logs-panel" role="tabpanel" aria-labelledby={`logs-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        <LogViewer
          key={tab}
          lines={lines}
          emptyText={tab === 'daemon' ? 'O daemon ainda não escreveu nada.' : 'Ainda não há linhas do Tailscale embutido no log do daemon. Elas aparecem aqui, com o prefixo [tsnet], quando ele rodar.'}
          onFollowChange={onFollowChange}
          resumeToken={resumeToken}
        />
      </div>
    </div>
  );
}

export function LogsSection() {
  const api = useApi();
  const toast = useToast();
  const reported = useReported();
  const logs = useResource(() => plain(() => api.logs.get()), { intervalMs: 2000, equals: logsEqual });
  const [tab, setTab] = useState<LogTab>('daemon');
  const [following, setFollowing] = useState(true);
  const [resumeToken, setResumeToken] = useState(0);
  const stable = logs.state.status === 'ready' ? logs.state.data : null;

  const copy = async (): Promise<void> => {
    if (!stable) return;
    const lines = tab === 'daemon' ? stable.daemon : stable.tailscale;
    if (await copyText(lines.join('\n'))) toast({ tone: 'success', message: 'Log copiado.' });
    else toast({ tone: 'error', message: 'Não foi possível copiar.' });
  };

  let body;
  if (logs.state.status === 'error') body = <ErrorState error={logs.state.error} onRetry={() => void logs.reload()} />;
  else if (!stable) body = <Skeleton className="min-h-0 flex-1 rounded-lg" />;
  else {
    body = (
      <LogsView
        logs={stable}
        tab={tab}
        onTab={(next) => {
          setTab(next);
          setFollowing(true);
        }}
        following={following}
        onFollowChange={setFollowing}
        resumeToken={resumeToken}
        onResume={() => setResumeToken((token) => token + 1)}
        onCopy={() => void copy()}
        onOpenFolder={() => reported(() => api.logs.openFolder(), 'Não foi possível abrir a pasta dos logs.')}
      />
    );
  }

  return (
    <Page section="logs" fill>
      {body}
    </Page>
  );
}
