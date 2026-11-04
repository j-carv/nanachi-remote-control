import type { ConfigValue, SessionConfigOption } from '@nanachi/shared';
import type { SelectOption } from '../agentConfig.js';

interface ConfigSelectProps {
  label: string;
  option: SelectOption;
  onChange(value: string): void;
}

/** Seletor compacto (Acesso / Modelo / Effort). Select nativo: no iOS abre a roda de opções. */
export function ConfigSelect({ label, option, onChange }: ConfigSelectProps) {
  return (
    <label className={`config-select config-select--${option.category ?? 'outro'}`}>
      <span className="config-label">{label}</span>
      <select
        className="config-input"
        value={option.currentValue}
        onChange={(event) => onChange(event.target.value)}
      >
        {option.options.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ConfigControlsProps {
  options: readonly SessionConfigOption[];
  onChange(configId: string, value: ConfigValue): void;
}

/** Lista de opções (select e boolean) para o painel "Mais opções" e a folha de nova sessão. */
export function ConfigControls({ options, onChange }: ConfigControlsProps) {
  return (
    <ul className="config-list">
      {options.map((option) => (
        <li key={option.id} className="config-row">
          {option.type === 'boolean' ? (
            <label className="config-toggle">
              <span>
                <span className="config-name">{option.name}</span>
                {option.description && <span className="muted small">{option.description}</span>}
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={option.currentValue}
                onChange={(event) => onChange(option.id, event.target.checked)}
              />
            </label>
          ) : (
            <label className="config-field">
              <span className="config-name">{option.name}</span>
              {option.description && <span className="muted small">{option.description}</span>}
              <select
                className="config-input"
                value={option.currentValue}
                onChange={(event) => onChange(option.id, event.target.value)}
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
    </ul>
  );
}
