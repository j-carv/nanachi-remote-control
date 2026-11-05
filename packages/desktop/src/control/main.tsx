import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import type { ControlApi } from '../common/control-api.js';
import { languageFromLocale } from '../common/i18n/index.js';
import { App } from './App.js';
import { createControlI18n } from './i18n.js';
import { MissingBridge } from './MissingBridge.js';
import './styles.css';

/**
 * The preload exposes `window.nanachiControl`. Without it the page says so. Only a mock build (`__CONTROL_MOCK__`,
 * made for screenshots and development) may install the in-memory API, and only with `?mock=1`; in the shipped build
 * that branch is dead code and the mock is not in the bundle.
 */
async function resolveApi(): Promise<ControlApi | null> {
  if (window.nanachiControl) return window.nanachiControl;
  if (__CONTROL_MOCK__) {
    const { installMockApi } = await import('./mock/install.js');
    return installMockApi(window.location.search);
  }
  return null;
}

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const api = await resolveApi();
// Outside Desktop there is no setting to read: the browser's own language picks the one of the "open it from Desktop" page.
createRoot(container).render(
  api ? (
    <App api={api} />
  ) : (
    <I18nextProvider i18n={createControlI18n(languageFromLocale(navigator.language))}>
      <MissingBridge />
    </I18nextProvider>
  ),
);
