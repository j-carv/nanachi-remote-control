import { useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  /** Verdadeiro enquanto a carga atual não terminou (inclusive ao trocar deps). */
  loading: boolean;
  reload(): void;
}

interface Snapshot<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

/**
 * Carrega dados ao montar e quando `deps` mudam. Respostas atrasadas de uma carga
 * anterior são descartadas. `reload` força nova carga sem limpar os dados atuais.
 * Quem chama controla a lista de deps (`load` é recriado a cada render).
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<Snapshot<T>>({ data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setState((previous) => ({ ...previous, loading: true }));
    load().then(
      (data) => {
        if (active) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (active) setState({ data: null, error, loading: false });
      },
    );
    return () => {
      active = false;
    };
  }, [...deps, version]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: () => setVersion((value) => value + 1),
  };
}
