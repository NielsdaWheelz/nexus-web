import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS, loadStoredKeybindings } from "./keybindings";

function stubStoredKeybindings(value: string | null): void {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadStoredKeybindings", () => {
  it("includes pane-local Search in the canonical defaults", () => {
    expect(DEFAULT_KEYBINDINGS["Pane.Search"]).toBe("Meta+f");
  });

  it("merges valid stored string bindings over defaults", () => {
    stubStoredKeybindings(
      JSON.stringify({
        "Nexus.Open": "Ctrl+p",
      }),
    );

    expect(loadStoredKeybindings()).toEqual({
      ...DEFAULT_KEYBINDINGS,
      "Nexus.Open": "Ctrl+p",
    });
  });

  it("drops malformed and non-string stored bindings", () => {
    stubStoredKeybindings(
      JSON.stringify({
        "Nexus.Open": 12,
        "pane-next": null,
        "pane-previous": "Alt+arrowleft",
      }),
    );

    expect(loadStoredKeybindings()).toEqual({
      ...DEFAULT_KEYBINDINGS,
      "pane-previous": "Alt+arrowleft",
    });
  });

  it("falls back to defaults for invalid stored JSON", () => {
    stubStoredKeybindings("{");

    expect(loadStoredKeybindings()).toEqual(DEFAULT_KEYBINDINGS);
  });
});
