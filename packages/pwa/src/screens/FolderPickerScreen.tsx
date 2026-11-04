import { useEffect, useState, type FormEvent } from 'react';
import { Folder } from '@phosphor-icons/react';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { normalizeTypedPath, typedPathErrorText } from '../folderPath.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';

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
    <main className="screen">
      <ScreenHeader
        title="Escolher pasta"
        subtitle={data?.path ?? 'Pastas permitidas no PC'}
        onBack={() => nav.back()}
      />

      <form className="card form" onSubmit={(event) => void goToTyped(event)}>
        <label className="field">
          <span>Digitar caminho</span>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="C:\Users\..."
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button secondary"
          disabled={checking || normalizeTypedPath(typed) === ''}
        >
          {checking ? 'Verificando…' : 'Ir'}
        </button>
      </form>

      {typedError !== null && (
        <div className="error" role="alert">
          <p>{typedPathErrorText(typedError)}</p>
        </div>
      )}

      <ErrorNotice error={error} onRepair={onRepair} />

      {data !== null && data.path !== null && (
        <button
          type="button"
          className="button secondary"
          disabled={listing.loading}
          onClick={() => setCurrent(data.parent)}
        >
          {data.parent === null ? '↑ Raízes' : '↑ Pasta acima'}
        </button>
      )}

      {data === null && error === null && <p className="muted">Carregando…</p>}
      {data !== null && data.dirs.length === 0 && <p className="muted">Nenhuma subpasta aqui.</p>}

      <ul className="item-list">
        {data?.dirs.map((dir) => (
          <li key={dir.path}>
            <button
              type="button"
              className="item-main"
              disabled={listing.loading}
              onClick={() => setCurrent(dir.path)}
            >
              <span className="item-title folder-title">
                <Folder size={20} weight="regular" aria-hidden="true" />
                {dir.name}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {data !== null && data.path !== null && (
        <button
          type="button"
          className="button primary sticky-action"
          disabled={!pickable}
          onClick={() => {
            if (data.path !== null) void useFolder(data.path);
          }}
        >
          {creating ? 'Adicionando…' : 'Usar esta pasta'}
        </button>
      )}
    </main>
  );
}
