import { PanelLeft } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ControlSection } from '../../common/control-api.js';
import { SIDEBAR_RAIL_WIDTH } from '../../common/sessions-layout.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Tooltip } from '../ui/Tooltip.js';
import { SECTIONS, type SectionMeta } from './nav.js';

export const SIDEBAR_EXPANDED = 232;
export const SIDEBAR_COLLAPSED = SIDEBAR_RAIL_WIDTH;

export interface SidebarProps {
  section: ControlSection;
  collapsed: boolean;
  /** Sections with something the user should come back to (unsaved edits). */
  dirty: ReadonlySet<ControlSection>;
  version: string;
  onSelect: (section: ControlSection) => void;
  onToggle: () => void;
  /**
   * The Sessões section is selected: the PWA is drawn by main over the content area, which has to stay at least as wide as
   * the PWA's wide layout needs, so the sidebar is the 64 px rail whatever the user saved (which stays untouched) and has
   * nothing to toggle. Its tooltips are native titles: a portal of the page would be painted under the view.
   */
  sessionsOpen: boolean;
}

/** One item: 36 px high, with a 2 px gap between items. The active indicator moves in steps of that pitch (see `Sidebar`). */
const ITEM_HEIGHT_REM = 2.25;
const ITEM_PITCH_REM = ITEM_HEIGHT_REM + 0.125;

const ITEM =
  'group relative flex h-9 w-full items-center gap-3 rounded-lg px-[13px] text-[13.5px] font-medium transition-[color,background-color,scale] duration-200 ease-[var(--ease-premium)] active:scale-[0.98]';

interface NavItemProps {
  meta: SectionMeta;
  index: number;
  active: boolean;
  collapsed: boolean;
  dirty: boolean;
  /** The tooltip of the rail is the browser's own `title`, not the page's portal. */
  nativeTip: boolean;
  onSelect: () => void;
}

function NavItem({ meta, index, active, collapsed, dirty, nativeTip, onSelect }: NavItemProps) {
  const { t } = useTranslation();
  const Icon = meta.icon;
  const shortcut = `Ctrl+${index + 1}`;
  const label = t(`sections.${meta.id}.label`);
  const tip = dirty ? t('shell.sidebar.unsavedChangesIn', { label }) : label;
  const button = (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-keyshortcuts={`Control+${index + 1}`}
      aria-label={collapsed ? label : undefined}
      title={collapsed && nativeTip ? `${tip} (${shortcut})` : undefined}
      onClick={onSelect}
      className={cx(ITEM, active ? 'text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
    >
      <span className="relative grid size-[18px] shrink-0 place-items-center">
        <Icon className="size-[18px]" strokeWidth={active ? 2 : 1.75} aria-hidden="true" />
        {dirty && collapsed ? <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-attention ring-2 ring-chrome" /> : null}
      </span>
      {collapsed ? null : (
        <>
          <span className="truncate">{label}</span>
          {dirty ? (
            <>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
              <span className="sr-only">{t('shell.sidebar.unsavedChanges')}</span>
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
      {collapsed && !nativeTip ? (
        <Tooltip label={tip} shortcut={shortcut} side="right">
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

/** The sidebar: the eight sections, and the version and the collapse button at the bottom. 232 px, or 64 px with icons only (always, on Sessões). */
export function Sidebar({ section, collapsed: saved, dirty, version, onSelect, onToggle, sessionsOpen }: SidebarProps) {
  const { t } = useTranslation();
  const collapsed = saved || sessionsOpen;
  const toggleLabel = collapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse');

  // The card behind the active item is one element that slides to the item's row, so the selection moves instead of jumping.
  const activeIndex = SECTIONS.findIndex((meta) => meta.id === section);

  return (
    <nav
      id="sidebar"
      aria-label={t('shell.sidebar.label')}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-chrome transition-[width] duration-200 ease-[var(--ease-premium)]"
    >
      <div className="relative px-[9px] pt-3">
        {activeIndex === -1 ? null : (
          <span
            aria-hidden="true"
            data-slot="nav-indicator"
            style={{ transform: `translateY(${activeIndex * ITEM_PITCH_REM}rem)` }}
            className="pointer-events-none absolute inset-x-[9px] top-3 h-9 rounded-lg bg-card shadow-[0_0_0_1px_var(--ui-border),0_1px_2px_rgb(0_0_0/0.06)] transition-transform duration-300 ease-[var(--ease-premium)]"
          />
        )}
        <ul className="flex flex-col gap-0.5" onKeyDown={moveFocus}>
          {SECTIONS.map((meta, index) => (
            <NavItem key={meta.id} meta={meta} index={index} active={meta.id === section} collapsed={collapsed} dirty={dirty.has(meta.id)} nativeTip={sessionsOpen} onSelect={() => onSelect(meta.id)} />
          ))}
        </ul>
      </div>
      {sessionsOpen ? null : (
        <div className="mt-auto flex flex-col gap-2 px-[9px] pb-3">
          <div className={cx('flex h-8 items-center', collapsed ? 'justify-center' : 'justify-between pr-0.5 pl-3.5')}>
            {collapsed ? null : <span className="text-xs text-muted-foreground tabular-nums">{t('shell.sidebar.version', { version })}</span>}
            <Tooltip label={toggleLabel} shortcut="Ctrl+B" side="right">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={toggleLabel}
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
      )}
    </nav>
  );
}
