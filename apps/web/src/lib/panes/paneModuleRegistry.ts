type ModuleLoader<Module> = () => Promise<Module>;

export type PaneModuleRegistry<Id extends string, Module> = {
  load: (id: Id) => Promise<Module>;
  preload: (id: Id) => Promise<void>;
};

/**
 * Owns one in-flight/resolved module promise per pane. Intent preloads and
 * React.lazy must adopt the exact same promise; relying on a bundler to dedupe
 * separate import() calls leaves Suspense ownership runtime-dependent.
 *
 * A rejected promise is evicted after, and only after, that exact attempt
 * settles so a later navigation can retry without an older failure deleting a
 * newer attempt.
 */
export function createPaneModuleRegistry<Id extends string, Module>(
  loaders: Record<Id, ModuleLoader<Module>>,
): PaneModuleRegistry<Id, Module> {
  const modulePromises = new Map<Id, Promise<Module>>();

  const load = (id: Id): Promise<Module> => {
    const existing = modulePromises.get(id);
    if (existing) return existing;

    let promise: Promise<Module>;
    try {
      promise = loaders[id]();
    } catch (error) {
      promise = Promise.reject(error);
    }
    modulePromises.set(id, promise);
    void promise.catch(() => {
      if (modulePromises.get(id) === promise) {
        modulePromises.delete(id);
      }
    });
    return promise;
  };

  return {
    load,
    preload: (id) => load(id).then(() => undefined),
  };
}
