import { ArrowUpRight, PanelLeft } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { ControlSection } from '../../common/control-api.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Tooltip } from '../ui/Tooltip.js';
import { SECTIONS, SESSIONS_ACTION, type SectionMeta } from './nav.js';

export const SIDEBAR_EXPANDED = 232;
export const SIDEBAR_COLLAPSED = 64;

export interface SidebarProps {
  section: ControlSection;
  collapsed: boolean;
  /** Sections with something the user should come back to (unsaved edits). */
  dirty: ReadonlySet<ControlSection>;
  version: string;
  onSelect: (section: ControlSection) => void;
  onToggle: () => void;
  onOpenSessions: () => void;
}

const ITEM =
  'group relative flex h-9 w-full items-center gap-3 rounded-lg px-[13px] text-[13.5px] font-medium transition-colors duration-150';

function NavItem({ meta, index, active, collapsed, dirty, onSelect }: { meta: SectionMeta; index: number; active: boolean; collapsed: boolean; dirty: boolean; onSelect: () => void }) {
  const Icon = meta.icon;
  const shortcut = `Ctrl+${index + 1}`;
  const button = (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-keyshortcuts={`Control+${index + 1}`}
      aria-label={collapsed ? meta.label : undefined}
      onClick={onSelect}
      className={cx(
        ITEM,
        active ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--ui-border),0_1px_2px_rgb(0_0_0/0.06)]' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <span className="relative grid size-[18px] shrink-0 place-items-center">
        <Icon className="size-[18px]" strokeWidth={active ? 2 : 1.75} aria-hidden="true" />
        {dirty && collapsed ? <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-attention ring-2 ring-chrome" /> : null}
      </span>
      {collapsed ? null : (
        <>
          <span className="truncate">{meta.label}</span>
          {dirty ? (
            <>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
              <span className="sr-only">alterações não salvas</span>
            </>
          ) : null}
          <span aria-hidden="true" className="pointer-events-none absolute right-3 text-[11px] font-normal text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
            {shortcut}
          </span>
        </>
      )}
    </button>
  );
  return (
    <li>
      {collapsed ? (
        <Tooltip label={dirty ? `${meta.label} (alterações não salvas)` : meta.label} shortcut={shortcut} side="right">
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </li>
  );
}

/** Up and Down move the focus between the items, as in any native list. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  if (current === -1) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
  items[next]?.focus();
}

/** The sidebar: seven sections, "Abrir sessões" and the version at the bottom. 232 px, or 64 px with icons only. */
export function Sidebar({ section, collapsed, dirty, version, onSelect, onToggle, onOpenSessions }: SidebarProps) {
  const SessionsIcon = SESSIONS_ACTION.icon;
  const sessionsButton = (
    <button
      type="button"
      aria-label={collapsed ? SESSIONS_ACTION.label : undefined}
      onClick={onOpenSessions}
      className={cx(ITEM, 'border border-border bg-card text-foreground hover:bg-accent')}
    >
      <SessionsIcon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
      {collapsed ? null : (
        <>
          <span className="truncate">{SESSIONS_ACTION.label}</span>
          <ArrowUpRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
        </>
      )}
    </button>
  );

  return (
    <nav
      id="sidebar"
      aria-label="Seções"
      style={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-chrome transition-[width] duration-150 ease-out"
    >
      <ul className="flex flex-col gap-0.5 px-[9px] pt-3" onKeyDown={moveFocus}>
        {SECTIONS.map((meta, index) => (
          <NavItem key={meta.id} meta={meta} index={index} active={meta.id === section} collapsed={collapsed} dirty={dirty.has(meta.id)} onSelect={() => onSelect(meta.id)} />
        ))}
      </ul>
      <div className="mt-auto flex flex-col gap-2 px-[9px] pb-3">
        {collapsed ? (
          <Tooltip label={SESSIONS_ACTION.label} side="right">
            {sessionsButton}
          </Tooltip>
        ) : (
          sessionsButton
        )}
        <div className={cx('flex h-8 items-center', collapsed ? 'justify-center' : 'justify-between pr-0.5 pl-3.5')}>
          {collapsed ? null : <span className="text-xs text-muted-foreground tabular-nums">Versão {version}</span>}
          <Tooltip label={collapsed ? 'Expandir a barra lateral' : 'Recolher a barra lateral'} shortcut="Ctrl+B" side="right">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={collapsed ? 'Expandir a barra lateral' : 'Recolher a barra lateral'}
              aria-expanded={!collapsed}
              aria-controls="sidebar"
              aria-keyshortcuts="Control+B"
              onClick={onToggle}
            >
              <PanelLeft aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
}
