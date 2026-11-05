import { t } from '../../src/common/i18n/index.js';
import type { InstallerApi, InstallerInit } from '../../src/install/ipc.js';
import { applyLanguage, browserLanguage, createProgressView, showBridgeMissing, showView, slot } from './common.js';

/** The installer window: idle, options, progress, done, error, and the "close Nanachi first" question. */

const bridge: InstallerApi | undefined = window.installer;

function start(api: InstallerApi, init: InstallerInit): void {
  // The installer runs before any setting exists: the main process picked the language from the system locale.
  applyLanguage(init.language);
  const target = slot<HTMLInputElement>('target');
  const targetError = slot('target-error');
  const desktopShortcut = slot<HTMLInputElement>('desktop-shortcut');
  const startWithWindows = slot<HTMLInputElement>('start-with-windows');
  const progress = createProgressView();
  let installing = false;

  target.value = init.target;
  desktopShortcut.checked = init.desktopShortcut;
  startWithWindows.checked = init.startWithWindows;
  slot('version').textContent = t('installer.common.version', { version: init.version });
  if (init.testMode) {
    const scope = slot('scope');
    scope.textContent = t('installer.common.testMode');
    scope.classList.add('badge');
  }

  const closeButton = slot<HTMLButtonElement>('close');
  slot('minimize').addEventListener('click', () => api.minimize());
  closeButton.addEventListener('click', () => api.close());

  function showTargetError(reason: string | null): void {
    targetError.hidden = reason === null;
    targetError.textContent = reason ?? '';
  }

  async function install(): Promise<void> {
    if (installing) return;
    const validation = await api.validateTarget(target.value);
    if (!validation.ok) {
      showTargetError(validation.reason);
      showView('options');
      target.focus();
      return;
    }
    showTargetError(null);
    installing = true;
    closeButton.disabled = true;
    progress.reset();
    showView('progress');
    const outcome = await api.start({
      target: target.value,
      desktopShortcut: desktopShortcut.checked,
      startWithWindows: startWithWindows.checked,
    });
    installing = false;
    closeButton.disabled = false;
    if (outcome.ok) {
      slot('done-detail').textContent = init.testMode ? t('installer.setup.doneDetailTestMode') : t('installer.setup.doneDetail');
      showView('done');
      slot<HTMLButtonElement>('launch').focus();
    } else {
      slot('error-message').textContent = outcome.message;
      showView('error');
    }
  }

  api.onProgress((update) => {
    progress.set(update.label, update.percent);
  });
  api.onAskClose((processes) => {
    const names = [...new Set(processes.map((entry) => entry.name))].join(', ');
    slot('close-detail').textContent = t('installer.setup.closeDetail', { names });
    showView('close');
  });
  slot('close-confirm').addEventListener('click', () => {
    api.answerClose(true);
    showView('progress');
  });
  slot('close-cancel').addEventListener('click', () => {
    api.answerClose(false);
    showView('progress');
  });

  slot('install').addEventListener('click', () => void install());
  slot('install-from-options').addEventListener('click', () => void install());
  slot('options-open').addEventListener('click', () => {
    showTargetError(null);
    showView('options');
  });
  slot('options-close').addEventListener('click', () => showView('idle'));
  slot('choose-folder').addEventListener('click', () => {
    void api.chooseFolder(target.value).then((chosen) => {
      if (chosen === null) return;
      target.value = chosen;
      showTargetError(null);
    });
  });
  slot('launch').addEventListener('click', () => void api.launch());
  slot('done-close').addEventListener('click', () => api.close());
  slot('error-close').addEventListener('click', () => api.close());
  slot('retry').addEventListener('click', () => showView('idle'));

  showView('idle');
  slot<HTMLButtonElement>('install').focus();
}

if (bridge === undefined) {
  showBridgeMissing('installer.setup.bridgeMissing');
} else {
  // If the main process cannot answer, the page still shows itself (in the browser's language) instead of staying hidden.
  void bridge.init().then(
    (init) => start(bridge, init),
    () => applyLanguage(browserLanguage()),
  );
}
