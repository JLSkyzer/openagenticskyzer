export type ActionId = 'open-folder' | 'switch-model' | 'open-prompts';

// Things the command palette can trigger but that other components own (the folder dialog lives in the
// sidebar, the model selector in the input bar…): each declares its handler here, so no state has to be lifted
// up to the root just to be reachable.
export class ActionRegistry {
  private handlers = new Map<string, { run: () => void }>();

  // The latest registration wins. The returned function only removes ITS OWN registration: a component that
  // re-registers before the previous cleanup runs must not lose its handler to that cleanup.
  register(id: string, handler: () => void): () => void {
    const entry = { run: handler };
    this.handlers.set(id, entry);
    return () => {
      if (this.handlers.get(id) === entry) this.handlers.delete(id);
    };
  }

  // false when nobody registered the action, so the caller can say so instead of doing nothing silently.
  // An error thrown by the handler is the caller's to handle.
  run(id: string): boolean {
    const entry = this.handlers.get(id);
    if (!entry) return false;
    entry.run();
    return true;
  }
}
