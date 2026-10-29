/**
 * Minimal snapshot store (the plugin's own, dependency-free).
 *
 * The components read through `React.useSyncExternalStore`, so the contract is
 * exactly getSnapshot/subscribe. Deliberately not `@deepseek-ai/dsh-client-store`:
 * the plugin needs three tiny stores, and keeping the bundle's only externals
 * at react/zod removes one version-coupled import from the client half.
 */

/** One snapshot subscriber. */
type Listener = () => void;

/** The store face the client components read (React's external-store contract). */
export interface ClientStore<T> {
  /** Current snapshot (identity-stable until the next change). */
  getSnapshot(): T;
  /** Subscribe one listener; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void;
  /** Replace the snapshot and notify listeners when the value changed. */
  set(next: T): void;
  /** Project the current snapshot; a different result is stored and notified. */
  update(project: (current: T) => T): void;
}

/**
 * Create one store.
 * @param initial - initial snapshot.
 * @returns the store.
 */
export function createClientStore<T>(initial: T): ClientStore<T> {
  let snapshot = initial;
  const listeners = new Set<Listener>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[dsh-prompt-library] store listener failed:', error);
      }
    }
  };
  const set = (next: T): void => {
    if (next === snapshot) return;
    snapshot = next;
    notify();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set,
    update(project: (current: T) => T) {
      const next = project(snapshot);
      if (next !== snapshot) set(next);
    }
  };
}
