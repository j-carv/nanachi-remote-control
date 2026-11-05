import { useEffect, type RefObject } from 'react';

/**
 * Keeps the custom property `name` on :root equal to the element's height in px, so other fixed elements can sit
 * just above it. Removed on unmount, so a screen without the element leaves no stale value behind.
 */
export function useCssHeight(ref: RefObject<HTMLElement | null>, name: string): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty(name, `${element.getBoundingClientRect().height}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') {
      return () => root.style.removeProperty(name);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name]);
}
