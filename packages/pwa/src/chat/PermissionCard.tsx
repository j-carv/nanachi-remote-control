import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldExclamationPoint } from 'lucide-react';
import type { PendingPermission } from './reducer.js';
import type { ApiClient } from '../api.js';
import { Button } from '@/components/ui/button';
import { ToolContentView } from '../components/ToolContentView.js';

interface PermissionCardProps {
  api: ApiClient;
  request: PendingPermission;
  /** Retorna `false` se a resposta não saiu (sem conexão). */
  onRespond(optionId: string): boolean;
}

/** Pedido de permissão: um botão por opção. Some quando o daemon confirma (permission_resolved). */
export function PermissionCard({ api, request, onRespond }: PermissionCardProps) {
  const { t } = useTranslation('chat');
  const [answering, setAnswering] = useState(false);

  function respond(optionId: string) {
    if (onRespond(optionId)) setAnswering(true);
  }

  return (
    <section data-slot="permission-card" aria-label={t('permission.label')} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <ShieldExclamationPoint className="mt-0.5 size-5 shrink-0 text-attention" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-base font-semibold [overflow-wrap:anywhere]">{request.title}</p>
          {request.toolKind !== undefined && <p className="text-sm text-muted-foreground">{request.toolKind}</p>}
        </div>
      </div>
      {request.content.map((content, index) => (
        <ToolContentView key={index} api={api} content={content} />
      ))}
      <div data-slot="permission-actions" className="flex flex-wrap gap-2">
        {request.options.map((option) => {
          const allow = option.kind.startsWith('allow');
          return (
            <Button
              key={option.optionId}
              variant={allow ? 'default' : 'secondary'}
              data-permission={allow ? 'allow' : 'reject'}
              className="min-w-0 flex-1 basis-[120px]"
              disabled={answering}
              onClick={() => respond(option.optionId)}
            >
              {option.name}
            </Button>
          );
        })}
      </div>
    </section>
  );
}
