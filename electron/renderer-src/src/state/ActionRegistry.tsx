import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ActionRegistry, type ActionId } from './action-registry';

const RegistryContext = createContext<ActionRegistry | null>(null);

export function ActionRegistryProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(() => new ActionRegistry(), []);
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useActionRegistry(): ActionRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error('useActionRegistry doit être utilisé à l’intérieur de ActionRegistryProvider');
  return registry;
}

// A component that owns something the command palette can trigger declares it here. The handler is read
// through a ref, so it is always the latest one without re-registering on every render.
export function useRegisterAction(id: ActionId, handler: () => void): void {
  const registry = useActionRegistry();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => registry.register(id, () => latest.current()), [registry, id]);
}
