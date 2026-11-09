import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LoaderCircle, MessageCircleQuestion } from 'lucide-react';
import type { AskUserResult } from '@nanachi/shared';
import { ApiError } from '../api.js';
import type { UserQuestionItem } from './reducer.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type UserQuestionCardState =
  | { kind: 'idle' }
  | { kind: 'saving'; optionId: string | null }
  | { kind: 'failed'; optionId: string | null }
  | { kind: 'unavailable' };

interface UserQuestionCardViewProps {
  request: UserQuestionItem;
  state: UserQuestionCardState;
  expired?: boolean;
  onRespond?: (optionId: string | null) => void;
  onRetry?: () => void;
  onChange?: () => void;
}

/** Shared by the live card, read-only history and the localized state sweep. Agent strings are plain text. */
export function UserQuestionCardView({ request, state, expired = false, onRespond, onRetry, onChange }: UserQuestionCardViewProps) {
  const { t } = useTranslation('chat');
  const questionId = useId();
  const result = request.result;
  const unavailable = request.unavailable || state.kind === 'unavailable' || onRespond === undefined;
  const actionable = result === null && !unavailable && !expired;
  const locked = state.kind !== 'idle';
  const picked = state.kind === 'saving' || state.kind === 'failed' ? state.optionId : undefined;
  const pickedLabel = picked === null ? t('question.cancel') : request.options.find((option) => option.id === picked)?.label;

  return (
    <section
      data-slot="user-question-card"
      data-state={result?.status ?? (expired ? 'expired' : unavailable ? 'unavailable' : state.kind)}
      aria-label={t('question.label')}
      aria-labelledby={questionId}
      aria-busy={actionable && state.kind === 'saving'}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 id={questionId} className="min-w-0 text-base leading-snug font-semibold whitespace-pre-wrap [overflow-wrap:anywhere]">{request.question}</h2>
      </div>
      {actionable ? (
        <>
          <p className="text-sm text-muted-foreground">{t('question.hint')}</p>
          <div data-slot="user-question-options" className="flex flex-col gap-2">
            {request.options.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                className={cn(
                  'h-auto min-h-11 w-full min-w-0 justify-start py-2.5 text-left leading-snug whitespace-normal [overflow-wrap:anywhere]',
                  picked === option.id && 'disabled:opacity-100',
                )}
                disabled={locked}
                onClick={() => onRespond?.(option.id)}
              >
                {state.kind === 'saving' && picked === option.id && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                <span className="min-w-0">{option.label}</span>
              </Button>
            ))}
            <Button type="button" variant="ghost" className="self-start" disabled={locked} onClick={() => onRespond?.(null)}>
              {state.kind === 'saving' && picked === null && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {t('question.cancel')}
            </Button>
          </div>
          {state.kind === 'saving' && <p role="status" className="text-sm text-muted-foreground">{t('question.saving')}</p>}
          {state.kind === 'failed' && (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm text-muted-foreground">{t('question.failed')}</p>
              <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{t('question.unconfirmed', { label: pickedLabel })}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={onRetry}>{t('question.retry')}</Button>
                <Button type="button" variant="ghost" onClick={onChange}>{t('question.change')}</Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {request.options.map((option) => {
              const selected = result?.status === 'answered' && result.option.id === option.id;
              return (
                <li key={option.id} className={cn('flex items-start gap-2 whitespace-pre-wrap [overflow-wrap:anywhere]', selected && 'font-medium text-foreground')}>
                  {selected && <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0">{option.label}</span>
                </li>
              );
            })}
          </ul>
          <p role="status" className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {result?.status === 'answered'
              ? t('question.answered', { label: result.option.label })
              : result?.status === 'cancelled'
                ? t(`question.cancelled.${result.reason}`)
                : expired
                  ? t('question.cancelled.expired')
                  : t('question.unavailable')}
          </p>
        </>
      )}
    </section>
  );
}

interface UserQuestionCardProps {
  request: UserQuestionItem;
  onRespond(optionId: string | null): Promise<AskUserResult>;
}

/** No optimistic answers: a failed write keeps the exact decision for an explicit retry. */
export function UserQuestionCard({ request, onRespond }: UserQuestionCardProps) {
  const [state, setState] = useState<UserQuestionCardState>({ kind: 'idle' });
  const [confirmed, setConfirmed] = useState<AskUserResult | null>(null);
  const [expired, setExpired] = useState(() => Date.now() >= request.expiresAt);
  const saving = useRef(false);

  useEffect(() => {
    const update = () => setExpired(Date.now() >= request.expiresAt);
    update();
    const timer = window.setTimeout(update, Math.max(0, request.expiresAt - Date.now()));
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [request.expiresAt]);

  async function respond(optionId: string | null) {
    if (saving.current || request.result !== null || request.unavailable || confirmed !== null || Date.now() >= request.expiresAt) return;
    saving.current = true;
    setState({ kind: 'saving', optionId });
    try {
      setConfirmed(await onRespond(optionId));
    } catch (error: unknown) {
      const unavailable = error instanceof ApiError && error.status !== null && [401, 403, 404, 409, 410].includes(error.status);
      setState(unavailable ? { kind: 'unavailable' } : { kind: 'failed', optionId });
    } finally {
      saving.current = false;
    }
  }

  return (
    <UserQuestionCardView
      request={confirmed === null ? request : { ...request, result: confirmed }}
      state={state}
      expired={expired}
      onRespond={(optionId) => void respond(optionId)}
      onRetry={() => { if (state.kind === 'failed') void respond(state.optionId); }}
      onChange={() => setState({ kind: 'idle' })}
    />
  );
}
