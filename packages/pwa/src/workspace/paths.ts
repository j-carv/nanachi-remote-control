/** Caminho do pai ("" para quem está na raiz). Caminhos usam `/`, como a API responde. */
export function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Junta uma pasta e um nome. A raiz é "". */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

export interface Crumb {
  label: string;
  path: string;
}

/** Migalhas da raiz (nome do workspace) até `path`. Cada uma aponta para o caminho até ali. */
export function breadcrumbs(path: string, workspaceName: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: workspaceName, path: '' }];
  if (path === '') return crumbs;
  const parts = path.split('/');
  parts.forEach((part, index) => {
    crumbs.push({ label: part, path: parts.slice(0, index + 1).join('/') });
  });
  return crumbs;
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Mensagem de erro para um nome de arquivo ou pasta, ou null se o nome vale. Espelha as regras do daemon
 * (`workspace-paths.ts`) para o usuário ver o problema antes do envio; o daemon continua decidindo.
 */
export function validateEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Digite um nome.';
  if (trimmed.length > 255) return 'Nome longo demais (máx. 255 caracteres).';
  if (/[/\\]/.test(trimmed)) return 'Use um nome sem barras.';
  if (trimmed === '.' || trimmed === '..') return 'Este nome não é permitido.';
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) return 'Este nome não é permitido.';
  if (/[. ]$/.test(trimmed)) return 'Este nome não é permitido.';
  if (DEVICE_NAME.test(trimmed)) return 'Este nome não é permitido.';
  return null;
}

/** Tamanho em pt-BR: "512 B", "1,5 KB", "3,0 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
