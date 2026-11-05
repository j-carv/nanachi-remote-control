import { Disc3, Folder, FolderOpen, FolderPlus, FolderX, HardDrive, Plus, RotateCw, Server, Usb, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DriveInfo, FoldersState } from '../../common/control-api.js';
import { formatBytes, pluralize } from '../lib/format.js';
import {
  changeSummary,
  DRIVE_KIND_LABELS,
  driveLetter,
  driveSwitchState,
  driveUsage,
  needsRestartChoice,
  splitPath,
  type DraftEntry,
  type PendingChanges,
} from '../lib/roots.js';
import { restartedMessage, savedMessage, type SaveChoice } from '../lib/save.js';
import { useApi } from '../state/api.js';
import { useFolders } from '../state/folders-store.js';
import { useReported } from '../state/reported.js';
import { useShell } from '../state/shell.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Notice } from '../ui/Notice.js';
import { ErrorState, GroupSkeleton } from '../ui/States.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Switch } from '../ui/Switch.js';
import { Group, SectionHeading } from '../ui/Surface.js';
import { useToast } from '../ui/Toast.js';
import { Tooltip } from '../ui/Tooltip.js';
import { Page } from './Page.js';
import { RestartDialog } from './RestartDialog.js';

const DRIVE_ICONS: Record<DriveInfo['kind'], LucideIcon> = {
  fixed: HardDrive,
  removable: Usb,
  network: Server,
  optical: Disc3,
  unknown: HardDrive,
};

const USAGE_FILL = { normal: 'bg-foreground/70', high: 'bg-attention', critical: 'bg-destructive' } as const;

/* ------------------------------------------------------------------ drives */

export interface DriveTileProps {
  drive: DriveInfo;
  paths: readonly string[];
  editable: boolean;
  onToggle: (root: string, on: boolean) => void;
}

