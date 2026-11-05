import { ChevronsUpDown } from 'lucide-react';
import type { ConfigValue, SessionConfigOption } from '@nanachi/shared';
import type { SelectOption } from '../agentConfig.js';
import { Switch } from '@/components/ui/switch';
import { ListGroup, listRowClass } from './ListGroup.js';

interface ConfigSelectProps {
  label: string;
  option: SelectOption;
  onChange(value: string): void;
}

/**
 * Linha de um seletor fixo (Acesso / Modelo / Effort) na folha "Configurar sessão". Select nativo: no iOS abre a
 * roda de opções. Dentro de um ListGroup, o `li` fica por fora.
 */
export function ConfigSelect({ label, option, onChange }: ConfigSelectProps) {
  return (
    <label data-slot="config-select" data-option={option.category ?? 'outro'} className={`${listRowClass} justify-between`}>
      <span className="shrink-0 text-base">{label}</span>
      <span className="relative flex min-w-0 max-w-[62%] items-center">
        <select
          value={option.currentValue}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full min-w-0 appearance-none truncate bg-transparent py-0 pr-6 pl-2 text-right text-base text-foreground outline-none"
        >
          {option.options.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.name}
            </option>
          ))}
        </select>
        <ChevronsUpDown className="pointer-events-none absolute right-0 size-4 text-muted-foreground" aria-hidden="true" />
      </span>
    </label>
  );
}

interface ConfigControlsProps {
  options: readonly SessionConfigOption[];
  onChange(configId: string, value: ConfigValue): void;
}

/** Lista de opções (select e boolean) para o "Mais opções" da folha de sessão e a folha de nova sessão. */
export function ConfigControls({ options, onChange }: ConfigControlsProps) {
  return (
    <ListGroup>
      {options.map((option) => (
        <li key={option.id}>
          {option.type === 'boolean' ? (
            <label data-slot="config-toggle" className={`${listRowClass} cursor-pointer justify-between`}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base">{option.name}</span>
                {option.description && <span className="text-sm text-muted-foreground">{option.description}</span>}
              </span>
              <Switch
                checked={option.currentValue}
                onCheckedChange={(checked) => onChange(option.id, checked)}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-2 px-4 py-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-base">{option.name}</span>
                {option.description && <span className="text-sm text-muted-foreground">{option.description}</span>}
              </span>
              <select
                value={option.currentValue}
                onChange={(event) => onChange(option.id, event.target.value)}
                className="h-11 w-full min-w-0 truncate rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {option.options.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </li>
      ))}
    </ListGroup>
  );
}
