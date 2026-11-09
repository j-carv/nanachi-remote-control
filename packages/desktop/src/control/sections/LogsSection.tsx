import { ArrowDownToLine, Copy, FolderOpen } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LogsInfo } from '../../common/control-api.js';
import { copyText } from '../lib/clipboard.js';
import { analyzeLogLine, type LogLevel, type LogToken, type LogTokenKind } from '../lib/log-tokens.js';
import { restoreView, type LogPosition } from '../lib/log-view.js';
import { isNearBottom, sameLines } from '../lib/logs.js';
import { useApi } from '../state/api.js';
import { useLogFollowing } from '../state/log-view.js';
import { useReported } from '../state/reported.js';
import { plain, useResource } from '../state/resource.js';
import { useShell } from '../state/shell.js';
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

/** Whole-line look: a faint tint and a left edge for errors and warnings; debug and trace are dimmed. Every line has the edge, so the text lines up. */
const LINE_CLASS: Record<LogLevel, string> = {
  error: 'border-destructive bg-destructive/10',
  warn: 'border-attention bg-attention/12',
  info: 'border-transparent',
  debug: 'border-transparent text-muted-foreground',
  trace: 'border-transparent text-muted-foreground',
};

/** The colour of each kind of token, on the card in both themes. Plain text keeps the line's colour. */
const TOKEN_CLASS: Record<Exclude<LogTokenKind, 'level'>, string | undefined> = {
  timestamp: 'text-muted-foreground tabular-nums',
  string: 'text-success',
  key: 'font-medium text-foreground/80',
  number: 'text-running',
  url: 'text-running underline decoration-running/50 underline-offset-2',
  path: 'underline decoration-muted-foreground/60 underline-offset-2',
  punctuation: 'text-muted-foreground',
  frame: 'text-muted-foreground italic',
  text: undefined,
};

const LEVEL_TOKEN_CLASS: Record<LogLevel, string> = {
  error: 'font-semibold text-destructive',
  warn: 'font-semibold text-attention',
  info: 'font-medium text-running',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
};

function tokenClass(token: LogToken): string | undefined {
  return token.kind === 'level' ? LEVEL_TOKEN_CLASS[token.level] : TOKEN_CLASS[token.kind];
}

/** The tokens of one line as text and coloured spans. Joined, they are the line, so nothing about the text changes. */
function LogTokens({ tokens }: { tokens: readonly LogToken[] }) {
  return tokens.map((token, index) => {
    const className = tokenClass(token);
    return className === undefined ? token.text : (
      <span key={index} className={className}>
        {token.text}
      </span>
    );
  });
}

export interface LogViewerProps {
  lines: readonly string[];
  emptyText: string;
  /** Whether the viewer follows the end when it is shown: the state the shell keeps. Read once, on mount. */
  following?: boolean;
  /** The offset to restore on mount while the viewer is not following, clamped to the log as it is now. */
  scrollTop?: number;
  /** Reports whether the viewer is following the end of the log (false once the user scrolls up). */
  onFollowChange?: (following: boolean) => void;
  /** Reports the scroll offset as the user moves, so that the next mount can restore it. */
  onScrollChange?: (scrollTop: number) => void;
  /** Bumped by the parent to jump back to the end and follow again. */
  resumeToken?: number;
}

/**
 * The log text. New lines keep the view at the end while the user is there; scrolling up pauses that (the toolbar says
 * so and offers the way back). A viewer that is shown again starts where it was left. Content that does not change is not
 * re-rendered.
 */