/** One drive: name, how full it is, and the switch that allows the whole drive. */
export function DriveTile({ drive, paths, editable, onToggle }: DriveTileProps) {
  const letter = driveLetter(drive.root);
  const Icon = DRIVE_ICONS[drive.kind];
  const usage = driveUsage(drive);
  const { checked, folderCount } = driveSwitchState(drive.root, paths);
  const labelId = `drive-${letter.charAt(0)}-label`;
  const hintId = `drive-${letter.charAt(0)}-hint`;
  let hint: string | null = null;
  if (folderCount > 0) hint = checked ? pluralize(folderCount, 'pasta já incluída', 'pastas já incluídas') : pluralize(folderCount, 'pasta liberada neste disco', 'pastas liberadas neste disco');

  return (
    <section
      aria-label={`Disco ${letter}`}
      data-allowed={checked}
      className={cx(
        'flex flex-col rounded-lg border bg-card transition-[border-color,box-shadow] duration-150',
        checked ? 'border-foreground/45 shadow-[0_0_0_1px_color-mix(in_oklab,var(--ui-foreground)_12%,transparent)]' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-[18px]">
          <Icon aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] leading-5 font-semibold tabular-nums">{letter}</span>
            {drive.label ? <span className="truncate text-sm text-muted-foreground">{drive.label}</span> : null}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">{DRIVE_KIND_LABELS[drive.kind]}</div>
        </div>
      </div>

      <div className="px-4 pt-3 pb-3.5">
        {usage ? (
          <>
            <div
              role="img"
              aria-label={`${formatBytes(usage.used)} usados de ${formatBytes(usage.total)}`}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div className={cx('h-full rounded-full', USAGE_FILL[usage.level])} style={{ width: `${Math.max(2, Math.round(usage.fraction * 100))}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              <span className="text-foreground">{formatBytes(drive.freeBytes)}</span> livres de {formatBytes(drive.totalBytes)}
            </div>
          </>
        ) : (
          <div className="text-xs text-muted-foreground">Tamanho indisponível</div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div id={labelId} className="text-[13px] leading-5 font-medium">
            Permitir o disco inteiro
          </div>
          {hint ? (
            <div id={hintId} className="text-xs leading-4 text-muted-foreground">
              {hint}
            </div>
          ) : null}
        </div>
        <Switch checked={checked} disabled={!editable} labelledBy={labelId} describedBy={hint ? hintId : undefined} onCheckedChange={(on) => onToggle(drive.root, on)} />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- folder list */

export interface FolderRowProps {
  entry: DraftEntry;
  editable: boolean;
  onReveal: (path: string) => void;
  onRemove: (path: string) => void;
}

export function FolderRow({ entry, editable, onReveal, onRemove }: FolderRowProps) {
  const { parent, name } = splitPath(entry.path);
  const Icon = entry.exists ? Folder : FolderX;
  return (
    <li className="group flex min-h-11 items-center gap-3 px-4 py-1.5 hover:bg-accent/50" data-slot="folder-row">
      <Icon className={cx('size-4 shrink-0', entry.exists ? 'text-muted-foreground' : 'text-attention')} aria-hidden="true" />
      <span className="selectable flex min-w-0 flex-1 items-baseline font-mono text-[12.5px] leading-5" title={entry.path}>
        {parent ? <span className="truncate text-muted-foreground">{parent}</span> : null}
        <span className="shrink-0 font-medium text-foreground">{name}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {entry.isNew ? <Badge tone="running">Nova</Badge> : null}
        {!entry.exists ? <Badge tone="attention">Não encontrada</Badge> : null}
        {entry.coveredBy ? (
          <Tooltip label={`Já faz parte de ${entry.coveredBy}. Continua permitida; pode remover se quiser.`}>
            <span tabIndex={0} className="rounded-full focus-visible:outline-2">
              <Badge>{`Dentro de ${splitPath(entry.coveredBy).name}`}</Badge>
            </span>
          </Tooltip>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <Tooltip label="Mostrar no Explorer">
          <Button variant="ghost" size="icon-sm" aria-label={`Mostrar ${entry.path} no Explorer`} disabled={!entry.exists} onClick={() => onReveal(entry.path)}>
            <FolderOpen aria-hidden="true" />
          </Button>
        </Tooltip>
        {editable ? (
          <Tooltip label="Remover da lista">
            <Button variant="ghost" size="icon-sm" aria-label={`Remover ${entry.path}`} onClick={() => onRemove(entry.path)}>
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        ) : null}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ save bar */

export function SaveBar({ changes, saving, busySessions, onDiscard, onSave }: { changes: PendingChanges; saving: boolean; busySessions: number; onDiscard: () => void; onSave: () => void }) {
  return (
    <div
      role="region"
      aria-label="Alterações não salvas"
      className="sticky bottom-4 z-10 -mx-2 mt-2 animate-bar rounded-xl border border-border bg-popover px-4 py-3 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.4)]"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention" />
        <div className="min-w-0 flex-1">
          <div className="truncate">
            <span className="text-sm font-medium">Alterações não salvas</span>
            <span className="ml-2 text-[13px] text-muted-foreground">{changeSummary(changes)}</span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {needsRestartChoice(busySessions)
              ? 'Ao salvar, você escolhe se o daemon reinicia agora.'
              : 'Ao salvar, o daemon reinicia e as sessões ficam paradas até você enviar uma mensagem nelas.'}
          </div>
        </div>
        <Button variant="ghost" disabled={saving} onClick={onDiscard}>
          Descartar
        </Button>
        <Button variant="primary" loading={saving} onClick={onSave}>
          Salvar
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- view */

export interface FoldersViewProps {
  state: FoldersState;
  entries: DraftEntry[];
  paths: string[];
  changes: PendingChanges;
  saving: boolean;
  restarting: boolean;
  onPick: () => void;
  onRemove: (path: string) => void;
  onToggleDrive: (root: string, on: boolean) => void;
  onReveal: (path: string) => void;
  onDiscard: () => void;
  onSave: () => void;
  onRestartNow: () => void;
}

export function FoldersView({ state, entries, paths, changes, saving, restarting, onPick, onRemove, onToggleDrive, onReveal, onDiscard, onSave, onRestartNow }: FoldersViewProps) {
  const { editable } = state;
  return (
    <>
      <div className="flex flex-col gap-3">
        <Notice tone="info">
          <span className="font-medium">O Nanachi só abre sessões dentro destas pastas.</span> Não é um sandbox: o agente ainda pode ler e escrever fora delas.
        </Notice>
        {state.rootsUnknown ? (
          <Notice tone="attention" title="Lista indisponível">
            O Nanachi está conectado a um daemon que ele não iniciou e não conseguiu perguntar a ele quais pastas usa. Essa lista fica na configuração do próprio daemon, e é só por lá que ela pode ser lida ou mudada.
          </Notice>
        ) : !editable ? (
          <Notice tone="info" title="Somente leitura">
            O Nanachi está conectado a um daemon que ele não iniciou. Esta é a lista que esse daemon usa, e ela só pode ser mudada na configuração dele.
          </Notice>
        ) : null}
        {state.restartPending && !changes.dirty && !state.rootsUnknown ? (
          <Notice
            tone="attention"
            title="Salvo, mas ainda não aplicado"
            action={
              editable ? (
                <Button icon={<RotateCw aria-hidden="true" />} loading={restarting} onClick={onRestartNow}>
                  Reiniciar agora
                </Button>
              ) : null
            }
          >
            O daemon em execução ainda usa a lista anterior. A nova lista vale depois de reiniciar.
          </Notice>
        ) : null}
      </div>

      <section aria-labelledby="folders-drives">
        <SectionHeading id="folders-drives">Discos</SectionHeading>
        {state.drives.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(264px,1fr))] gap-3">
            {state.drives.map((drive) => (
              <DriveTile key={drive.root} drive={drive} paths={paths} editable={editable} onToggle={onToggleDrive} />
            ))}
          </div>
        ) : (
          <Notice>Nenhum disco foi encontrado neste PC.</Notice>
        )}
      </section>

      <section aria-labelledby="folders-list">
        <SectionHeading
          id="folders-list"
          action={
            editable ? (
              <Button icon={<Plus aria-hidden="true" />} onClick={onPick}>
                Adicionar pastas
              </Button>
            ) : null
          }
        >
          {entries.length > 0 ? `Pastas permitidas · ${entries.length}` : 'Pastas permitidas'}
        </SectionHeading>
        {state.rootsUnknown ? (
          <p className="rounded-lg border border-dashed border-input px-6 py-8 text-center text-[13px] leading-5 text-muted-foreground">
            Não foi possível ler a lista de pastas desse daemon.
          </p>
        ) : entries.length > 0 ? (
          <Group>
            <ul aria-labelledby="folders-list" className="divide-y divide-border">
              {entries.map((entry) => (
                <FolderRow key={entry.path} entry={entry} editable={editable} onReveal={onReveal} onRemove={onRemove} />
              ))}
            </ul>
          </Group>
        ) : (
          <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-input px-6 py-10 text-center">
            <span className="mb-2 grid size-10 place-items-center rounded-full bg-attention/12 text-attention [&_svg]:size-5">
              <FolderPlus aria-hidden="true" />
            </span>
            <h3 className="font-display text-[15px] font-semibold">Nenhuma pasta permitida</h3>
            <p className="max-w-[440px] text-[13px] leading-5 text-muted-foreground">
              Enquanto a lista estiver vazia, nenhum workspace pode ser adicionado no app do iPhone. Adicione uma pasta ou libere um disco inteiro.
            </p>
            {editable ? (
              <Button className="mt-3" variant="primary" icon={<Plus aria-hidden="true" />} onClick={onPick}>
                Adicionar pastas
              </Button>
            ) : null}
          </div>
        )}
      </section>

      {changes.dirty ? <SaveBar changes={changes} saving={saving} busySessions={state.busySessions} onDiscard={onDiscard} onSave={onSave} /> : null}
    </>
  );
}

function FoldersSkeleton() {
  return (
    <>
      <Skeleton className="h-16 rounded-lg" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(264px,1fr))] gap-3" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-[148px] rounded-lg" />
        ))}
      </div>
      <GroupSkeleton rows={3} />
    </>
  );
}

/* --------------------------------------------------------------- container */

type Pending = null | { mode: 'save' } | { mode: 'restart' };

export function FoldersSection() {
  const api = useApi();
  const toast = useToast();
  const reported = useReported();
  const shell = useShell();
  const store = useFolders();
  const { resource } = store;
  const { reload } = resource;
  const [pending, setPending] = useState<Pending>(null);
  const [restarting, setRestarting] = useState(false);

  // What was loaded the first time may be old by the time the section is opened again (a restart from the overview, a
  // drive that came or went): look again, silently, every time the section appears.
  const hadData = useRef(resource.state.status === 'ready');
  useEffect(() => {
    if (hadData.current) void reload(true);
  }, [reload]);

  // Drives come and go (a USB stick): look again when the window gets the focus back.
  useEffect(() => {
    const onFocus = (): void => void reload(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const state = resource.state.status === 'ready' ? resource.state.data : null;

  const pick = async (): Promise<void> => {
    let picked: string[];
    try {
      picked = await api.folders.pick();
    } catch {
      toast({ tone: 'error', message: 'Não foi possível abrir o seletor de pastas.' });
      return;
    }
    if (picked.length === 0) return;
    const { added, skipped } = store.add(picked);
    if (added === 0 && skipped > 0) toast({ tone: 'info', message: skipped === 1 ? 'Essa pasta já estava na lista.' : 'Essas pastas já estavam na lista.' });
  };

  const persist = async (choice: SaveChoice): Promise<void> => {
    const outcome = await store.save(choice);
    // Main counted the busy sessions again and there are more than the user agreed to interrupt: the dialog is shown (or
    // updated) with the number main just read. Nothing was saved, and the edits are still on screen.
    if (outcome.kind === 'needs_confirmation') {
      setPending({ mode: 'save' });
      return;
    }
    setPending(null);
    if (outcome.kind === 'failed') {
      toast({ tone: 'error', title: 'Não foi possível salvar', message: outcome.error.message });
      return;
    }
    if (outcome.kind === 'saved') {
      toast(savedMessage(outcome.applied));
      void shell.reloadOverview(true);
    }
  };

  const save = (): void => {
    // Sessions already known to be busy: ask first. Otherwise main decides (it counts again), and may ask anyway.
    if (state && needsRestartChoice(state.busySessions)) setPending({ mode: 'save' });
    else void persist('auto');
  };

  const restartNow = async (): Promise<void> => {
    setRestarting(true);
    const result = await store.restart();
    setRestarting(false);
    setPending(null);
    if (result.ok) {
      toast(restartedMessage(result.value));
      void shell.reloadOverview(true);
    } else {
      toast({ tone: 'error', title: 'Não foi possível reiniciar', message: result.message });
    }
  };

  const onRestartClick = (): void => setPending({ mode: 'restart' });

  let body;
  if (resource.state.status === 'loading') body = <FoldersSkeleton />;
  else if (resource.state.status === 'error') body = <ErrorState error={resource.state.error} onRetry={() => void reload()} />;
  else if (state) {
    body = (
      <FoldersView
        state={state}
        entries={store.entries}
        paths={store.paths}
        changes={store.changes}
        saving={store.saving}
        restarting={restarting}
        onPick={() => void pick()}
        onRemove={store.remove}
        onToggleDrive={store.toggleDrive}
        onReveal={(path) => reported(() => api.folders.reveal(path), 'Não foi possível mostrar a pasta no Explorer.')}
        onDiscard={store.discard}
        onSave={save}
        onRestartNow={onRestartClick}
      />
    );
  }

  return (
    <Page section="folders">
      {body}
      <RestartDialog
        open={pending !== null}
        mode={pending?.mode ?? 'save'}
        busySessions={state?.busySessions ?? 0}
        busy={store.saving || restarting}
        onCancel={() => setPending(null)}
        onLater={() => void persist('later')}
        onNow={() => void (pending?.mode === 'restart' ? restartNow() : persist('now'))}
      />
    </Page>
  );
}
