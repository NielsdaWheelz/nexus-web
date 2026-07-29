import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeNexusUrlIntent,
  parseNexusUrlIntent,
} from "./events";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Nexus URL intent", () => {
  it("accepts only the exact Root, WebSearch, and registered QuickAction shapes", () => {
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
    ).toEqual({ kind: "WebSearch", query: "design systems" });
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
      "nexus=1&intent=WebSearch",
      "nexus=1&intent=WebSearch&q=%20",
      "nexus=1&intent=WebSearch&q=x&action=Nexus.Quick.Note",
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

    expect(consumeNexusUrlIntent()).toEqual({
      kind: "WebSearch",
      query: "design",
    });
    expect(replaceState).toHaveBeenCalledWith(
      state,
      "",
      "/libraries?keep=1#reader",
    );
  });
});
