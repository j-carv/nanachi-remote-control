import type { InstallerApi, UninstallerApi } from '../../src/install/ipc.js';

declare global {
  interface Window {
    installer?: InstallerApi;
    uninstaller?: UninstallerApi;
  }
}

/** The element with `data-slot="<slot>"`; a missing one is a bug in the page, so it throws. */
export function slot<T extends HTMLElement = HTMLElement>(name: string): T {
  const element = document.querySelector<T>(`[data-slot="${name}"]`);
  if (element === null) throw new Error(`data-slot="${name}" não existe na página`);
  return element;
}

/** Shows one `<section data-view>` and hides the others. */
export function showView(name: string): void {
  for (const view of document.querySelectorAll<HTMLElement>('[data-view]')) {
    view.hidden = view.dataset.view !== name;
  }
}

/** Updates the bar and its labels. The bar never goes backwards. */
export function createProgressView(): { set(label: string, percent: number): void; reset(): void } {
  const step = slot('step');
  const percentLabel = slot('percent');
  const track = slot('track');
  const fill = track.querySelector<HTMLElement>('.fill');
  let shown = 0;
  function paint(percent: number): void {
    shown = percent;
    percentLabel.textContent = `${percent}%`;
    track.setAttribute('aria-valuenow', String(percent));
    fill?.style.setProperty('--progress', String(percent / 100));
  }
  return {
    set(label, percent) {
      step.textContent = `${label}…`;
      paint(Math.max(shown, Math.min(100, Math.round(percent))));
    },
    reset() {
      step.textContent = 'Preparando…';
      paint(0);
    },
  };
}
