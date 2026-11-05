import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Bot, ListChecks, SquareTerminal, type LucideIcon } from 'lucide-react';
import { ListGroup, SectionHeading, listRowClass } from '../components/ListGroup.js';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { BackgroundJobRows, BackgroundStatus, backgroundStateText } from './BackgroundStatus.js';
import { formatElapsed, groupEntries, type BackgroundEntry } from './background.js';

/** Time line of a row: how long it has been running, or how long it took once it stopped. */
function timingText(entry: BackgroundEntry, now: number, t: TFunction<'chat'>): string {
  if (entry.state === 'running' || entry.state === 'unknown') {
    return t('background.startedAgo', { time: formatElapsed(now - entry.startedAt) });
  }
  return t('background.lasted', { time: formatElapsed(entry.updatedAt - entry.startedAt) });
}

interface EntryRowProps {
  entry: BackgroundEntry;
  now: number;
  onPick(id: string): void;
}

function EntryRow({ entry, now, onPick }: EntryRowProps) {
  const { t } = useTranslation('chat');
  const parts = [entry.agentType, backgroundStateText(entry.state), timingText(entry, now, t)];
  const meta = parts.filter((part): part is string => part !== undefined).join(' · ');
  return (
    <li>
      <button
        type="button"
        data-slot="background-row"
        data-item-id={entry.id}
        className={cn(
          listRowClass,
          'w-full text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent',
        )}
        onClick={() => onPick(entry.id)}
      >
        <BackgroundStatus state={entry.state} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-medium">{entry.label}</span>
          <span className="truncate text-[13px] text-muted-foreground">{meta}</span>
        </span>
      </button>
      {entry.jobs.length > 0 && (
        <div className="px-4 pb-2">
          <BackgroundJobRows jobs={entry.jobs} parent={entry.state} />
        </div>
      )}
    </li>
  );
}

interface GroupProps {
  id: string;
  icon: LucideIcon;
  title: string;
  entries: readonly BackgroundEntry[];
  now: number;
  onPick(id: string): void;
}

function Group({ id, icon, title, entries, now, onPick }: GroupProps) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <SectionHeading icon={icon} id={id}>
        {title}
      </SectionHeading>
      <ListGroup>
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} now={now} onPick={onPick} />
        ))}
      </ListGroup>
    </section>
  );
}

export interface BackgroundPanelProps {
  entries: readonly BackgroundEntry[];
  /** Current time (ms). Passed in so the rows are deterministic in tests. */
  now: number;
  /** Called with the chat item id of the row that was tapped. */
  onPick(id: string): void;
}

/** The drawer's content: every background item grouped as Subagentes, Comandos and Jobs. No Drawer, so tests can render it. */
export function BackgroundPanel({ entries, now, onPick }: BackgroundPanelProps) {
  const { t } = useTranslation('chat');
  if (entries.length === 0) {
    return <p className="py-8 text-center text-[15px] text-muted-foreground">{t('background.empty')}</p>;
  }
  const groups = groupEntries(entries);
  return (
    <div className="flex flex-col gap-5">
      <Group id="background-subagents" icon={Bot} title={t('background.subagents')} entries={groups.subagents} now={now} onPick={onPick} />
      <Group
        id="background-commands"
        icon={SquareTerminal}
        title={t('background.commands')}
        entries={groups.commands}
        now={now}
        onPick={onPick}
      />
      <Group id="background-jobs" icon={ListChecks} title={t('background.jobs')} entries={groups.jobs} now={now} onPick={onPick} />
    </div>
  );
}

/** Current time, refreshed each second while the drawer is open, so the elapsed times keep moving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export interface BackgroundDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  entries: readonly BackgroundEntry[];
  onPick(id: string): void;
}

/** "Segundo plano" drawer, opened by the header chip. Rises from the bottom like every other overlay. */
export function BackgroundDrawer({ open, onOpenChange, entries, onPick }: BackgroundDrawerProps) {
  const { t } = useTranslation('chat');
  const now = useNow(open);
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('background.title')}</DrawerTitle>
        </DrawerHeader>
        <div className="min-h-0 overflow-y-auto px-4 pt-3 pb-[max(env(safe-area-inset-bottom,0px),16px)]">
          <BackgroundPanel entries={entries} now={now} onPick={onPick} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
