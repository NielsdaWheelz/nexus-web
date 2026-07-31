import { lazy, Suspense, type ComponentType } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

type TestPaneId = "media";
type TestPaneModule = { default: ComponentType };

describe("createPaneModuleRegistry", () => {
  it("gives an intent preload and a concurrently mounted lazy body one module promise", async () => {
    const paneModule = deferred<TestPaneModule>();
    const loader = vi.fn(() => paneModule.promise);
    const registry = createPaneModuleRegistry<TestPaneId, TestPaneModule>({
      media: loader,
    });

    const preload = registry.preload("media");
    const LazyBody = lazy(() => registry.load("media"));
    render(
      <Suspense fallback={<div>Loading pane…</div>}>
        <LazyBody />
      </Suspense>,
    );

    expect(screen.getByText("Loading pane…")).toBeVisible();
    expect(loader).toHaveBeenCalledTimes(1);

    await act(async () => {
      paneModule.resolve({ default: () => <div>Reader ready</div> });
      await preload;
    });

    expect(await screen.findByText("Reader ready")).toBeVisible();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected module promise so the next load retries", async () => {
    const failedModule = deferred<TestPaneModule>();
    const recoveredModule = { default: () => <div>Recovered</div> };
    const loader = vi
      .fn<() => Promise<TestPaneModule>>()
      .mockReturnValueOnce(failedModule.promise)
      .mockResolvedValueOnce(recoveredModule);
    const registry = createPaneModuleRegistry<TestPaneId, TestPaneModule>({
      media: loader,
    });

    const firstLoad = registry.load("media");
    failedModule.reject(new Error("chunk unavailable"));

    await expect(firstLoad).rejects.toThrow("chunk unavailable");
    await expect(registry.load("media")).resolves.toBe(recoveredModule);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
