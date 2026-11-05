/** Start delay of each dot, so the three breathe in turn. */
const DOT_DELAYS = ['0ms', '180ms', '360ms'] as const;

/**
 * The agent is working: three dots that breathe in turn. It replaces the spinner, which reads as "loading" rather than
 * "working". The dots are a state, so they stop under reduced motion and stay as a still row. Colour is the running
 * tone, one of the four status colours (docs/DESIGN.md). `pulse-soft` draws its ring in `currentColor`, hence the
 * text colour on each dot.
 */
export function RunningDots() {
  return (
    <span data-slot="running-dots" aria-hidden="true" className="flex h-4 w-6 shrink-0 items-center justify-center gap-[3px]">
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className="size-1.5 rounded-full bg-running text-running animate-pulse-soft motion-reduce:animate-none"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  );
}
