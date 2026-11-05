import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Vite config of the control center renderer (`src/control`). It is only used through `scripts/build-control.ts`
 * (`build:desktop`): never a dev server on a shared port, never the PWA's config.
 *
 * - `base: './'`: the page is opened with `loadFile`, so every asset URL is relative to `index.html`.
 * - `NANACHI_CONTROL_MOCK=1` bundles the in-memory `ControlApi` (`src/control/mock`) and lets `?mock=1` install it. It is
 *   for the screenshot and development flow only; the shipped build leaves the flag false, so the mock is dead code that
 *   the bundler drops (a test checks the output for it).
 */
const root = fileURLToPath(new URL('./src/control', import.meta.url));

/** `file://` pages load `type="module"` scripts without CORS; the attribute only makes Chromium send an Origin header for nothing. */
function dropCrossorigin(): Plugin {
  return {
    name: 'nanachi-drop-crossorigin',
    enforce: 'post',
    transformIndexHtml: (html) => html.replace(/ crossorigin(?:="[^"]*")?/g, ''),
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [react(), tailwindcss(), dropCrossorigin()],
  define: { __CONTROL_MOCK__: JSON.stringify(process.env.NANACHI_CONTROL_MOCK === '1') },
  build: {
    outDir: fileURLToPath(new URL('./dist/control', import.meta.url)),
    // The build script empties the folder itself (without following junctions, see src/install/safe-remove.ts).
    emptyOutDir: false,
    target: 'chrome130',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  logLevel: 'warn',
});
