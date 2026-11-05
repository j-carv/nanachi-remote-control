import { MonitorOff } from 'lucide-react';

/**
 * Shown when the page runs outside Nanachi Desktop (no `window.nanachiControl`): a browser tab, a double-clicked file.
 * It does not fall back to made-up data, because a control panel that pretends to work is worse than one that says it cannot.
 */
export function MissingBridge() {
  return (
    <main className="grid h-full place-items-center bg-background px-8">
      <div className="flex max-w-[420px] flex-col items-center text-center">
        <span className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
          <MonitorOff aria-hidden="true" />
        </span>
        <h1 className="font-display text-[22px] leading-7 font-semibold tracking-[-0.011em]">Abra pelo Nanachi Desktop</h1>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          Este é o painel de controle do Nanachi, e ele só funciona dentro do app para Windows. Abra o Nanachi pelo menu Iniciar ou pelo ícone na bandeja do sistema.
        </p>
      </div>
    </main>
  );
}
