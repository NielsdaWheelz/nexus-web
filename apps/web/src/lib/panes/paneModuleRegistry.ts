type ModuleLoader<Module> = () => Promise<Module>;

export type PaneModuleRegistry<Id extends string, Module> = {
  load: (id: Id) => Promise<Module>;
  peek: (id: Id) => Module | null;
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
  const loadedModules = new Map<Id, Module>();

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
    void promise.then(
      (module) => {
        if (modulePromises.get(id) === promise) {
          loadedModules.set(id, module);
        }
      },
      () => {
        if (modulePromises.get(id) === promise) {
          modulePromises.delete(id);
          loadedModules.delete(id);
        }
      },
    );
    return promise;
  };

  return {
    load,
    peek: (id) =>
      loadedModules.has(id) ? (loadedModules.get(id) as Module) : null,
    preload: (id) => load(id).then(() => undefined),
  };
}
