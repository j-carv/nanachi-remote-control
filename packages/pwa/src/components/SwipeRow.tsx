import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { classifySwipe, settleSwipe, SWIPE_ACTION_WIDTH, swipeOffset } from '../swipe.js';
import { cn } from '@/lib/utils';

interface SwipeRowProps {
  /** Texto da ação revelada (ex.: "Remover do app"). */
  actionLabel: string;
  onAction(): void;
  children: ReactNode;
}

interface Gesture {
  x: number;
  y: number;
  /** Deslocamento de partida: 0 fechado, -largura aberto. */
  base: number;
  axis: 'horizontal' | 'vertical' | undefined;
  offset: number;
  moved: boolean;
}

/**
 * Linha de lista com swipe para a esquerda que revela uma ação, como no iOS. O conteúdo continua tocável;
 * quem não usa gesto tem a mesma ação no menu "…" da linha. Toque com a linha aberta fecha em vez de abrir a sessão.
 */
export function SwipeRow({ actionLabel, onAction, children }: SwipeRowProps) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const open = offset !== 0;

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    gesture.current = {
      x: event.clientX,
      y: event.clientY,
      base: open ? -SWIPE_ACTION_WIDTH : 0,
      axis: undefined,
      offset,
      moved: false,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (current === null) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    current.axis ??= classifySwipe(dx, dy);
    if (current.axis !== 'horizontal') return;
    current.moved = true;
    current.offset = swipeOffset(current.base + dx, SWIPE_ACTION_WIDTH);
    setDragging(true);
    setOffset(current.offset);
  }

  function endGesture() {
    const current = gesture.current;
    gesture.current = null;
    if (current === null || !current.moved) return;
    suppressClick.current = true;
    setDragging(false);
    setOffset(settleSwipe(current.offset, SWIPE_ACTION_WIDTH) ? -SWIPE_ACTION_WIDTH : 0);
  }

  function close() {
    setDragging(false);
    setOffset(0);
  }

  /** Toque depois de um arrasto não conta; com a linha aberta, o toque só fecha. */
  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (open) {
      event.stopPropagation();
      event.preventDefault();
      close();
    }
  }

  return (
    <div data-slot="swipe-row" className="relative overflow-hidden">
      {/* A trilha vem antes da ação na árvore (leitor de tela e `first()` do E2E pegam a linha); z-10 a mantém por cima. */}
      <div
        data-slot="swipe-track"
        className={cn(
          'relative z-10 touch-pan-y bg-card',
          !dragging && 'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
        )}
        // Fechada, sem transform: um transform cria o bloco de contenção do `position: fixed`.
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
      <button
        type="button"
        data-slot="swipe-action"
        className="absolute inset-y-0 right-0 flex items-center justify-center bg-destructive px-3 text-sm font-medium text-white"
        style={{ width: SWIPE_ACTION_WIDTH }}
        tabIndex={open ? 0 : -1}
        onClick={() => {
          close();
          onAction();
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
