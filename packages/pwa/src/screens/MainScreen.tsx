import { ChevronsUpDown, FolderOpen, Link2, Plus, Settings, ShieldExclamationPoint, Trash } from 'lucide-react';
import type { ConnectionStatus } from '../connection.js';
import type { SessionTarget } from '../push/notificationRoute.js';
import type { Machine } from '../machines.js';
import { summarize, summaryLabels } from '../machineOverview.js';
import { useMachineOverviews } from '../useMachineOverviews.js';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MachineCard } from '../components/MachineCard.js';
import { Screen } from '../components/Screen.js';
import { StatusDot, TONE_TEXT, type StatusTone } from '../components/StatusDot.js';
import { ForceUpdateAction } from '../updates/ForceUpdateAction.js';
import { cn } from '@/lib/utils';

interface MainScreenProps {
  machines: readonly Machine[];
  selected: Machine;
  statuses: Readonly<Record<string, ConnectionStatus>>;
  onSelect(id: string): void;
  onAdd(): void;
  onRemove(machine: Machine): void;
  onRepair(machine: Machine): void;
  onOpenWorkspaces(): void;
  onOpenSettings(): void;
  onOpenSession(target: SessionTarget): void;
}

interface StatusText {
  label: string;
  hint: string;
  tone: StatusTone;
  pulse: boolean;
}

const STATUS_TEXT: Record<ConnectionStatus, StatusText> = {
  online: { label: 'Online', hint: 'Conectado ao daemon desta máquina.', tone: 'success', pulse: false },
  connecting: { label: 'Conectando…', hint: 'Abrindo a conexão com o PC.', tone: 'muted', pulse: true },
  offline: {
    label: 'Offline',
    hint: 'Sem conexão com o PC. Tentando de novo automaticamente.',
    tone: 'muted',
    pulse: false,
  },
  unauthorized: {
    label: 'Não autorizado',
    hint: 'Este celular não tem mais acesso a esta máquina. Pareie de novo com um código novo.',
    tone: 'danger',
    pulse: false,
  },
};

/** Nome da máquina no título, com as outras máquinas num menu (uma delas é a selecionada). */
function MachineSwitcher({
  machines,
  selected,
  statuses,
  onSelect,
}: Pick<MainScreenProps, 'machines' | 'selected' | 'statuses' | 'onSelect'>) {
  const selectedStatus = statuses[selected.id] ?? 'connecting';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="-ml-3 max-w-full justify-start px-3 text-xl font-semibold tracking-tight">
          <StatusDot tone={STATUS_TEXT[selectedStatus].tone} pulse={STATUS_TEXT[selectedStatus].pulse} />
          <span className="truncate">{selected.name}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuRadioGroup value={selected.id} onValueChange={onSelect}>
          {machines.map((machine) => {
            const status = STATUS_TEXT[statuses[machine.id] ?? 'connecting'];
            return (
              <DropdownMenuRadioItem key={machine.id} value={machine.id}>
                <StatusDot tone={status.tone} pulse={status.pulse} />
                <span className="truncate">{machine.name}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MainScreen({
  machines,
  selected,
  statuses,
  onSelect,
  onAdd,
  onRemove,
  onRepair,
  onOpenWorkspaces,
  onOpenSettings,
  onOpenSession,
}: MainScreenProps) {
  const status = statuses[selected.id] ?? 'connecting';
  const text = STATUS_TEXT[status];
  const overviews = useMachineOverviews(machines);
  const now = Date.now();
  const summary = summarize(machines.map((machine) => ({ machineId: machine.id, overview: overviews[machine.id] })));
  const labels = summaryLabels(summary);
  const awaitingTarget = summary.awaitingTarget;

  return (
    // `isolate` keeps the backdrop (z-index -10) above the screen background and below the content.
    <Screen className="isolate">
      {/* Decorative app icon behind the content. The icon is black on black: in light mode it is inverted so the
          figure reads as a faint dark mark; in dark mode it is drawn as is. */}
      <img
        src="/icon-512.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none fixed top-1/2 left-1/2 -z-10 w-[min(80vw,420px)] -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.05] invert dark:opacity-[0.08] dark:invert-0"
      />

      <header className="flex min-h-11 items-center justify-between gap-2">
        <h1 className="min-w-0 flex-1">
          <MachineSwitcher machines={machines} selected={selected} statuses={statuses} onSelect={onSelect} />
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <ForceUpdateAction />
          <Button variant="ghost" size="icon" aria-label="Ajustes" onClick={onOpenSettings}>
            <Settings aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Adicionar máquina" onClick={onAdd}>
            <Plus aria-hidden="true" />
          </Button>
        </div>
      </header>

      <section aria-label="Estado da máquina" className="flex flex-col gap-2">
        <p aria-live="polite" className={cn('flex items-center gap-2 text-sm font-medium', TONE_TEXT[text.tone])}>
          <StatusDot tone={text.tone} pulse={text.pulse} />
          {text.label}
        </p>
        <p className="text-base leading-6 text-muted-foreground">{text.hint}</p>
      </section>

      <section aria-label="Resumo das máquinas" className="flex flex-col gap-3">
        <div aria-live="polite" className="flex min-h-11 flex-wrap items-center gap-x-1 text-base">
          {labels.running !== null && <span>{labels.running}</span>}
          {labels.running !== null && labels.awaiting !== null && (
            <span aria-hidden="true" className="px-1 text-muted-foreground">
              ·
            </span>
          )}
          {labels.awaiting !== null &&
            (awaitingTarget === null ? (
              <span>{labels.awaiting}</span>
            ) : (
              <Button
                variant="ghost"
                className="-ml-2 h-11 gap-1.5 px-2 font-medium text-attention"
                onClick={() => {
                  if (awaitingTarget !== null) onOpenSession(awaitingTarget);
                }}
              >
                <ShieldExclamationPoint aria-hidden="true" />
                {labels.awaiting}
              </Button>
            ))}
          {labels.running === null && labels.awaiting === null && (
            <span className="text-muted-foreground">Nenhuma sessão rodando</span>
          )}
        </div>

        <ul aria-label="Máquinas" className="flex flex-col gap-3">
          {machines.map((machine) => (
            <MachineCard
              key={machine.id}
              machine={machine}
              overview={overviews[machine.id]}
              connection={statuses[machine.id] ?? 'connecting'}
              selected={machine.id === selected.id}
              now={now}
              onSelect={() => onSelect(machine.id)}
              onOpenSession={onOpenSession}
            />
          ))}
        </ul>
      </section>

      <div className="mt-auto flex flex-col gap-2 pt-2">
        {status === 'unauthorized' ? (
          <Button size="wide" onClick={() => onRepair(selected)}>
            <Link2 aria-hidden="true" />
            Parear de novo
          </Button>
        ) : (
          <Button size="wide" onClick={onOpenWorkspaces}>
            <FolderOpen aria-hidden="true" />
            Workspaces
          </Button>
        )}
        <Button variant="destructive-ghost" size="wide" onClick={() => onRemove(selected)}>
          <Trash aria-hidden="true" />
          Remover máquina
        </Button>
      </div>
    </Screen>
  );
}
