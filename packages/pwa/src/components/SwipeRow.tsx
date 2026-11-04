import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { classifySwipe, settleSwipe, SWIPE_ACTION_WIDTH, swipeOffset } from '../swipe.js';

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
    <div className="swipe-row">
      <div
        className={dragging ? 'swipe-track dragging' : 'swipe-track'}
        // Fechada, sem transform: um transform cria o bloco de contenção do `position: fixed` e o menu "…" sairia
        // deslocado da tela.
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
        className="swipe-action"
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
