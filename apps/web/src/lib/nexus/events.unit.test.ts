import { afterEach, describe, expect, it, vi } from "vitest";
import type { NexusOpenIntent } from "./model";
import {
  consumePendingNexusOpenIntents,
  NEXUS_OPEN_REQUESTED_EVENT,
  requestNexusOpen,
  setNexusOpenReceiverReady,
} from "./events";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Nexus open ingress", () => {
  it("drains queued intents once and resumes queuing after receiver teardown", () => {
    const nexusWindow = new EventTarget();
    const delivered: NexusOpenIntent[] = [];
    nexusWindow.addEventListener(NEXUS_OPEN_REQUESTED_EVENT, (event) => {
      delivered.push((event as CustomEvent<NexusOpenIntent>).detail);
    });
    vi.stubGlobal("window", nexusWindow);

    const queued = {
      kind: "Add",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
      },
    } as const;
    requestNexusOpen(queued);

    expect(consumePendingNexusOpenIntents()).toEqual([queued]);
    expect(consumePendingNexusOpenIntents()).toEqual([]);

    setNexusOpenReceiverReady(true);
    requestNexusOpen({ kind: "Root" });
    expect(delivered).toEqual([{ kind: "Root" }]);

    setNexusOpenReceiverReady(false);
    requestNexusOpen(queued);
    expect(delivered).toEqual([{ kind: "Root" }]);
    expect(consumePendingNexusOpenIntents()).toEqual([queued]);
  });
});
