import { createContext, useContext, type ReactNode } from 'react';
import type { ControlApi } from '../../common/control-api.js';

const ApiContext = createContext<ControlApi | null>(null);

/** Gives the whole tree the one `ControlApi` (`window.nanachiControl`, or the mock in a mock build and in tests). */
export function ApiProvider({ api, children }: { api: ControlApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ControlApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi outside ApiProvider');
  return api;
}
