import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ChevronDown, CircleStop, Info, Pause, Play, Repeat, Sparkles, Timer, Zap, type LucideIcon } from 'lucide-react';
import type { Loop, LoopMode, LoopRequest } from '@nanachi/shared';
import { describeLoopError } from '../errorMessages.js';
import { ListGroup, listRowClass, SectionHeading } from '../components/ListGroup.js';
import { StatusDot, type StatusTone } from '../components/StatusDot.js';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { durationInputOf, durationLabel, loopChipView, loopRoundsText, loopStatusText, type LoopPhase } from './loop.js';
import {
  LOOP_PRESETS_MS,
  firstRoundHelpText,
  formValuesOf,
  loopRequestFrom,
  loopSummaryText,
  nativeLoopCommand,
  parseIntervalText,
  type LoopFormValues,
} from './loopForm.js';
import { useLoopClock } from './useLoopClock.js';

/** The loop actions from the ChatController (the state comes from the chat itself). */
export interface LoopActions {
  saveLoop(request: LoopRequest): Promise<void>;
  pauseLoop(): Promise<void>;
  resumeLoop(): Promise<void>;
  runLoopNow(): Promise<void>;
  stopLoop(): Promise<void>;
}

export interface LoopSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  loop: Loop | null;
  /** The first loop state has arrived. Until then the sheet shows "Carregando". */
  loaded: boolean;
  /** A loop action is running (disables the buttons). */
  busy: boolean;
  /** The session accepts a prompt now (idle, or stopped/error: sending resumes it). */
  canSend: boolean;
  /** Claude session: offers "Usar /loop nativo do Claude". */
  nativeClaude: boolean;
  actions: LoopActions;
  /** Short notice for the conversation (e.g. "Loop iniciado"). */
  onNotice(text: string): void;
  /** Sends the text as an ordinary prompt. Returns `true` if sent; the sheet then closes. */
  onNativeSend(text: string): boolean;
}

/** Status dot colour per phase (DESIGN.md: only status gets colour). */
const PHASE_TONE: Record<LoopPhase, StatusTone> = {
  countdown: 'muted',
  queued: 'muted',
  running: 'running',
  paused: 'muted',
  error: 'danger',
};

/**
 * "Modo Loop" sheet: the current loop's state (when there is one), its actions (pause, run now, stop) and the form to
 * create or replace it. The form's validation and request building live in `loopForm.ts`.
 */
