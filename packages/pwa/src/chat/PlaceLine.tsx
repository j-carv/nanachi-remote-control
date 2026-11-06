import { useLayoutEffect, useRef, useState } from 'react';
import { truncateMiddle } from '../truncateMiddle.js';

/** Room kept free on the right of the measured text, for rounding between canvas and layout. */
const SAFETY_PX = 2;

/** One canvas context for every measure. Null where the browser has no canvas. */
let measuringContext: CanvasRenderingContext2D | null | undefined;

function measuring(): CanvasRenderingContext2D | null {
  if (measuringContext === undefined) measuringContext = document.createElement('canvas').getContext('2d');
  return measuringContext;
}

interface PlaceLineProps {
  text: string;
}

/**
 * The session's place (workspace, branch, machine) on one line. When it is too long for the row it is cut in the
 * middle, so the start and the end both stay readable. The cut is measured with the element's own font and width, and
 * redone when the width changes. The full text stays in the accessible name and in the tooltip.
 */
export function PlaceLine({ text }: PlaceLineProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const fit = () => {
      const context = measuring();
      const width = element.clientWidth - SAFETY_PX;
      // Without a measure (no canvas, or the row is hidden) the full text stays and the CSS cut at the end applies.
      if (context === null || width <= 0) {
        setShown(text);
        return;
      }
      const style = getComputedStyle(element);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      setShown(truncateMiddle(text, (candidate) => context.measureText(candidate).width <= width));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <p data-slot="session-place" className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground">
      <span ref={ref} aria-hidden="true" title={text} className="block truncate">
        {shown}
      </span>
      <span className="sr-only">{text}</span>
    </p>
  );
}
