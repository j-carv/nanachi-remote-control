import { useEffect, useState } from 'react';

/**
 * Current time for the loop countdown. Ticks once a second, only while the app is visible (the interval stops in the
 * background and resumes with the right time when the app comes back). `enabled` false: no timer is created.
 */
export function useLoopClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const tick = () => setNow(Date.now());
    const start = () => {
      if (timer !== undefined) return;
      tick();
      timer = window.setInterval(tick, 1000);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [enabled]);

  return now;
}
