import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isInside } from './roots.js';
import { parseRelativePath, PATH_MAX_CHARS, realRootOf } from './workspace-paths.js';

// Limit automatic decisions to explicit, single-file text operations. In particular, an ACP "edit" kind or a
// displayed diff alone cannot distinguish a write from a deletion, a move or a broader permission grant.
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.kt',
  '.md', '.mjs', '.py', '.rb', '.rs', '.scss', '.swift', '.ts', '.tsx', '.vue',
]);
const PROTECTED_SEGMENT = /^(?:\.|.*~\d|credentials?(?:[._-]|$)|secrets?(?:[._-]|$)|databases?(?:[._-]|$)|backups?(?:[._-]|$))/i;

function samePath(left: string, right: string): boolean {
  return relative(left, right) === '';
}

function underSystemDirectory(path: string): boolean {
  if (process.platform !== 'win32') {
    return ['/bin', '/boot', '/dev', '/etc', '/proc', '/sbin', '/sys', '/usr', '/var', '/System', '/Library']
      .some((root) => isInside(path, root));
  }
  // Also protect these conventional directories on other drives, independent of the launching account's environment.
  const volumeEntry = resolve(path).split(sep)[1];
  const systemDirectories = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData];
  return /^(?:windows|program files(?: \(x86\))?|programdata|system volume information|\$recycle\.bin)$/i.test(volumeEntry ?? '') ||
    systemDirectories.some((root) => root !== undefined && isAbsolute(root) && isInside(path, root));
}

function fileTarget(workspace: string, input: string, creating: boolean): boolean {
  if (input.length > PATH_MAX_CHARS || /^[\\/]{2}/.test(input) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(input)) return false;
  if (!isAbsolute(input) && /^[a-z]:/i.test(input)) return false;
  const root = realRootOf(workspace);
  if (!samePath(root, workspace) || samePath(root, resolve(root, '..')) ||
    isInside(homedir(), root) || underSystemDirectory(root)) return false;

  const target = resolve(root, input);
  if (!isInside(target, root) || underSystemDirectory(target)) return false;
  const segments = parseRelativePath(relative(root, target));
  if (segments.length === 0 || segments.some((segment) => PROTECTED_SEGMENT.test(segment))) return false;
  if (!TEXT_EXTENSIONS.has(extname(target).toLowerCase())) return false;

  let path = root;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const last = index === segments.length - 1;
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined) return last && creating;
    if (info.isSymbolicLink() || !samePath(realRootOf(path), path)) return false;
    if (last) return !creating && info.isFile() && info.nlink === 1;
    if (!info.isDirectory()) return false;
  }
  return false;
}

function recognizedFileOperation(tool: RequestPermissionRequest['toolCall']): { path: string; creating: boolean } | undefined {
  const input = tool.rawInput;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  if (!('file_path' in input) || typeof input.file_path !== 'string' || input.file_path === '') return undefined;
  const keys = Object.keys(input);

  // These are the complete inputs used by the built-in Read, Edit and Write tools in the Claude ACP adapter.
  // Match the tool name, kind and input together so other adapters can use the same shape.
  if (tool.name === 'Read' && tool.kind === 'read' && keys.every((key) => ['file_path', 'offset', 'limit'].includes(key))) {
    if (('offset' in input && !positiveInteger(input.offset)) || ('limit' in input && !positiveInteger(input.limit))) return undefined;
    return { path: input.file_path, creating: false };
  }
  if (tool.name === 'Edit' && tool.kind === 'edit' &&
    keys.every((key) => ['file_path', 'old_string', 'new_string', 'replace_all'].includes(key)) &&
    'old_string' in input && typeof input.old_string === 'string' && input.old_string.trim() !== '' &&
    'new_string' in input && typeof input.new_string === 'string' && input.new_string.trim() !== '' &&
    (!('replace_all' in input) || input.replace_all === false)) {
    return { path: input.file_path, creating: false };
  }
  if (tool.name === 'Write' && tool.kind === 'edit' && keys.length === 2 &&
    'content' in input && typeof input.content === 'string') {
    return { path: input.file_path, creating: true };
  }
  return undefined;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Returns a one-time option only when the request exposes a supported, low-risk operation. */
export function yoloApproval(workspace: string, request: RequestPermissionRequest): string | undefined {
  const options = request.options.filter((option) => option.kind === 'allow_once');
  const option = options.length === 1 ? options[0] : undefined;
  if (option === undefined || option.optionId === '' ||
    request.options.some((other) => other !== option && other.optionId === option.optionId)) return undefined;

  const operation = recognizedFileOperation(request.toolCall);
  if (operation === undefined) return undefined;
  try {
    const target = resolve(workspace, operation.path);
    if (request.toolCall.locations?.some(({ path }) => !samePath(target, resolve(workspace, path)))) return undefined;
    if (request.toolCall.content?.some((item) => item.type === 'terminal' ||
      (item.type === 'diff' && !samePath(target, resolve(workspace, item.path))))) return undefined;
    return fileTarget(workspace, operation.path, operation.creating) ? option.optionId : undefined;
  } catch {
    // Unknown, inaccessible or changing filesystem state goes through the ordinary permission card.
    return undefined;
  }
}
