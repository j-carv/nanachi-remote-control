import { Circle, CircleHalf, CheckCircle, type Icon } from '@phosphor-icons/react';
import type { PlanEntry } from './reducer.js';

const MARK: Record<PlanEntry['status'], Icon> = {
  pending: Circle,
  in_progress: CircleHalf,
  completed: CheckCircle,
};

const LABEL: Record<PlanEntry['status'], string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  completed: 'Concluído',
};

function PlanMark({ status }: { status: PlanEntry['status'] }) {
  const Mark = MARK[status];
  return (
    <span className="plan-mark" role="img" aria-label={LABEL[status]}>
      <Mark size={20} weight={status === 'pending' ? 'regular' : 'fill'} aria-hidden="true" />
    </span>
  );
}

/** Plano do agente como checklist. */
export function PlanCard({ entries }: { entries: readonly PlanEntry[] }) {
  return (
    <section className="card plan-card" aria-label="Plano">
      <h2 className="section-title">Plano</h2>
      <ul className="plan-list">
        {entries.map((entry, index) => (
          <li key={index} className={`plan-item plan-${entry.status}`}>
            <PlanMark status={entry.status} />
            <span>{entry.content}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
