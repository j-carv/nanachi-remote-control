const CACHE_BUST_PARAM = 'v';

/** Path to reload without the HTTP or service worker cache: the current path plus `?v=<now>`. */
export function cacheBustPath(pathname: string, now: number): string {
  return `${pathname}?${CACHE_BUST_PARAM}=${now}`;
}

/** The href without the `v` cache-bust parameter, or `null` when there is none. Other parameters and the hash stay. */
export function withoutCacheBust(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(CACHE_BUST_PARAM)) return null;
  url.searchParams.delete(CACHE_BUST_PARAM);
  return url.href;
}
