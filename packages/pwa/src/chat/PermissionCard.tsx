import { useState } from 'react';
import type { PendingPermission } from './reducer.js';
import type { ApiClient } from '../api.js';
import { ToolContentView } from '../components/ToolContentView.js';

interface PermissionCardProps {
  api: ApiClient;
  request: PendingPermission;
  /** Retorna `false` se a resposta não saiu (sem conexão). */
  onRespond(optionId: string): boolean;
}

/** Pedido de permissão: um botão por opção. Some quando o daemon confirma (permission_resolved). */
export function PermissionCard({ api, request, onRespond }: PermissionCardProps) {
  const [answering, setAnswering] = useState(false);

  function respond(optionId: string) {
    if (onRespond(optionId)) setAnswering(true);
  }

  return (
    <section className="card permission-card" aria-label="Pedido de permissão">
      <p className="permission-title">{request.title}</p>
      {request.toolKind !== undefined && <p className="muted small">{request.toolKind}</p>}
      {request.content.map((content, index) => (
        <ToolContentView key={index} api={api} content={content} />
      ))}
      <div className="permission-actions">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={`button permission-${option.kind.startsWith('allow') ? 'allow' : 'reject'}`}
            disabled={answering}
            onClick={() => respond(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </section>
  );
}