export function LoopSheet(props: LoopSheetProps) {
  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Modo Loop</DrawerTitle>
          <DrawerDescription>Repete um prompt nesta sessão, mesmo com o celular fechado.</DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 overflow-y-auto px-4 pt-3 pb-[max(env(safe-area-inset-bottom,0px),16px)]">
          {props.loaded ? (
            <LoopBody {...props} />
          ) : (
            <p className="py-8 text-center text-[15px] text-muted-foreground">Carregando o loop…</p>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** Body, rendered once the state is loaded. Form values start from the current loop and reset on every open. */
function LoopBody({ loop, busy, canSend, nativeClaude, actions, onNotice, onNativeSend, onOpenChange }: LoopSheetProps) {
  const now = useLoopClock(loop !== null);
  const [values, setValues] = useState<LoopFormValues>(() => formValuesOf(loop));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const disabled = busy || working;
  const editing = loop !== null;
  const interval = parseIntervalText(values.interval);
  const native = nativeLoopCommand(values);

  function patch(next: Partial<LoopFormValues>) {
    setValues((current) => ({ ...current, ...next }));
  }

  /** Runs one loop action: an error goes to the sheet; success calls `after`. */
  async function run(action: () => Promise<void>, after?: () => void) {
    setWorking(true);
    setError(null);
    try {
      await action();
      after?.();
    } catch (caught) {
      setError(describeLoopError(caught));
    } finally {
      setWorking(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const checked = loopRequestFrom(values);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    void run(
      () => actions.saveLoop(checked.request),
      () => {
        onNotice(editing ? 'Alterações salvas' : 'Loop iniciado');
        onOpenChange(false);
      },
    );
  }

  function sendNative() {
    if (native === undefined || disabled || !canSend) return;
    onNativeSend(native);
  }

  /** Arrow keys switch to the other mode and move focus to it (WAI-ARIA radio group). */
  function moveMode(event: KeyboardEvent<HTMLDivElement>) {
    if (!ARROW_KEYS.has(event.key)) return;
    event.preventDefault();
    const next: LoopMode = values.mode === 'interval' ? 'dynamic' : 'interval';
    patch({ mode: next });
    event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  }

  const summary = loopSummaryText(values);
  const phase = loopChipView(loop, now)?.phase ?? 'paused';
  const paused = loop?.state === 'paused';

  return (
    <div className="flex flex-col gap-6">
      {loop !== null && (
        <section aria-labelledby="loop-current-title" className="flex flex-col gap-2">
          <SectionHeading icon={Repeat} id="loop-current-title">
            Loop atual
          </SectionHeading>
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <StatusDot tone={PHASE_TONE[phase]} />
              <p data-slot="loop-status" className="min-w-0 text-[15px] font-medium">
                {loopStatusText(loop, now)}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {loopRoundsText(loop)} · {loop.intervalMs === null ? 'Automático' : `Intervalo de ${durationLabel(loop.intervalMs)}`}
            </p>
            {loop.lastError !== null && (
              <div role="alert" className="flex flex-col gap-1 rounded-lg bg-destructive/10 px-3.5 py-3 text-sm text-destructive [overflow-wrap:anywhere]">
                <p className="font-medium">Último erro</p>
                <p>{loop.lastError}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {paused ? (
                <Button variant="secondary" disabled={disabled} onClick={() => void run(actions.resumeLoop)}>
                  <Play aria-hidden="true" />
                  Retomar
                </Button>
              ) : (
                <Button variant="secondary" disabled={disabled} onClick={() => void run(actions.pauseLoop)}>
                  <Pause aria-hidden="true" />
                  Pausar
                </Button>
              )}
              <Button variant="secondary" disabled={disabled} onClick={() => void run(actions.runLoopNow)}>
                <Zap aria-hidden="true" />
                Rodar agora
              </Button>
            </div>
          {confirming ? (
            <div role="group" aria-label="Confirmar parada" className="-mx-4 -mb-4 flex flex-col gap-3 border-t border-border p-4">
              <p className="text-sm">Parar o loop? Uma rodada em andamento termina, e nenhuma outra começa.</p>
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" disabled={disabled} onClick={() => setConfirming(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={disabled}
                  onClick={() =>
                    void run(actions.stopLoop, () => {
                      onNotice('Loop parado');
                      onOpenChange(false);
                    })
                  }
                >
                  Parar loop
                </Button>
              </div>
            </div>
          ) : (
            <div className="-mx-4 -mb-4 border-t border-border">
              <Button
                variant="destructive-ghost"
                className="h-12 w-full justify-start rounded-none px-4"
                disabled={disabled}
                onClick={() => setConfirming(true)}
              >
                <CircleStop aria-hidden="true" />
                Parar loop
              </Button>
            </div>
          )}
          </div>
        </section>
      )}

      <form className="flex flex-col gap-6" onSubmit={submit} aria-label={editing ? 'Alterar o loop' : 'Novo loop'}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="loop-prompt">Prompt</Label>
          <textarea
            id="loop-prompt"
            rows={3}
            value={values.prompt}
            placeholder="Ex.: /review ou revise os testes que falharam"
            onChange={(event) => patch({ prompt: event.target.value })}
            className="min-h-24 resize-none rounded-md border border-input bg-card px-3 py-2.5 text-base leading-snug text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>

        <div className="flex flex-col gap-2">
          <span id="loop-mode-label" className="text-sm font-medium">
            Quando rodar
          </span>
          <div role="radiogroup" aria-labelledby="loop-mode-label" onKeyDown={moveMode} className="flex flex-col gap-2">
            {MODE_CARDS.map((card) => (
              <ModeCard key={card.mode} {...card} checked={values.mode === card.mode} onSelect={() => patch({ mode: card.mode })} />
            ))}
          </div>
        </div>

        {values.mode === 'interval' && (
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium">Intervalo</span>
            <div className="grid grid-cols-5 gap-1.5">
              {LOOP_PRESETS_MS.map((ms) => {
                const selected = interval.ok && interval.intervalMs === ms;
                return (
                  <button
                    key={ms}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => patch({ interval: durationInputOf(ms) })}
                    className={cn(
                      'h-11 min-w-0 rounded-md px-1 text-sm font-medium whitespace-nowrap transition-colors',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground hover:bg-accent',
                    )}
                  >
                    {durationLabel(ms)}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="loop-interval" className="font-normal text-muted-foreground">
                Outro intervalo
              </Label>
              <Input
                id="loop-interval"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Ex.: 90s, 10m, 1h30m"
                value={values.interval}
                aria-invalid={!interval.ok}
                aria-describedby="loop-interval-hint"
                onChange={(event) => patch({ interval: event.target.value })}
              />
              <p id="loop-interval-hint" className={cn('text-sm', interval.ok ? 'text-muted-foreground' : 'text-destructive')}>
                {interval.ok
                  ? `Roda a cada ${durationLabel(interval.intervalMs)}, contando do fim de cada rodada.`
                  : interval.message}
              </p>
            </div>
          </div>
        )}

        <ListGroup label="Opções do loop">
          <li className={listRowClass}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Label htmlFor="loop-rounds" className="font-normal text-[15px]">
                Limite de rodadas
              </Label>
              <p id="loop-rounds-hint" className="text-sm leading-snug text-muted-foreground">
                O loop para sozinho depois desse número de rodadas.
              </p>
            </div>
            <Input
              id="loop-rounds"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              placeholder="Sem limite"
              aria-describedby="loop-rounds-hint"
              value={values.rounds}
              className="h-11 w-28 text-right"
              onChange={(event) => patch({ rounds: event.target.value })}
            />
          </li>
          <li className={listRowClass}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Label htmlFor="loop-run-now" className="font-normal text-[15px]">
                Primeira rodada agora
              </Label>
              <p id="loop-run-now-hint" className="text-sm leading-snug text-muted-foreground">
                {firstRoundHelpText(values.mode)}
              </p>
            </div>
            <Switch
              id="loop-run-now"
              aria-describedby="loop-run-now-hint"
              checked={values.runNow}
              onCheckedChange={(runNow) => patch({ runNow })}
            />
          </li>
        </ListGroup>

        {summary !== undefined && (
          <p data-slot="loop-summary" className="rounded-lg bg-muted px-3.5 py-3 text-sm leading-snug">
            {summary}
          </p>
        )}

        {error !== null && (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3.5 py-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <Button type="submit" size="wide" disabled={disabled}>
            <Repeat aria-hidden="true" />
            {editing ? 'Salvar alterações' : 'Iniciar loop'}
          </Button>
          {editing && <p className="text-center text-sm text-muted-foreground">Salvar reinicia a contagem de rodadas.</p>}
          {nativeClaude && (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="secondary"
                size="wide"
                disabled={native === undefined || !canSend || disabled}
                onClick={sendNative}
              >
                Usar /loop nativo do Claude
              </Button>
              <p className="text-center text-sm text-muted-foreground">Manda o comando como mensagem comum ao Claude.</p>
            </div>
          )}
        </div>
      </form>

      <details data-slot="loop-howto" className="group rounded-xl border border-border bg-card">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <Info className="size-5 text-muted-foreground" aria-hidden="true" />
            Como funciona
          </span>
          <ChevronDown
            className="size-5 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <ul className="flex list-disc flex-col gap-2 border-t border-border py-3 pr-4 pl-9 text-sm leading-snug text-muted-foreground">
          <li>Roda no PC, mesmo com o celular fechado.</li>
          <li>Espera se o agente estiver ocupado ou pedindo permissão.</li>
          <li>Pausa e te avisa no celular se der erro.</li>
        </ul>
      </details>
    </div>
  );
}

/** Arrow keys of the "Quando rodar" radio group. */
const ARROW_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Copy of the two "Quando rodar" options, in display order. Plain language with one concrete example each. */
const MODE_CARDS: readonly Omit<ModeCardProps, 'checked' | 'onSelect'>[] = [
  {
    mode: 'interval',
    icon: Timer,
    title: 'Intervalo fixo',
    description:
      'Repete o prompt sempre no mesmo intervalo. O tempo conta a partir do fim da resposta anterior, então nunca roda duas vezes ao mesmo tempo.',
    example: 'Ex.: a cada 15 min, rodar os testes e consertar o que falhar.',
  },
  {
    mode: 'dynamic',
    icon: Sparkles,
    title: 'Automático',
    description:
      'O agente decide quando rodar de novo: no fim de cada resposta ele diz quanto esperar (de 30 s a 24 h) ou que terminou, e o loop para sozinho. Sem resposta, espera 10 min.',
    example: 'Ex.: continuar uma refatoração até acabar.',
  },
];

interface ModeCardProps {
  mode: LoopMode;
  icon: LucideIcon;
  title: string;
  description: string;
  example: string;
  checked: boolean;
  onSelect(): void;
}

/**
 * One "Quando rodar" option: a radio (`aria-checked`) named by its title, described by its text and example. Monochrome:
 * the selected card gets the foreground border and a filled indicator.
 */
function ModeCard({ mode, icon: Icon, title, description, example, checked, onSelect }: ModeCardProps) {
  const titleId = useId();
  const textId = useId();
  return (
    <button
      type="button"
      role="radio"
      data-mode={mode}
      aria-checked={checked}
      aria-labelledby={titleId}
      aria-describedby={textId}
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'flex min-h-11 w-full items-start gap-3 rounded-xl border bg-card p-3.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:bg-accent',
      )}
    >
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
        <Icon className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={titleId} className="text-[15px] font-medium">
          {title}
        </span>
        <span id={textId} className="text-sm leading-snug text-muted-foreground">
          {description}
          <span className="block pt-1 text-foreground">{example}</span>
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-primary bg-primary' : 'border-input',
        )}
      >
        {checked && <span className="size-2 rounded-full bg-primary-foreground" />}
      </span>
    </button>
  );
}
