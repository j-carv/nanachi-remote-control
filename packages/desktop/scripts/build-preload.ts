import { buildPreloads } from './preload-build.js';

// See `preload-build.ts`: `dist/preload/index.cjs` (PWA panel) and `dist/preload/control.cjs` (control center).
await buildPreloads({ outdir: 'dist/preload' });
