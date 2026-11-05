import type { UninstallerApi, UninstallerInit } from '../../src/install/ipc.js';
import { createProgressView, showView, slot } from './common.js';

/** The uninstall window of `Nanachi.exe --uninstall`: the question, progress, and the result. */

const bridge: UninstallerApi | undefined = window.uninstaller;

function start(api: UninstallerApi, init: UninstallerInit): void {
  const deleteData = slot<HTMLInputElement>('delete-data');
  const progress = createProgressView();
  const closeButton = slot<HTMLButtonElement>('close');
  let removing = false;

  deleteData.checked = init.deleteData;
  slot('data-dir').textContent = init.dataDir;
  slot('version').textContent = `Versão ${init.version}`;
  if (init.testMode) {
    const scope = slot('scope');
    scope.textContent = 'modo de teste';
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
    slot('done-detail').textContent = deleteData.checked
      ? 'O programa e os dados foram removidos.'
      : 'Seus dados foram mantidos e voltam se você instalar de novo.';
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
  document.body.textContent = 'O desinstalador não conseguiu iniciar (sem ponte com o aplicativo).';
} else {
  void bridge.init().then((init) => start(bridge, init));
}
