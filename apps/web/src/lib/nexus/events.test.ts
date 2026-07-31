import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingNexusOpenIntents,
  consumeNexusUrlIntent,
  parseNexusUrlIntent,
  requestNexusOpen,
  setNexusOpenReceiverReady,
} from "./events";

afterEach(() => {
  setNexusOpenReceiverReady(false);
  consumePendingNexusOpenIntents();
  vi.unstubAllGlobals();
});

describe("Nexus URL intent", () => {
  it("accepts Root and registered QuickAction shapes and retires WebSearch links", () => {
    expect(
      parseNexusUrlIntent(
        new URLSearchParams("nexus=1&intent=Root"),
      ),
    ).toEqual({ kind: "Root" });
    expect(
      parseNexusUrlIntent(
        new URLSearchParams(
          "nexus=1&intent=WebSearch&q=design%20systems",
        ),
      ),
    ).toEqual({ kind: "UnsupportedLink" });
    expect(
      parseNexusUrlIntent(
        new URLSearchParams(
          "nexus=1&intent=QuickAction&action=Nexus.Quick.Note",
        ),
      ),
    ).toEqual({
      kind: "QuickAction",
      actionId: "Nexus.Quick.Note",
    });
  });

  it("rejects missing, blank, duplicate, mixed, and unknown payloads", () => {
    const rejected = [
      "nexus=1&intent=Root&q=x",
      "nexus=1&intent=QuickAction&action=Unknown",
      "nexus=1&nexus=1&intent=Root",
      "nexus=1&intent=Root&intent=WebSearch",
      "intent=Root",
    ];
    expect(
      rejected.map((query) =>
        parseNexusUrlIntent(new URLSearchParams(query)),
      ),
    ).toEqual(rejected.map(() => null));
  });

  it("strips an accepted intent without replacing the current history state", () => {
    const state = { pane: "pane-a", revision: 7 };
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        search: "?keep=1&nexus=1&intent=WebSearch&q=design",
        pathname: "/libraries",
        hash: "#reader",
      },
      history: {
        state,
        replaceState,
      },
    });

    expect(consumeNexusUrlIntent()).toEqual({ kind: "UnsupportedLink" });
    expect(replaceState).toHaveBeenCalledWith(
      state,
      "",
      "/libraries?keep=1#reader",
    );
  });
});

describe("Nexus open ingress", () => {
  it("queues an intent until the controller receiver is ready", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const intent = {
      kind: "Add",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
      },
    } as const;

    requestNexusOpen(intent);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(consumePendingNexusOpenIntents()).toEqual([intent]);

    setNexusOpenReceiverReady(true);
    requestNexusOpen({ kind: "Root" });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
