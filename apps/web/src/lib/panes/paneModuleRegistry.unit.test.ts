import { describe, expect, it } from "vitest";
import { createPaneModuleRegistry } from "./paneModuleRegistry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type TestPaneModule = { default: string };

describe("pane module registry", () => {
  it("shares the preload import promise with the lazy consumer", async () => {
    const paneModule = deferred<TestPaneModule>();
    let importCount = 0;
    const registry = createPaneModuleRegistry<"media", TestPaneModule>({
      media: () => {
        importCount += 1;
        return paneModule.promise;
      },
    });

    const preload = registry.preload("media");
    const lazyLoad = registry.load("media");

    expect(lazyLoad).toBe(paneModule.promise);
    expect(importCount).toBe(1);

    const loadedModule = { default: "Reader" };
    paneModule.resolve(loadedModule);
    await expect(lazyLoad).resolves.toBe(loadedModule);
    await expect(preload).resolves.toBeUndefined();
  });

  it("evicts a rejected import so a later lazy load retries", async () => {
    const failedImport = deferred<TestPaneModule>();
    const recoveredModule = { default: "Recovered reader" };
    const attempts = [failedImport.promise, Promise.resolve(recoveredModule)];
    let importCount = 0;
    const registry = createPaneModuleRegistry<"media", TestPaneModule>({
      media: () => attempts[importCount++]!,
    });

    const firstLoad = registry.load("media");
    failedImport.reject(new Error("chunk unavailable"));

    await expect(firstLoad).rejects.toThrow("chunk unavailable");
    await expect(registry.load("media")).resolves.toBe(recoveredModule);
    expect(importCount).toBe(2);
  });
});
