import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ScreenProps {
  children: ReactNode;
  className?: string | undefined;
}

/**
 * Casca de uma tela: coluna única, 16px de margem lateral e safe-area em todas as bordas (iPhone com notch
 * e a barra de início). A altura mínima é 100dvh, para o teclado do iOS não cortar o rodapé.
 */
export function Screen({ children, className }: ScreenProps) {
  return (
    <main
      className={cn(
        'mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-5 bg-background text-foreground',
        'pt-[calc(env(safe-area-inset-top,0px)+12px)] pr-[calc(env(safe-area-inset-right,0px)+16px)] pb-[calc(env(safe-area-inset-bottom,0px)+24px)] pl-[calc(env(safe-area-inset-left,0px)+16px)]',
        className,
      )}
    >
      {children}
    </main>
  );
}
