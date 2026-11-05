import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronRight, CornerLeftUp, Folder, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listRowClass, listRowPressClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { normalizeTypedPath, typedPathErrorText } from '../folderPath.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FolderPickerScreenProps {
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

interface Listing {
  /** Pasta atual; null é a lista de raízes permitidas. */
  path: string | null;
  /** Pasta acima; null quando a pasta atual é uma raiz (volta para a lista de raízes). */
  parent: string | null;
  dirs: { name: string; path: string }[];
}

async function loadListing(api: ApiClient, path: string | null): Promise<Listing> {
  if (path !== null) {
    const listing = await api.fetchFs(path);
    return { path: listing.path, parent: listing.parent, dirs: listing.dirs };
  }
  const roots = await api.fetchRoots();
  return {
    path: null,
    parent: null,
    dirs: roots.map((root) => ({ name: root.name, path: root.path })),
  };
}

/** Navegador de pastas do PC, limitado às raízes permitidas. Começa nas raízes. */
export function FolderPickerScreen({ api, nav, onRepair }: FolderPickerScreenProps) {
  const { t } = useTranslation('workspace');
  const [current, setCurrent] = useState<string | null>(null);
  const listing = useAsync(() => loadListing(api, current), [api, current]);
  const [createError, setCreateError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  const data = listing.data;
  const error = createError ?? listing.error;
  const pickable = data !== null && data.path !== null && !listing.loading && !creating;
  const currentPath = data?.path ?? null;

  // Ao mudar de pasta (por toque ou por digitação), o campo mostra a pasta atual para editar.
  useEffect(() => {
    setTyped(currentPath ?? '');
    setTypedError(null);
  }, [currentPath]);

  async function goToTyped(event: FormEvent) {
    event.preventDefault();
    const path = normalizeTypedPath(typed);
    if (path === '') return;
    setChecking(true);
    setTypedError(null);
    try {
      await api.fetchFs(path);
      setTyped(path);
      setCurrent(path);
    } catch (caught) {
      setTypedError(caught);
    } finally {
      setChecking(false);
    }
  }

  async function useFolder(path: string) {
    setCreating(true);
    setCreateError(null);
    try {
      await api.createWorkspace({ path });
      nav.back();
    } catch (caught) {
      setCreateError(caught);
      setCreating(false);
    }
  }

  return (
    <Screen className="pb-0">
      <ScreenHeader
        title={t('folders.title')}
        subtitle={data?.path ?? t('folders.allowed')}
        onBack={() => nav.back()}
      />

      <form className="flex flex-col gap-2" onSubmit={(event) => void goToTyped(event)}>
        <Label htmlFor="folder-typed-path">{t('folders.typePath')}</Label>
        <div className="flex gap-2">
          <Input
            id="folder-typed-path"
            type="text"
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="C:\Users\..."
            className="font-mono text-[15px]"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="icon"
            aria-label={checking ? t('folders.checkingPath') : t('folders.goToPath')}
            disabled={checking || normalizeTypedPath(typed) === ''}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </form>

      {typedError !== null && (
        <p role="alert" className="pl-1 text-sm text-destructive">
          {typedPathErrorText(typedError)}
        </p>
      )}

      <ErrorNotice error={error} onRepair={onRepair} />

      {data !== null && data.path !== null && (
        <Button
          variant="ghost"
          className="self-start px-2"
          disabled={listing.loading}
          onClick={() => setCurrent(data.parent)}
        >
          <CornerLeftUp aria-hidden="true" />
          {data.parent === null ? t('folders.roots') : t('folders.parent')}
        </Button>
      )}

      {data === null && error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}
      {data !== null && data.dirs.length === 0 && <p className="animate-enter pl-1 text-muted-foreground">{t('folders.empty')}</p>}

      {data !== null && data.dirs.length > 0 && (
        <ListGroup label={t('folders.listLabel')}>
          {data.dirs.map((dir, index) => (
            <li key={dir.path} className="animate-enter" style={staggerDelay(index)}>
              <button
                type="button"
                className={`${listRowClass} ${listRowPressClass}`}
                disabled={listing.loading}
                onClick={() => setCurrent(dir.path)}
              >
                <Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-base">{dir.name}</span>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ListGroup>
      )}

      {data !== null && data.path !== null && (
        <div className="sticky bottom-0 -mx-4 mt-auto border-t border-border bg-background px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
          <Button
            size="wide"
            disabled={!pickable}
            onClick={() => {
              if (data.path !== null) void useFolder(data.path);
            }}
          >
            <Check aria-hidden="true" />
            {creating ? t('folders.adding') : t('folders.use')}
          </Button>
        </div>
      )}
    </Screen>
  );
}
