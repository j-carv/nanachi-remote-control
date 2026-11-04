import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { ConnectionStatus } from '../connection.js';
import type { Machine } from '../machines.js';

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
}

const STATUS_TEXT: Record<ConnectionStatus, { label: string; hint: string }> = {
  online: { label: 'Online', hint: 'Conectado ao daemon desta máquina.' },
  connecting: { label: 'Conectando…', hint: 'Abrindo a conexão com o PC.' },
  offline: { label: 'Offline', hint: 'Sem conexão com o PC. Tentando de novo automaticamente.' },
  unauthorized: {
    label: 'Não autorizado',
    hint: 'Este celular não tem mais acesso a esta máquina. Pareie de novo com um código novo.',
  },
};

function StatusDot({ status }: { status: ConnectionStatus }) {
  return <span className={`dot dot-${status}`} aria-hidden="true" />;
}

function MachineSwitcher({
  machines,
  selected,
  statuses,
  onSelect,
}: Pick<MainScreenProps, 'machines' | 'selected' | 'statuses' | 'onSelect'>) {
  const [open, setOpen] = useState(false);
  const selectedStatus = statuses[selected.id] ?? 'connecting';

  return (
    <div className="switcher">
      <button
        type="button"
        className="button switcher-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusDot status={selectedStatus} />
        <span className="switcher-name">{selected.name}</span>
        <CaretDown className="chevron" size={16} weight="bold" aria-hidden="true" />
      </button>

      {open && (
        <ul className="switcher-menu">
          {machines.map((machine) => (
            <li key={machine.id}>
              <button
                type="button"
                className="switcher-item"
                aria-current={machine.id === selected.id}
                onClick={() => {
                  onSelect(machine.id);
                  setOpen(false);
                }}
              >
                <StatusDot status={statuses[machine.id] ?? 'connecting'} />
                <span className="switcher-name">{machine.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
}: MainScreenProps) {
  const status = statuses[selected.id] ?? 'connecting';
  const text = STATUS_TEXT[status];

  return (
    <main className="screen">
      <header className="topbar">
        <MachineSwitcher
          machines={machines}
          selected={selected}
          statuses={statuses}
          onSelect={onSelect}
        />
        <div className="topbar-actions">
          <button type="button" className="button secondary" onClick={onOpenSettings}>
            Ajustes
          </button>
          <button type="button" className="button secondary" onClick={onAdd}>
            + adicionar máquina
          </button>
          <button
            type="button"
            className="button ghost danger"
            onClick={() => onRemove(selected)}
          >
            Remover
          </button>
        </div>
      </header>

      <section className={`status-card status-${status}`} aria-live="polite">
        <div className="status-line">
          <StatusDot status={status} />
          <span className="status-label">{text.label}</span>
        </div>
        <h2 className="machine-name">{selected.name}</h2>
        <p className="muted">{text.hint}</p>
        {status === 'unauthorized' && (
          <button type="button" className="button primary" onClick={() => onRepair(selected)}>
            Parear de novo
          </button>
        )}
        {status !== 'unauthorized' && (
          <button type="button" className="button primary" onClick={onOpenWorkspaces}>
            Workspaces
          </button>
        )}
      </section>
    </main>
  );
}
