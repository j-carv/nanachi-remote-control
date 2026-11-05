import { useEffect, useRef } from 'react';

/**
 * Comportamento de sobreposição modal (visualizador, folha de ações): Esc fecha, o voltar do navegador
 * (gesto do iOS ou do Android) fecha só a sobreposição, e a rolagem da página fica travada enquanto montada.
 *
 * Ao montar, empilha uma entrada no history com a mesma profundidade do app (App.tsx usa `depth` para voltar
 * de tela). Fechar pelo botão ou pelo Esc desfaz essa entrada com history.back(); fechar pelo voltar não desfaz,
 * porque o navegador já saiu dela.
 */
export function useModalOverlay(onDismiss: () => void): void {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const { body, documentElement } = document;
    const previousBody = body.style.overflow;
    const previousHtml = documentElement.style.overflow;
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    window.history.pushState(window.history.state, '');
    let closedByBack = false;

    const onPop = () => {
      closedByBack = true;
      dismissRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissRef.current();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      body.style.overflow = previousBody;
      documentElement.style.overflow = previousHtml;
      if (!closedByBack) window.history.back();
    };
  }, []);
}
