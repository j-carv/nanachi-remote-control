import { useState } from 'react';
import { Check } from 'lucide-react';
import type { ConfigValue, Session, SessionConfigOption, Workspace } from '@nanachi/shared';
import {
  applyConfigValue,
  readAgentConfig,
  toCreateConfig,
  writeAgentConfig,
} from '../agentConfig.js';
import type { ApiClient } from '../api.js';
import type { StorageLike } from '../machines.js';
import { useAsync } from '../useAsync.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { ConfigControls } from './ConfigControls.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass } from './ListGroup.js';

interface NewSessionSheetProps {
  api: ApiClient;
  storage: StorageLike;
  workspace: Workspace;
  /** Agente já marcado ao abrir (ex.: o da sessão atual). Se não existir mais, cai no primeiro. */
  initialAgentId?: string | undefined;
  onCreated(session: Session): void;
  onClose(): void;
}

/**
 * Folha de nova sessão: escolhe o agente e mostra as opções lembradas da última sessão
 * daquele agente (localStorage). Essas opções são enviadas em `config` ao criar.
 */
export function NewSessionSheet({
  api,
  storage,
  workspace,
  initialAgentId,
  onCreated,
  onClose,
}: NewSessionSheetProps) {
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, SessionConfigOption[]>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [worktree, setWorktree] = useState(false);
  // Worktree só existe em repositório git (branch no /info). Falha do /info: some em silêncio.
  const info = useAsync(() => api.workspaceInfo(workspace.id), [api, workspace.id]);
  const isGit = info.data !== null && info.data.branch !== null;

  const agentList = agents.data ?? [];
  const agentId =
    chosen ??
    agentList.find((agent) => agent.id === initialAgentId)?.id ??
    agentList[0]?.id ??
    null;
  // Terminal (PTY) não tem opções de agente: nada de seletores nem `config` na criação.
  const isTerminal = agentList.find((agent) => agent.id === agentId)?.kind === 'pty';
  const options =
    agentId === null || isTerminal ? [] : (edits[agentId] ?? readAgentConfig(storage, agentId));
  const error = createError ?? agents.error;

  function change(configId: string, value: ConfigValue) {
    if (agentId === null) return;
    setEdits((previous) => ({ ...previous, [agentId]: applyConfigValue(options, configId, value) }));
  }

  async function create() {
    if (agentId === null || creating) return;
    setCreating(true);
    setCreateError(null);
    if (options.length > 0) writeAgentConfig(storage, agentId, options);
    try {
      const session = await api.createSession({
        workspaceId: workspace.id,
        agent: agentId,
        ...(options.length > 0 ? { config: toCreateConfig(options) } : {}),
        ...(worktree && isGit ? { worktree: true } : {}),
      });
      onCreated(session);
    } catch (caught) {
      setCreateError(caught);
      setCreating(false);
    }
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Nova sessão</DrawerTitle>
          <DrawerDescription>{workspace.name}</DrawerDescription>
        </DrawerHeader>

        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-5 pt-4 pb-2">
          <ErrorNotice error={error} />

          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 pl-1 text-sm font-medium text-muted-foreground">Agente</legend>
            <ListGroup>
              {agentList.map((agent) => {
                const pressed = agent.id === agentId;
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      className={cn(
                        listRowClass,
                        'w-full text-left text-base transition-colors hover:bg-accent active:bg-accent',
                      )}
                      onClick={() => setChosen(agent.id)}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate">{agent.label}</span>
                        {agent.kind === 'pty' && <Badge variant="outline">terminal</Badge>}
                      </span>
                      {pressed && <Check className="size-5 shrink-0" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ListGroup>
            {agents.data !== null && agentList.length === 0 && (
              <p className="pl-1 text-sm text-muted-foreground">Nenhum agente configurado no daemon.</p>
            )}
          </fieldset>

          {isGit && (
            <ListGroup>
              <li className={listRowClass}>
                <label className="flex min-w-0 flex-1 flex-col gap-0.5" htmlFor="new-session-worktree">
                  <span className="text-base">Em worktree separado</span>
                  <span className="text-sm text-muted-foreground">
                    Cria um branch e uma pasta próprios para esta sessão; o seu checkout fica intacto.
                  </span>
                </label>
                <Switch id="new-session-worktree" checked={worktree} onCheckedChange={setWorktree} />
              </li>
            </ListGroup>
          )}

          {!isTerminal && (
            <section className="flex flex-col gap-2">
              <h3 className="pl-1 text-sm font-medium text-muted-foreground">Opções</h3>
              {options.length > 0 ? (
                <ConfigControls options={options} onChange={change} />
              ) : (
                <p className="pl-1 text-sm text-muted-foreground">
                  Ainda sem opções lembradas para este agente. Elas aparecem no chat depois da primeira
                  sessão e passam a ser usadas aqui.
                </p>
              )}
            </section>
          )}
        </div>

        <DrawerFooter className="flex-row">
          <Button variant="ghost" className="flex-1" onClick={onClose}>
            Cancelar
          </Button>
          <Button className="flex-1" disabled={agentId === null || creating} onClick={() => void create()}>
            {creating ? 'Criando…' : 'Criar sessão'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
