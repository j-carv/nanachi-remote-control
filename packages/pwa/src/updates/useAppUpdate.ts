import { useEffect, useState } from 'react';
import { decideUpdateAction, type UpdateAction } from './decideUpdateAction.js';
import { isReloadHeld } from './reloadGuard.js';

// Open dialogs and drawers. Radix and vaul set role="dialog" and data-state="open"; the image viewer is a
// role="dialog" with aria-modal="true" and no data-state. A dialog that is already closing is not counted.
// Checking the DOM keeps every dialog out of this hook; the alternative is a registry each one must join.
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]';

function isDialogOpen(): boolean {
  return document.querySelector(OPEN_DIALOG) !== null;
}

function currentVisibility(): 'visible' | 'hidden' {
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

/**
 * True while a new version is waiting and the update bar should show.
 *
 * The page reloads itself only when the app comes back from the background with nothing held, as
 * `decideUpdateAction` decides. A visible app never reloads on its own; it shows the bar.
 *
 * An update means a controller existed just before the change. A first install has none, so it never
 * triggers the bar or a reload. The service worker calls skipWaiting and clientsClaim, so the new worker
 * takes control at once; the page keeps running the old code until it reloads.
 */
export function useAppUpdate(): boolean {
  const [showBar, setShowBar] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    let updateWaiting = false;
    // Set once, when the first version of this wait arrives: the reload on return only applies to those.
    let arrivedInBackground = false;
    let controlled = container.controller !== null;
    let registration: ServiceWorkerRegistration | undefined;
    let disposed = false;

    function evaluate(returning: boolean): void {
      const action: UpdateAction = decideUpdateAction({
        updateWaiting,
        visibility: currentVisibility(),
        reloadHeld: isReloadHeld(),
        dialogOpen: isDialogOpen(),
        returning,
        arrivedInBackground,
      });
      if (action === 'reload-on-visible') {
        window.location.reload();
        return;
      }
      setShowBar(action === 'show-bar');
    }

    function markWaiting(): void {
      if (!updateWaiting) arrivedInBackground = currentVisibility() === 'hidden';
      updateWaiting = true;
      evaluate(false);
    }

    // A worker that installs while a controller exists is a new version waiting for this page.
    const onUpdateFound = (): void => {
      const worker = registration?.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (disposed) return;
        if (worker.state === 'installed' && container.controller !== null) markWaiting();
      });
    };

    const onControllerChange = (): void => {
      if (controlled) markWaiting();
      controlled = container.controller !== null;
    };

    // Each visibility change re-runs the decision. Only the change to visible is a return.
    const onVisibilityChange = (): void => {
      const visible = currentVisibility() === 'visible';
      // A failed check (offline) is retried on the next visible change.
      if (visible) void registration?.update().catch(() => undefined);
      evaluate(visible);
    };

    container.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibilityChange);

    void container.ready.then((ready) => {
      if (disposed) return;
      registration = ready;
      ready.addEventListener('updatefound', onUpdateFound);
    });

    return () => {
      disposed = true;
      container.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      registration?.removeEventListener('updatefound', onUpdateFound);
    };
  }, []);

  return showBar;
}
