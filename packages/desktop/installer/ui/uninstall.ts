import { t } from '../../src/common/i18n/index.js';
import type { UninstallerApi, UninstallerInit } from '../../src/install/ipc.js';
import { applyLanguage, browserLanguage, createProgressView, showBridgeMissing, showView, slot } from './common.js';

/** The uninstall window of `Nanachi.exe --uninstall`: the question, progress, and the result. */

const bridge: UninstallerApi | undefined = window.uninstaller;

/** Stands where the folder goes in the sentence; the folder itself is put in its own element, in monospace. */
const FOLDER_MARK = '\u0001';

/** "Your sessions ... stay saved in <folder> ...": the sentence follows the language, the folder is set apart. */
function writeDataNote(dataDir: string): void {
  const [before = '', after = ''] = t('installer.uninstall.dataNote', { dataDir: FOLDER_MARK }).split(FOLDER_MARK);
  const folder = document.createElement('span');
  folder.className = 'mono';
  folder.dataset.slot = 'data-dir';
  folder.textContent = dataDir;
  slot('data-note').replaceChildren(before, folder, after);
}

function start(api: UninstallerApi, init: UninstallerInit): void {
  // Desktop's own setting when there is one, the system locale otherwise: the main process picked it.
  applyLanguage(init.language);
  const deleteData = slot<HTMLInputElement>('delete-data');
  const progress = createProgressView();
  const closeButton = slot<HTMLButtonElement>('close');
  let removing = false;

  deleteData.checked = init.deleteData;
  writeDataNote(init.dataDir);
  slot('version').textContent = t('installer.common.version', { version: init.version });
  if (init.testMode) {
    const scope = slot('scope');
    scope.textContent = t('installer.common.testMode');
    scope.classList.add('badge');
  }

  slot('minimize').addEventListener('click', () => api.minimize());
  closeButton.addEventListener('click', () => api.close());
  slot('cancel').addEventListener('click', () => api.close());
  slot('done-close').addEventListener('click', () => api.close());
  slot('error-close').addEventListener('click', () => api.close());

  api.onProgress((update) => {
    progress.set(update.label, update.percent);
  });

  async function remove(): Promise<void> {
    if (removing) return;
    removing = true;
    closeButton.disabled = true;
    progress.reset();
    showView('progress');
    const outcome = await api.start({ deleteData: deleteData.checked });
    removing = false;
    closeButton.disabled = false;
    if (!outcome.ok) {
      slot('error-message').textContent = outcome.message;
      showView('error');
      return;
    }
    slot('done-detail').textContent = deleteData.checked ? t('installer.uninstall.doneDetailDeleted') : t('installer.uninstall.doneDetailKept');
    const warnings = slot('warnings');
    warnings.replaceChildren(
      ...outcome.warnings.map((warning) => {
        const item = document.createElement('li');
        item.textContent = warning;
        return item;
      }),
    );
    warnings.hidden = outcome.warnings.length === 0;
    showView('done');
    slot<HTMLButtonElement>('done-close').focus();
  }

  slot('remove').addEventListener('click', () => void remove());
  showView('confirm');
  slot<HTMLButtonElement>('cancel').focus();
}

if (bridge === undefined) {
  showBridgeMissing('installer.uninstall.bridgeMissing');
} else {
  // If the main process cannot answer, the page still shows itself (in the browser's language) instead of staying hidden.
  void bridge.init().then(
    (init) => start(bridge, init),
    () => applyLanguage(browserLanguage()),
  );
}
