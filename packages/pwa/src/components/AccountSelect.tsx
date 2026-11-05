import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsUpDown, LoaderCircle } from 'lucide-react';
import type { AgentProfile } from '@nanachi/shared';
import { accountLockedHint, accountOptionLabel } from '../agentAccounts.js';
import { useLayout } from '../wide/layoutContext.js';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { listRowClass } from './ListGroup.js';

interface AccountSelectProps {
  profiles: readonly AgentProfile[];
  /** Id of the chosen account (`default` is the principal). */
  value: string;
  /** Locked: the agent is working (a session cannot change account now) or a change is on its way. */
  disabled?: boolean | undefined;
  /** Shows the "switch when the agent is done" hint under the row. Only meaningful with `disabled`. */
  showHint?: boolean | undefined;
  /** A change is on its way (the PUT runs): a small spinner takes the place of the chevrons. */
  busy?: boolean | undefined;
  onChange(accountId: string): void;
}

/**
 * The "Conta" row of the new-session and session-configuration sheets: a native select (the iOS wheel) behind the name
 * of the chosen account and its e-mail. On a wide screen the row holds a styled dropdown instead, with the name and the
 * e-mail on one line. Render it inside a `ListGroup`; the hint is part of this component so the row and its explanation
 * stay together.
 */
export function AccountSelect({ profiles, value, disabled = false, showHint = false, busy = false, onChange }: AccountSelectProps) {
  const { t } = useTranslation('accounts');
  const hintId = useId();
  const wide = useLayout() !== 'phone';
  const current = profiles.find((profile) => profile.id === value);
  // The select's value must be one of its options, and the row must say what the value really is.
  const removed = current === undefined;
  // What the row says when `value` is not one of the accounts any more (it was removed). Neutral: no account is named.
  const removedLabel = t('select.removed');

  if (wide) {
    return (
      <li>
        <div
          data-slot="account-select"
          data-disabled={disabled ? 'true' : undefined}
          className={cn(listRowClass, 'justify-between wide:min-h-10 wide:py-1.5', disabled && 'opacity-60')}
        >
          <span className="shrink-0 text-base">{t('select.label')}</span>
          <Select value={value} disabled={disabled} onValueChange={onChange}>
            <SelectTrigger
              aria-label={t('select.label')}
              aria-describedby={disabled && showHint ? hintId : undefined}
              className="max-w-[62%]"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{current?.label ?? removedLabel}</span>
                {current?.account != null && (
                  <span className="truncate text-sm text-muted-foreground">{current.account}</span>
                )}
              </span>
              {busy ? (
                <LoaderCircle
                  data-slot="account-busy"
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden="true" />
              )}
            </SelectTrigger>
            <SelectContent>
              {removed && (
                <SelectItem value={value} textValue={removedLabel} data-removed="true">
                  {removedLabel}
                </SelectItem>
              )}
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id} textValue={accountOptionLabel(profile, profiles)}>
                  <span className="truncate">{profile.label}</span>
                  {profile.account != null && <span className="truncate text-sm text-muted-foreground">{profile.account}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {disabled && showHint && (
          <p id={hintId} data-slot="account-hint" className="border-t border-border px-4 py-2 text-sm text-muted-foreground">
            {accountLockedHint()}
          </p>
        )}
      </li>
    );
  }

  return (
    <li>
      <label
        data-slot="account-select"
        data-disabled={disabled ? 'true' : undefined}
        className={cn(listRowClass, 'justify-between', disabled && 'opacity-60')}
      >
        <span className="shrink-0 text-base">{t('select.label')}</span>
        <span className="relative flex min-h-11 min-w-0 max-w-[62%] items-center rounded-md has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring/40">
          <span className="flex min-w-0 flex-col py-1 pr-6 text-right">
            <span aria-hidden="true" className="block truncate text-base text-foreground">
              {current?.label ?? removedLabel}
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
            aria-label={t('select.label')}
            aria-describedby={disabled && showHint ? hintId : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="absolute inset-0 h-full w-full min-w-0 cursor-pointer opacity-0 outline-none disabled:cursor-default"
          >
            {removed && (
              <option value={value} data-removed="true">
                {removedLabel}
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
          {accountLockedHint()}
        </p>
      )}
    </li>
  );
}
