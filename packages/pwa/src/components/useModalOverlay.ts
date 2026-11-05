import { useEffect, useRef } from 'react';

/** The part of the browser history an overlay uses. The app passes `window.history`; tests pass a fake. */
export interface HistoryPort {
  /** Adds the overlay's entry, at the same depth as the screen under it. */
  push(): void;
  /** Pops the overlay's entry. Browsers apply it later, in a task of their own, and then fire popstate. */
  back(): void;
  /** Listens for popstate (the back gesture, or the pop requested by `back()`). Returns the function that stops it. */
  onPop(listener: () => void): () => void;
}

export interface ModalOverlay {
  /** Mounted: pushes the entry and listens for the back gesture. */
  open(): void;
  /**
   * Unmounted: pops the entry, unless the back gesture already did. A queued action runs after that pop, so an action
   * that pushes its own history entry is not removed by it.
   */
  close(): void;
  /** Queues `action` to run after the close, and dismisses the overlay. */
  closeThen(action: () => void): void;
}

/**
 * Sequencing of an overlay's history entry. Closing by a button, Esc or a pick pops the entry with back(), which is
 * asynchronous. A picked action waits for that pop: if it ran first and pushed an entry, the late pop would remove
 * that entry and bring the screen back to the depth the pop lands on.
 */
export function createModalOverlay(port: HistoryPort, onDismiss: () => void): ModalOverlay {
  let stopListening: (() => void) | null = null;
  let closedByBack = false;
  let pending: (() => void) | null = null;

  return {
    open() {
      port.push();
      stopListening = port.onPop(() => {
        closedByBack = true;
        onDismiss();
      });
    },
    close() {
      stopListening?.();
      stopListening = null;
      const next = pending;
      pending = null;
      if (closedByBack) {
        next?.();
        return;
      }
      if (next === null) {
        port.back();
        return;
      }
      const stop = port.onPop(() => {
        stop();
        next();
      });
      port.back();
    },
    closeThen(action) {
      pending = action;
      onDismiss();
    },
  };
}

const browserHistory: HistoryPort = {
  push() {
    window.history.pushState(window.history.state, '');
  },
  back() {
    window.history.back();
  },
  onPop(listener) {
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  },
};

/**
 * Comportamento de sobreposição modal (visualizador, folha de ações): Esc fecha, o voltar do navegador
 * (gesto do iOS ou do Android) fecha só a sobreposição, e a rolagem da página fica travada enquanto montada.
 *
 * Ao montar, empilha uma entrada no history com a mesma profundidade do app (App.tsx usa `depth` para voltar
 * de tela). Fechar pelo botão ou pelo Esc desfaz essa entrada com history.back(); fechar pelo voltar não desfaz,
 * porque o navegador já saiu dela. Veja createModalOverlay para a ordem em que a ação escolhida roda.
 *
 * Devolve `closeThen(action)`: fecha a sobreposição e roda `action` só depois que a entrada saiu do history.
 */
export function useModalOverlay(onDismiss: () => void): (action: () => void) => void {
  const dismissRef = useRef(onDismiss);
  const overlayRef = useRef<ModalOverlay | null>(null);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const { body, documentElement } = document;
    const previousBody = body.style.overflow;
    const previousHtml = documentElement.style.overflow;
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    const overlay = createModalOverlay(browserHistory, () => dismissRef.current());
    overlayRef.current = overlay;
    overlay.open();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissRef.current();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      body.style.overflow = previousBody;
      documentElement.style.overflow = previousHtml;
      overlayRef.current = null;
      overlay.close();
    };
  }, []);

  return (action) => {
    const overlay = overlayRef.current;
    if (overlay === null) action();
    else overlay.closeThen(action);
  };
}
