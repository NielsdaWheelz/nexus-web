import { describe, expect, it } from "vitest";
import { createBrowseRequestGate } from "./requestGate";

describe("createBrowseRequestGate", () => {
  it("bounds every Browse request and admits queued work as slots settle", async () => {
    const gate = createBrowseRequestGate(3);
    let active = 0;
    let highWater = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const requests = Array.from({ length: 8 }, () =>
      gate.run(new AbortController().signal, async () => {
        active += 1;
        highWater = Math.max(highWater, active);
        await barrier;
        active -= 1;
      }),
    );

    await Promise.resolve();
    expect(active).toBe(3);
    release?.();
    await Promise.all(requests);
    expect(active).toBe(0);
    expect(highWater).toBe(3);
  });

  it("removes an aborted queued request without spending a slot", async () => {
    const gate = createBrowseRequestGate(1);
    let releaseFirst: (() => void) | undefined;
    const first = gate.run(new AbortController().signal, () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const queuedController = new AbortController();
    let queuedStarted = false;
    const queued = gate.run(queuedController.signal, async () => {
      queuedStarted = true;
    });

    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst?.();
    await first;
    expect(queuedStarted).toBe(false);
  });
});
