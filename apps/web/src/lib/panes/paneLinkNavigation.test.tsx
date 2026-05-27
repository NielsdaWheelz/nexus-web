import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  handlePaneInternalAnchorClick,
  handlePaneInternalHrefClick,
} from "@/lib/panes/paneLinkNavigation";

function click(overrides: Partial<ReactMouseEvent> = {}) {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    ...overrides,
  } as ReactMouseEvent;
}

function runtime() {
  return {
    router: { push: vi.fn(), replace: vi.fn() },
    openInNewPane: vi.fn(),
  };
}

function anchor(href: string, attributes: Record<string, string> = {}) {
  const element = document.createElement("a");
  element.setAttribute("href", href);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

describe("paneLinkNavigation", () => {
  it("routes supported primary anchor clicks through the current pane", () => {
    const event = click();
    const paneRuntime = runtime();
    const element = anchor("/authors/ursula-le-guin", {
      "data-pane-title-hint": "Ursula K. Le Guin",
    });

    handlePaneInternalAnchorClick(event, paneRuntime, element);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(paneRuntime.router.push).toHaveBeenCalledWith(
      "/authors/ursula-le-guin",
      { titleHint: "Ursula K. Le Guin" },
    );
    expect(paneRuntime.openInNewPane).not.toHaveBeenCalled();
  });

  it("opens supported Shift-clicks in a sibling pane", () => {
    const event = click({ shiftKey: true });
    const paneRuntime = runtime();

    handlePaneInternalHrefClick(
      event,
      paneRuntime,
      "/authors/ursula-le-guin",
      "Ursula K. Le Guin"
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(paneRuntime.openInNewPane).toHaveBeenCalledWith(
      "/authors/ursula-le-guin",
      "Ursula K. Le Guin",
    );
    expect(paneRuntime.router.push).not.toHaveBeenCalled();
  });

  it("leaves native and unsupported anchor clicks alone", () => {
    const cases = [
      anchor("/authors/ursula-le-guin", { "aria-disabled": "true" }),
      anchor("/authors/ursula-le-guin", { target: "_blank" }),
      anchor("/authors/ursula-le-guin", { download: "" }),
      anchor("#chapter-1"),
      anchor("https://example.com/report"),
      anchor("/api/podcasts/export/opml"),
    ];

    for (const element of cases) {
      const event = click();
      const paneRuntime = runtime();
      handlePaneInternalAnchorClick(event, paneRuntime, element);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(paneRuntime.router.push).not.toHaveBeenCalled();
      expect(paneRuntime.openInNewPane).not.toHaveBeenCalled();
    }
  });

  it("leaves native browser click gestures alone", () => {
    const cases: Partial<ReactMouseEvent>[] = [
      { defaultPrevented: true },
      { button: 1 },
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ];

    for (const overrides of cases) {
      const event = click(overrides);
      const paneRuntime = runtime();
      handlePaneInternalHrefClick(event, paneRuntime, "/authors/ursula-le-guin");
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(paneRuntime.router.push).not.toHaveBeenCalled();
      expect(paneRuntime.openInNewPane).not.toHaveBeenCalled();
    }
  });
});
