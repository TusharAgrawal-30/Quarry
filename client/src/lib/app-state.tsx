import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Actor, Meta } from './api';
import { api } from './api';

// Global app state: server metadata (products, actors, vocab), the current
// actor identity (persisted locally), and a toast bus.

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  title?: string;
  message: string;
}

interface AppState {
  meta: Meta | null;
  metaError: string | null;
  reloadMeta: () => void;
  actor: Actor | null;
  setActorId: (id: number) => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppState | null>(null);

let toastSeq = 1;

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [actorId, setActorIdRaw] = useState<number>(() => Number(localStorage.getItem('quarry.actor') ?? 0));
  const [toasts, setToasts] = useState<Toast[]>([]);

  const reloadMeta = useCallback(() => {
    setMetaError(null);
    api
      .meta()
      .then(setMeta)
      .catch((e) => setMetaError(e.message));
  }, []);

  useEffect(reloadMeta, [reloadMeta]);

  const actor = useMemo(() => {
    if (!meta) return null;
    return meta.actors.find((a) => a.id === actorId && a.active) ?? meta.actors.find((a) => a.active) ?? meta.actors[0] ?? null;
  }, [meta, actorId]);

  const setActorId = useCallback((id: number) => {
    localStorage.setItem('quarry.actor', String(id));
    setActorIdRaw(id);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = toastSeq++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismissToast(id), t.kind === 'error' ? 7000 : 4200);
    },
    [dismissToast],
  );

  const value = useMemo(
    () => ({ meta, metaError, reloadMeta, actor, setActorId, toasts, toast, dismissToast }),
    [meta, metaError, reloadMeta, actor, setActorId, toasts, toast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
