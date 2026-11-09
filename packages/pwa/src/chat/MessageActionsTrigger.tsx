import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ChatItem } from './reducer.js';

const HOLD_MS = 480;
const MOVE_PX = 10;
const INTERACTIVE = 'a, button, input, select, textarea, summary, [contenteditable="true"]';
const MESSAGE_BODY = '[data-slot="bubble-user"], [data-slot="agent-text"]';

function onMessageBody(target: EventTarget): boolean {
  return target instanceof Element && target.closest(MESSAGE_BODY) !== null && target.closest(INTERACTIVE) === null;
}

export type ActionMessage = Extract<ChatItem, { kind: 'user_message' | 'agent_message' }>;

export function MessageActionsTrigger({ children, message, onOpen }: {
  children: ReactNode;
  message: ActionMessage;
  onOpen?: ((message: ActionMessage) => void) | undefined;
}) {
  const { t } = useTranslation('chat');
  const press = useRef<{ id: number; x: number; y: number; timer: number } | null>(null);

  function stop() {
    if (press.current === null) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  }

  useEffect(() => stop, []);

  if (onOpen === undefined || message.text.trim() === '') return children;
  const open = () => onOpen(message);

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0 || !onMessageBody(event.target)) return;
    stop();
    press.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      timer: window.setTimeout(() => { stop(); open(); }, HOLD_MS),
    };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const held = press.current;
    if (held?.id === event.pointerId && Math.hypot(event.clientX - held.x, event.clientY - held.y) >= MOVE_PX) stop();
  }

  return (
    <div
      className="relative flex min-w-0 flex-col"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onContextMenu={(event) => {
        if (!onMessageBody(event.target)) return;
        event.preventDefault();
        stop();
        open();
      }}
    >
      {children}
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-0 focus-visible:right-0 focus-visible:z-10"
        aria-label={t('messageActions.title')}
        aria-haspopup="dialog"
        onClick={open}
      >
        <Ellipsis aria-hidden="true" />
      </Button>
    </div>
  );
}
