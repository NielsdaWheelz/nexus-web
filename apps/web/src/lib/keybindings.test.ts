import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS, loadKeybindings } from "./keybindings";

function stubStoredKeybindings(value: string | null): void {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadKeybindings", () => {
  it("merges valid stored string bindings over defaults", () => {
    stubStoredKeybindings(
      JSON.stringify({
        "open-palette": "Ctrl+p",
      }),
    );

    expect(loadKeybindings()).toEqual({
      ...DEFAULT_KEYBINDINGS,
      "open-palette": "Ctrl+p",
    });
  });

  it("drops malformed and non-string stored bindings", () => {
    stubStoredKeybindings(
      JSON.stringify({
        "open-palette": 12,
        "pane-next": null,
        "pane-previous": "Alt+arrowleft",
      }),
    );

    expect(loadKeybindings()).toEqual({
      ...DEFAULT_KEYBINDINGS,
      "pane-previous": "Alt+arrowleft",
    });
  });

  it("falls back to defaults for invalid stored JSON", () => {
    stubStoredKeybindings("{");

    expect(loadKeybindings()).toEqual(DEFAULT_KEYBINDINGS);
  });
});
