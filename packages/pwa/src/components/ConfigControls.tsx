import { useId } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import type { ConfigValue, SessionConfigOption } from '@nanachi/shared';
import type { SelectOption } from '../agentConfig.js';
import { choiceLabel, modelGroupsOf, modelSourceOf, sourceLabel, type ModelSource } from '../chat/modelSource.js';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { ListGroup, listRowClass } from './ListGroup.js';

/**
 * `<option>`s of a select. The model picker gets one `<optgroup>` per provider (the iOS wheel shows the headers) and
 * `name · vendor` text; every other list stays flat.
 */
function Choices({ option }: { option: SelectOption }) {
  const groups = modelGroupsOf(option);
  if (groups === undefined) {
    return (
      <>
        {option.options.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.name}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {groups.map((group) => (
        <optgroup key={group.providerId} label={group.providerLabel}>
          {group.options.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choiceLabel(choice)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** Provider (and vendor) of the chosen model, or null when the chosen option has none. */
function chosenSourceOf(option: SelectOption): ModelSource | null {
  const current = option.options.find((choice) => choice.value === option.currentValue);
  return current === undefined ? null : modelSourceOf(current);
}

/**
 * Visible text of the chosen model when the picker shows providers: the name, and under it the provider (and vendor).
 * The native select sits over it, transparent, so the text is what the user sees and the tap still opens the wheel.
 * The name line is hidden from screen readers (the select announces its own value); the provider line is not, and the
 * select points at it with `aria-describedby`, so equal names under different providers can be told apart.
 */
function ChosenText({ option, sourceId }: { option: SelectOption; sourceId: string }) {
  const current = option.options.find((choice) => choice.value === option.currentValue);
  const source = chosenSourceOf(option);
  return (
    <>
      <span aria-hidden="true" className="block truncate text-base text-foreground">
        {current?.name ?? option.currentValue}
      </span>
      {source !== null && (
        <span id={sourceId} className="block truncate text-sm text-muted-foreground">
          {sourceLabel(source)}
        </span>
      )}
    </>
  );
}

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
  const grouped = modelGroupsOf(option) !== undefined;
  const sourceId = useId();
  return (
    <label data-slot="config-select" data-option={option.category ?? 'outro'} className={`${listRowClass} justify-between`}>
      <span className="shrink-0 text-base">{label}</span>
      <span
        className={cn(
          'relative flex min-w-0 max-w-[62%] items-center',
          grouped &&
            'min-h-11 rounded-md has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring/40',
        )}
      >
        {grouped && (
          <span className="flex min-w-0 flex-col py-1 pr-6 text-right">
            <ChosenText option={option} sourceId={sourceId} />
          </span>
        )}
        <select
          value={option.currentValue}
          onChange={(event) => onChange(event.target.value)}
          aria-label={grouped ? label : undefined}
          aria-describedby={grouped && chosenSourceOf(option) !== null ? sourceId : undefined}
          className={
            grouped
              ? 'absolute inset-0 h-full w-full min-w-0 cursor-pointer opacity-0 outline-none'
              : 'h-11 w-full min-w-0 appearance-none truncate bg-transparent py-0 pr-6 pl-2 text-right text-base text-foreground outline-none'
          }
        >
          <Choices option={option} />
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
            <ConfigSelectField option={option} onChange={(value) => onChange(option.id, value)} />
          )}
        </li>
      ))}
    </ListGroup>
  );
}

/** Select com nome e descrição acima, para a lista de opções. */
function ConfigSelectField({ option, onChange }: { option: SelectOption; onChange(value: string): void }) {
  const grouped = modelGroupsOf(option) !== undefined;
  const baseId = useId();
  const descriptionId = `${baseId}-description`;
  const sourceId = `${baseId}-source`;
  const describedBy = [
    option.description ? descriptionId : undefined,
    chosenSourceOf(option) !== null ? sourceId : undefined,
  ]
    .filter((id) => id !== undefined)
    .join(' ');
  return (
    <label className="flex flex-col gap-2 px-4 py-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-base">{option.name}</span>
        {option.description && (
          <span id={grouped ? descriptionId : undefined} className="text-sm text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
      {grouped ? (
        <span className="relative block">
          <select
            value={option.currentValue}
            onChange={(event) => onChange(event.target.value)}
            aria-label={option.name}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            className="peer absolute inset-0 h-full w-full min-w-0 cursor-pointer opacity-0 outline-none"
          >
            <Choices option={option} />
          </select>
          <span className="flex min-h-11 w-full min-w-0 flex-col justify-center rounded-md border border-input bg-card py-1 pr-9 pl-3 peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40">
            <ChosenText option={option} sourceId={sourceId} />
          </span>
          <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        </span>
      ) : (
        <select
          value={option.currentValue}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full min-w-0 truncate rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Choices option={option} />
        </select>
      )}
    </label>
  );
}
