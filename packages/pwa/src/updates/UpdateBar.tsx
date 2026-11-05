import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVisualViewport } from '../components/useVisualViewport.js';
import { useAppUpdate } from './useAppUpdate.js';

/**
 * Offers a waiting version. It shows while the app is visible, and while a reload is held (unsent text or an
 * open dialog). A visible app is never reloaded on its own; the user taps Atualizar.
 *
 * It floats just above the chat's bottom stack (composer, attachments and the rest of it). The chat publishes that
 * stack's height as --chat-bottom-h; on other screens the variable is absent and the bar sits above the safe area.
 * With the keyboard open the chat is drawn from the visual viewport, so the keyboard's height is added to the offset.
 * z-40 keeps it under the sheets and the viewer (z-50), so it never covers a sheet's buttons, and above the chat (z-5).
 */
export function UpdateBar() {
  const showBar = useAppUpdate();
  const viewport = useVisualViewport();
  if (!showBar) return null;

  const keyboardInset = viewport === null ? 0 : window.innerHeight - (viewport.top + viewport.height);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-3"
      style={{ bottom: `calc(${keyboardInset}px + var(--chat-bottom-h, env(safe-area-inset-bottom, 0px)) + 8px)` }}
    >
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-[560px] items-center gap-3 rounded-xl border border-border bg-popover py-1 pr-1 pl-4 text-popover-foreground"
      >
        <p className="min-w-0 flex-1 text-sm">Nova versão do Nanachi</p>
        <Button onClick={() => window.location.reload()}>
          <RefreshCw />
          Atualizar
        </Button>
      </div>
    </div>
  );
}
