import { useId } from 'react';
import { ChevronsUpDown, LoaderCircle } from 'lucide-react';
import type { AgentProfile } from '@nanachi/shared';
import { ACCOUNT_LOCKED_HINT, accountOptionLabel } from '../agentAccounts.js';
import { cn } from '@/lib/utils';
import { listRowClass } from './ListGroup.js';

interface AccountSelectProps {
  profiles: readonly AgentProfile[];
  /** Id of the chosen account (`default` is the principal). */
  value: string;
  /** Locked: the agent is working (a session cannot change account now) or a change is on its way. */
  disabled?: boolean | undefined;
  /** Shows "Troque quando o agente terminar" under the row. Only meaningful with `disabled`. */
  showHint?: boolean | undefined;
  /** A change is on its way (the PUT runs): a small spinner takes the place of the chevrons. */
  busy?: boolean | undefined;
  onChange(accountId: string): void;
}

/** What the row says when `value` is not one of the accounts any more (it was removed). Neutral: no account is named. */
export const REMOVED_ACCOUNT_LABEL = 'Conta removida';

/**
 * The "Conta" row of the new-session and session-configuration sheets: a native select (the iOS wheel) behind the name
 * of the chosen account and its e-mail. Render it inside a `ListGroup`; the hint is part of this component so the row
 * and its explanation stay together.
 */
export function AccountSelect({ profiles, value, disabled = false, showHint = false, busy = false, onChange }: AccountSelectProps) {
  const hintId = useId();
  const current = profiles.find((profile) => profile.id === value);
  // The select's value must be one of its options, and the row must say what the value really is.
  const removed = current === undefined;
  return (
    <li>
      <label
        data-slot="account-select"
        data-disabled={disabled ? 'true' : undefined}
        className={cn(listRowClass, 'justify-between', disabled && 'opacity-60')}
      >
        <span className="shrink-0 text-base">Conta</span>
        <span className="relative flex min-h-11 min-w-0 max-w-[62%] items-center rounded-md has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring/40">
          <span className="flex min-w-0 flex-col py-1 pr-6 text-right">
            <span aria-hidden="true" className="block truncate text-base text-foreground">
              {current?.label ?? REMOVED_ACCOUNT_LABEL}
            </span>
            {current?.account != null && (
              <span aria-hidden="true" className="block truncate text-sm text-muted-foreground">
                {current.account}
              </span>
            )}
          </span>
          <select
            value={value}
            disabled={disabled}
            aria-label="Conta"
            aria-describedby={disabled && showHint ? hintId : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="absolute inset-0 h-full w-full min-w-0 cursor-pointer opacity-0 outline-none disabled:cursor-default"
          >
            {removed && (
              <option value={value} data-removed="true">
                {REMOVED_ACCOUNT_LABEL}
              </option>
            )}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {accountOptionLabel(profile, profiles)}
              </option>
            ))}
          </select>
          {busy ? (
            <LoaderCircle
              data-slot="account-busy"
              className="pointer-events-none absolute right-0 size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <ChevronsUpDown className="pointer-events-none absolute right-0 size-4 text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      </label>
      {disabled && showHint && (
        <p id={hintId} data-slot="account-hint" className="border-t border-border px-4 py-2 text-sm text-muted-foreground">
          {ACCOUNT_LOCKED_HINT}
        </p>
      )}
    </li>
  );
}
