import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { systemDirectory } from '../common/system-paths.js';

/**
 * The removal that runs after this process exits. A running exe cannot delete itself, so the uninstaller (and the
 * installer, for its own profile) starts a detached `wscript.exe` that retries the deletion for about 30 s.
 *
 * `wscript.exe` is a GUI-subsystem program, so Windows gives it no console and nothing is shown. The former design ran a
 * detached `cmd.exe` with `ping` as a one-second sleep: a detached `cmd` gets no console either, and every console program
 * it started (each `ping`) then opened a visible console window.
 */

/**
 * Characters that cannot travel safely as one argument of the Windows command line: a quote ends the argument, and CR, LF
 * and NUL end the line. Windows forbids them in file names anyway, so this refuses only a string that was never a folder.
 */
const UNSAFE_ARGUMENT = /["\r\n\0]/;

export function assertSafeRemovalPath(path: string): void {
  if (UNSAFE_ARGUMENT.test(path)) throw new Error(`caminho não suportado para remoção agendada: ${path}`);
}

/**
 * The JScript that `wscript.exe` runs. The folders come from its arguments, so the text is the same for every removal. It
 * is plain ASCII so that the file reads the same in any Windows codepage.
 *
 * `FileSystemObject` follows junctions: `DeleteFolder` through one deletes the contents of the folder the junction points
 * to, which is not what removing a link means. So a folder is handed to `DeleteFolder` only when no link sits anywhere in
 * its tree. A folder that does hold a link stays in place, and the link is never entered.
 */
export const REMOVAL_SCRIPT = `// Deletes the folders given as arguments, retrying while the uninstaller still holds files in them.
var ATTEMPTS = 30;
var INTERVAL_MS = 1000;
// FILE_ATTRIBUTE_REPARSE_POINT: set on junctions and symbolic links.
var REPARSE_POINT = 1024;

var fso = new ActiveXObject('Scripting.FileSystemObject');

// True when a link sits in the folder or anywhere below it. A link is reported, never entered.
function holdsLink(folder) {
  if (folder.Attributes & REPARSE_POINT) return true;
  var files = new Enumerator(folder.Files);
  for (; !files.atEnd(); files.moveNext()) {
    if (files.item().Attributes & REPARSE_POINT) return true;
  }
  var subfolders = new Enumerator(folder.SubFolders);
  for (; !subfolders.atEnd(); subfolders.moveNext()) {
    if (holdsLink(subfolders.item())) return true;
  }
  return false;
}

function removeFolder(path) {
  if (!fso.FolderExists(path)) return;
  if (holdsLink(fso.GetFolder(path))) return;
  fso.DeleteFolder(path, true);
}

function pendingFolders(paths) {
  var pending = [];
  for (var i = 0; i < paths.length; i++) {
    if (fso.FolderExists(paths[i])) pending.push(paths[i]);
  }
  return pending;
}

var dirs = [];
for (var i = 0; i < WScript.Arguments.length; i++) {
  dirs.push(WScript.Arguments.Item(i));
}

for (var attempt = 0; attempt < ATTEMPTS; attempt++) {
  for (var j = 0; j < dirs.length; j++) {
    try {
      removeFolder(dirs[j]);
    } catch (error) {
      // Held by a process, or not readable yet: the next attempt tries again.
    }
  }
  if (pendingFolders(dirs).length === 0) break;
  WScript.Sleep(INTERVAL_MS);
}

try {
  fso.DeleteFile(WScript.ScriptFullName, true);
} catch (error) {
  // Left in the temp folder, where Windows cleans it up.
}
`;

/** `wscript.exe` from `System32`, by its absolute path: a bare name is searched in the working directory before `PATH`. */
export function wscriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemDirectory(env), 'wscript.exe');
}

/** Arguments of `wscript.exe`: the JScript engine, no error dialogs (`//B`), no banner, the script, then the folders. */
export function removalArgs(scriptPath: string, dirs: readonly string[]): string[] {
  for (const dir of dirs) assertSafeRemovalPath(dir);
  return ['//E:jscript', '//B', '//Nologo', scriptPath, ...dirs];
}

function discardScript(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Starts the removal of `dirs` as a detached `wscript.exe` that outlives this process. The script goes to a fresh file in
 * the temp folder, never inside a folder being removed. The child runs from `System32`: it inherits this process's working
 * directory, and a process that holds a folder as its working directory keeps that folder from being deleted.
 */
export function scheduleRemoval(dirs: readonly string[]): void {
  const scriptPath = join(tmpdir(), `nanachi-removal-${randomUUID()}.js`);
  const args = removalArgs(scriptPath, dirs); // refuses an unsafe folder before anything is written
  writeFileSync(scriptPath, REMOVAL_SCRIPT, { flag: 'wx' });
  let child: ChildProcess;
  try {
    child = spawn(wscriptPath(), args, {
      cwd: systemDirectory(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    discardScript(scriptPath);
    throw error;
  }
  // Without a listener, a wscript that cannot start would crash the app. The folders then stay where they are.
  child.on('error', () => discardScript(scriptPath));
  child.unref();
}
