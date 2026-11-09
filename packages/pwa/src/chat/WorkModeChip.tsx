import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleSlash,
  Circle,
  Eye,
  ListChecks,
  PencilLine,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { SelectOption } from '../agentConfig.js';
import { ActionSheet, type ActionSheetItem } from '../components/ActionSheet.js';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import {
  friendlyWorkModes,
  isDangerousModeId,
  workModeKindOf,
  workModeNameOf,
  type WorkModeKind,
} from './workMode.js';

const ICON_BY_KIND: Readonly<Record<WorkModeKind, LucideIcon>> = {
  readOnly: Eye,
  ask: ShieldCheck,
  acceptEdits: PencilLine,
  plan: ListChecks,
  auto: Sparkles,
  dontAsk: CircleSlash,
  bypass: ShieldOff,
};

/** Layout of the chip's outer element. The label and the button share it, so a one-mode chip keeps the same place. */
const CHIP_CLASS = '-my-2.5 flex min-w-0 max-w-[60%] shrink items-center py-2.5 disabled:opacity-60';

/** A mode id this module does not know gets a neutral dot: its name is the agent's own. */
function iconOf(id: string, agentId: string | undefined): LucideIcon {
  const kind = workModeKindOf(id, agentId);
  return kind === undefined ? Circle : ICON_BY_KIND[kind];
}

interface WorkModeChipProps {
  /** The session's mode select (category `mode`), with the agent's choices. */
  option: SelectOption | undefined;
  /** Asks to switch to `value`. The caller decides whether to confirm it first, and sends it. */
  onPick(value: string): void;
  /** The agent cannot take a change now (stopped, failed or still starting): the chip shows the mode, and does not open. */
  disabled?: boolean;
  /** The session's agent, whose own mode meanings name the modes (see workMode.ts). Without it the shared names apply. */
  agentId?: string | undefined;
  yolo?: { enabled: boolean; onChange(enabled: boolean): void };
}

/**
 * The rows of the chip's list: the friendly names, the agent's description as the detail line, the current mode checked,
 * and a dangerous mode in the danger tone. The chip is its only caller.
 */
export function workModeItems(
  option: SelectOption,
  labelOf: (kind: WorkModeKind) => string,
  onPick: (value: string) => void,
  agentId?: string,
): ActionSheetItem[] {
  return friendlyWorkModes(option.options, labelOf, agentId).map((choice) => ({
    label: choice.name,
    detail: choice.description ?? undefined,
    icon: iconOf(choice.value, agentId),
    checked: choice.value === option.currentValue,
    tone: isDangerousModeId(choice.value, agentId) ? 'danger' : undefined,
    onSelect: () => onPick(choice.value),
  }));
}

/**
 * The chat's work modes and the independent Nanachi approval setting share one entry point.
 */
export function WorkModeChip({ option, onPick, disabled = false, agentId, yolo }: WorkModeChipProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);
  const labelOf = (kind: WorkModeKind): string => t(`agentConfig.workMode.${kind}`);
  const value = option?.currentValue ?? '';
  const current = option?.options.find((choice) => choice.value === value);
  const providerName = current === undefined ? value || t('agentConfig.workMode.title') : workModeNameOf(current, labelOf, agentId);
  const dangerous = isDangerousModeId(value, agentId);
  const kind = workModeKindOf(value, agentId) ?? 'other';
  const limited = agentId !== 'claude' || kind !== 'ask';
  const yoloDetail = t(limited ? 'agentConfig.workMode.yoloLimited' : 'agentConfig.workMode.yoloDetail');
  const currentName = yolo?.enabled ? 'YOLO' : providerName;
  const Icon = yolo?.enabled ? (limited ? ShieldAlert : Zap) : iconOf(value, agentId);
  const items = option === undefined ? [] : workModeItems(option, labelOf, onPick, agentId);
  if (yolo !== undefined) {
    for (const item of items) item.section = t('agentConfig.workMode.providerModes');
    items.push({
      label: 'YOLO',
      detail: yoloDetail,
      section: 'Nanachi',
      icon: limited ? ShieldAlert : Zap,
      checked: yolo.enabled,
      haspopup: yolo.enabled ? undefined : 'dialog',
      keepsFocus: yolo.enabled,
      onSelect: () => {
        if (yolo.enabled) yolo.onChange(false);
        else setConfirmYolo(true);
      },
    });
  }
  const pill = (
    <span
      className={cn(
        'flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        dangerous ? 'bg-destructive/10 text-destructive' : yolo?.enabled ? 'bg-primary/10 text-primary' : 'bg-secondary text-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{currentName}</span>
    </span>
  );

  // One mode leaves nothing to choose: the chip names it, in the same place and size, and nothing opens.
  if (yolo === undefined && (option?.options.length ?? 0) <= 1) {
    return (
      <span
        data-slot="work-mode-chip"
        data-kind={kind}
        data-danger={dangerous ? 'true' : undefined}
        className={CHIP_CLASS}
      >
        {pill}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        data-slot="work-mode-chip"
        data-kind={yolo?.enabled ? 'yolo' : kind}
        data-danger={dangerous ? 'true' : undefined}
        aria-label={t('agentConfig.workMode.chipLabel', { label: currentName })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={yolo?.enabled ? yoloDetail : undefined}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={CHIP_CLASS}
      >
        {pill}
      </button>
      {open && (
        <ActionSheet
          label={t('agentConfig.workMode.title')}
          title={t('agentConfig.workMode.title')}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
      {confirmYolo && yolo !== undefined && (
        <WorkModeConfirmSheet
          yolo
          onCancel={() => setConfirmYolo(false)}
          onConfirm={() => {
            setConfirmYolo(false);
            yolo.onChange(true);
          }}
        />
      )}
    </>
  );
}

interface WorkModeConfirmSheetProps {
  yolo?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * Asks before a switch into a dangerous mode (bypass). Shown by whoever sends the change, so the chip, the Session
 * settings drawer, the command picker and the new session sheet all confirm the same way.
 */
export function WorkModeConfirmSheet({ yolo = false, onCancel, onConfirm }: WorkModeConfirmSheetProps) {
  const { t } = useTranslation('chat');
  return (
    <Drawer
      open
      dismissible
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DrawerContent size="sm">
        <DrawerHeader>
          <DrawerTitle>{t(yolo ? 'agentConfig.workMode.yoloConfirmTitle' : 'agentConfig.workMode.confirmTitle')}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {t(yolo ? 'agentConfig.workMode.yoloConfirmBody' : 'agentConfig.workMode.confirmBody')}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerFooter className="flex-row wide:justify-end wide:pt-2 wide:pb-5">
          <Button variant="secondary" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onCancel}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button variant={yolo ? 'default' : 'destructive'} size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onConfirm}>
            {t(yolo ? 'agentConfig.workMode.yoloConfirmAction' : 'agentConfig.workMode.confirmAction')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
