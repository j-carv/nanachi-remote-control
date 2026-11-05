import { createContext, useContext } from 'react';

/**
 * Adiciona um arquivo aos anexos do composer. O ChatScreen fornece; fora do chat não há valor (null), e quem usa
 * (o visualizador de imagens) esconde a ação "Anexar ao chat".
 */
export const ChatAttachContext = createContext<((file: File) => void) | null>(null);

export function useChatAttach(): ((file: File) => void) | null {
  return useContext(ChatAttachContext);
}