export function LogViewer({
  lines,
  emptyText,
  following: followingAtMount = true,
  scrollTop: scrollTopAtMount = 0,
  onFollowChange,
  onScrollChange,
  resumeToken = 0,
}: LogViewerProps) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  // The position this viewer starts from is read once, on mount; the refs below carry it from then on.
  const [start] = useState<LogPosition>(() => ({ following: followingAtMount, scrollTop: scrollTopAtMount }));
  const following = useRef(start.following);
  const restored = useRef(false);
  const lastResume = useRef(resumeToken);
  // Tokenized once per change of the lines, not once per render (follow and scroll state render the viewer too).
  const analyzed = useMemo(() => lines.map((line) => analyzeLogLine(line)), [lines]);

  const setFollowing = useCallback(
    (value: boolean): void => {
      if (following.current === value) return;
      following.current = value;
      onFollowChange?.(value);
    },
    [onFollowChange],
  );

  // Once, on mount, after the lines are laid out: the saved offset, clamped to the log as it is now. A viewer that is not
  // following may turn out to be at the end (the log shrank), and then it follows, so the toolbar says so.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || restored.current) return;
    restored.current = true;
    const view = restoreView(start, element);
    element.scrollTop = view.scrollTop;
    setFollowing(view.following);
  }, [start, setFollowing]);

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
      aria-label={t('logs.viewer')}
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        onScrollChange?.(element.scrollTop);
        setFollowing(isNearBottom(element));
      }}
      className="animate-fade-in selectable min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card px-3.5 py-3 font-mono text-[12px] leading-[19px]"
    >
      {lines.length === 0 ? (
        <p className="font-sans text-[13px] text-muted-foreground">{emptyText}</p>
      ) : (
        analyzed.map((entry, index) => (
          <div key={index} data-level={entry.level} className={cx('border-l-2 pl-2 break-all whitespace-pre-wrap', LINE_CLASS[entry.level])}>
            {entry.tokens.length === 0 ? ' ' : <LogTokens tokens={entry.tokens} />}
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
  /** The offset this tab's viewer was left at; it restores that when it is shown again. Absent: the top. */
  scrollTop?: number;
  /** Reports the offset as the user scrolls this tab's viewer. */
  onScrollChange?: (scrollTop: number) => void;
  onCopy: () => void;
  onOpenFolder: () => void;
}

const IGNORE_SCROLL: (scrollTop: number) => void = () => undefined;

export function LogsView({
  logs,
  tab,
  onTab,
  following,
  onFollowChange,
  resumeToken,
  onResume,
  scrollTop = 0,
  onScrollChange = IGNORE_SCROLL,
  onCopy,
  onOpenFolder,
}: LogsViewProps) {
  const { t } = useTranslation();
  const lines = tab === 'daemon' ? logs.daemon : logs.tailscale;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <div role="tablist" aria-label={t('logs.tabsLabel')} className="inline-flex rounded-lg bg-muted p-0.5">
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
        <span className="text-xs text-muted-foreground tabular-nums">{t('logs.lines', { count: lines.length })}</span>
        <div className="ml-auto flex items-center gap-2">
          {following ? null : (
            <Button variant="outline" icon={<ArrowDownToLine aria-hidden="true" />} onClick={onResume}>
              {t('logs.paused')}
            </Button>
          )}
          <Button icon={<Copy aria-hidden="true" />} disabled={lines.length === 0} onClick={onCopy}>
            {t('logs.copy')}
          </Button>
          <Button icon={<FolderOpen aria-hidden="true" />} onClick={onOpenFolder}>
            {t('logs.openFolder')}
          </Button>
        </div>
      </div>
      <div id="logs-panel" role="tabpanel" aria-labelledby={`logs-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        <LogViewer
          key={tab}
          lines={lines}
          emptyText={tab === 'daemon' ? t('logs.emptyDaemon') : t('logs.emptyTailscale')}
          following={following}
          scrollTop={scrollTop}
          onFollowChange={onFollowChange}
          onScrollChange={onScrollChange}
          resumeToken={resumeToken}
        />
      </div>
    </div>
  );
}

export function LogsSection() {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const reported = useReported();
  const logs = useResource(() => plain(() => api.logs.get()), { intervalMs: 2000, equals: logsEqual });
  // The tab, and for each tab whether its viewer follows the end and where it is scrolled, live in the shell: the section
  // remounts on every switch, and the viewer restores from there.
  const { logsTab: tab, setLogsTab: setTab, logView } = useShell();
  const following = useLogFollowing(logView, tab);
  const [resumeToken, setResumeToken] = useState(0);
  const stable = logs.state.status === 'ready' ? logs.state.data : null;
  const onFollowChange = useCallback((value: boolean): void => logView.setFollowing(tab, value), [logView, tab]);
  const onScrollChange = useCallback((scrollTop: number): void => logView.setScrollTop(tab, scrollTop), [logView, tab]);

  const copy = async (): Promise<void> => {
    if (!stable) return;
    const lines = tab === 'daemon' ? stable.daemon : stable.tailscale;
    if (await copyText(lines.join('\n'))) toast({ tone: 'success', message: t('logs.copied') });
    else toast({ tone: 'error', message: t('common.copyFailed') });
  };

  let body;
  if (logs.state.status === 'error') body = <ErrorState error={logs.state.error} onRetry={() => void logs.reload()} />;
  else if (!stable) body = <Skeleton className="min-h-0 flex-1 rounded-lg" />;
  else {
    body = (
      <LogsView
        logs={stable}
        tab={tab}
        onTab={setTab}
        following={following}
        onFollowChange={onFollowChange}
        resumeToken={resumeToken}
        onResume={() => setResumeToken((token) => token + 1)}
        scrollTop={logView.getState(tab).scrollTop}
        onScrollChange={onScrollChange}
        onCopy={() => void copy()}
        onOpenFolder={() => reported(() => api.logs.openFolder(), t('logs.openFolderFailed'))}
      />
    );
  }

  return (
    <Page section="logs" fill>
      {body}
    </Page>
  );
}
