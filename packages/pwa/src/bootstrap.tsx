// Initialises i18next (and <html lang>) before anything renders.
import './i18n/index.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { withoutCacheBust } from './updates/cacheBust.js';

// Removes the `?v=` that "Forçar atualização" adds to the URL to bypass the cache. Only the URL changes; no reload.
const cleanHref = withoutCacheBust(location.href);
if (cleanHref !== null) history.replaceState(history.state, '', cleanHref);

const root = document.getElementById('root');
if (root === null) throw new Error('element #root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
