import { describe, expect, it } from "vitest";
import { buildItemActions } from "./paletteActions";
import type { PaletteItem } from "./paletteModel";
import type { PaletteContext } from "./paletteProviders";
import { FileText } from "lucide-react";

// ---------------------------------------------------------------------------
// Minimal factories
// ---------------------------------------------------------------------------

function item(overrides: Partial<PaletteItem>): PaletteItem {
  return {
    id: "test-item",
    title: "Test Item",
    keywords: [],
    sectionId: "navigate",
    icon: FileText,
    target: { kind: "href", href: "/test", externalShell: false },
    source: "static",
    rank: {},
    ...overrides,
  };
}

function ctx(opts: { canOpenConversation: boolean }): PaletteContext {
  return {
    intent: { lane: "all", term: "", raw: "" },
    panes: [],
    activePaneId: "",
    currentHref: null,
    historyRows: [],
    frecencyBoosts: new Map(),
    oracleRows: [],
    searchResults: [],
    keybindings: {},
    androidShell: false,
    canOpenConversation: opts.canOpenConversation,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildItemActions", () => {
  describe("(a) pane item (target.actionId starts with pane-open:)", () => {
    const paneItem = item({ target: { kind: "action", actionId: "pane-open:p1" } });

    it("returns exactly [Switch to tab, Close tab, Ask AI about this] in order", () => {
      const actions = buildItemActions(paneItem, ctx({ canOpenConversation: true }));
      expect(actions.map((a) => a.label)).toEqual([
        "Switch to tab",
        "Close tab",
        "Ask AI about this",
      ]);
    });

    it("first action is the default (Switch to tab)", () => {
      const actions = buildItemActions(paneItem, ctx({ canOpenConversation: true }));
      expect(actions[0].label).toBe("Switch to tab");
    });

    it("run shapes are pane-activate, pane-close, ask", () => {
      const actions = buildItemActions(paneItem, ctx({ canOpenConversation: true }));
      expect(actions[0].run).toEqual({ kind: "pane-activate", paneId: "p1" });
      expect(actions[1].run).toEqual({ kind: "pane-close", paneId: "p1" });
      expect(actions[2].run).toMatchObject({ kind: "ask" });
    });
  });

  describe("(b) content href item (externalShell:false)", () => {
    const hrefItem = item({
      title: "My Page",
      target: { kind: "href", href: "/x", externalShell: false },
    });

    it("returns [Open, Ask AI about this, Copy link] in order", () => {
      const actions = buildItemActions(hrefItem, ctx({ canOpenConversation: true }));
      expect(actions.map((a) => a.label)).toEqual(["Open", "Ask AI about this", "Copy link"]);
    });

    it("first action is Open", () => {
      const actions = buildItemActions(hrefItem, ctx({ canOpenConversation: true }));
      expect(actions[0].label).toBe("Open");
    });

    it("run shapes are open, ask with item title, copy-link", () => {
      const actions = buildItemActions(hrefItem, ctx({ canOpenConversation: true }));
      expect(actions[0].run).toEqual({ kind: "open", href: "/x", externalShell: false });
      expect(actions[1].run).toEqual({ kind: "ask", text: "My Page" });
      expect(actions[2].run).toEqual({ kind: "copy-link", href: "/x" });
    });
  });

  describe("(c) externalShell href item", () => {
    it("Open action run.externalShell is true", () => {
      const extItem = item({ target: { kind: "href", href: "/ext", externalShell: true } });
      const actions = buildItemActions(extItem, ctx({ canOpenConversation: true }));
      const open = actions.find((a) => a.id === "open");
      expect(open?.run).toMatchObject({ kind: "open", externalShell: true });
    });
  });

  describe("(d) static/action item that is NOT pane-open", () => {
    it("returns [] for actionId new-conversation", () => {
      const staticItem = item({ target: { kind: "action", actionId: "new-conversation" } });
      const actions = buildItemActions(staticItem, ctx({ canOpenConversation: true }));
      expect(actions).toEqual([]);
    });
  });

  describe("(e) canOpenConversation:false omits Ask AI about this", () => {
    it("pane item has no Ask AI action", () => {
      const paneItem = item({ target: { kind: "action", actionId: "pane-open:p1" } });
      const actions = buildItemActions(paneItem, ctx({ canOpenConversation: false }));
      expect(actions.map((a) => a.label)).toEqual(["Switch to tab", "Close tab"]);
    });

    it("href item has no Ask AI action", () => {
      const hrefItem = item({ target: { kind: "href", href: "/x", externalShell: false } });
      const actions = buildItemActions(hrefItem, ctx({ canOpenConversation: false }));
      expect(actions.map((a) => a.label)).toEqual(["Open", "Copy link"]);
    });
  });
});
