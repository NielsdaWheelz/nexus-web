import { afterEach, describe, expect, it, vi } from "vitest";
import type { NexusOpenIntent } from "./model";
import {
  consumePendingNexusOpenIntents,
  consumeNexusUrlIntent,
  NEXUS_OPEN_REQUESTED_EVENT,
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
  it.each([
    ["nexus=1&intent=Root", { kind: "Root" }],
    [
      "nexus=1&intent=QuickAction&action=Nexus.Quick.Note",
      { kind: "QuickAction", actionId: "Nexus.Quick.Note" },
    ],
    [
      "nexus=1&intent=WebSearch&q=design%20systems",
      { kind: "UnsupportedLink" },
    ],
  ] as const)("parses the accepted URL contract %s", (query, expected) => {
    expect(parseNexusUrlIntent(new URLSearchParams(query))).toEqual(expected);
  });

  it.each([
    "nexus=1&intent=Root&q=x",
    "nexus=1&intent=QuickAction&action=Unknown",
    "nexus=1&nexus=1&intent=Root",
    "nexus=1&intent=Root&intent=WebSearch",
    "intent=Root",
  ])("rejects the ambiguous or incomplete URL contract %s", (query) => {
    expect(parseNexusUrlIntent(new URLSearchParams(query))).toBeNull();
  });

  it("removes only an accepted intent and preserves history state and unrelated URL data", () => {
    const state = { pane: "pane-a", revision: 7 };
    let replacement: { readonly state: unknown; readonly url: string } | null =
      null;
    vi.stubGlobal("window", {
      location: {
        search: "?keep=1&nexus=1&intent=WebSearch&q=design",
        pathname: "/libraries",
        hash: "#reader",
      },
      history: {
        state,
        replaceState(nextState: unknown, _title: string, url: string) {
          replacement = { state: nextState, url };
        },
      },
    });

    expect(consumeNexusUrlIntent()).toEqual({ kind: "UnsupportedLink" });
    expect(replacement).toEqual({
      state,
      url: "/libraries?keep=1#reader",
    });
  });
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
