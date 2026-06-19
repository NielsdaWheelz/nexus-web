import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePaneInternalAnchorClick,
  handlePaneInternalHrefClick,
} from "@/lib/panes/paneLinkNavigation";
import { clearMediaReaderViewTransition } from "@/lib/ui/viewTransitions";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const ORIGINAL_START_VIEW_TRANSITION = (
  document as Document & { startViewTransition?: unknown }
).startViewTransition;
const ORIGINAL_MATCH_MEDIA = window.matchMedia;

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
    router: {
      canGoBack: false,
      canGoForward: false,
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
    },
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

function installStartViewTransition() {
  const startViewTransition = vi.fn((callback: () => void | Promise<void>) => {
    const done = Promise.resolve().then(callback).then(() => undefined);
    return {
      ready: done,
      updateCallbackDone: done,
      finished: done,
      skipTransition: vi.fn(),
    };
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  return startViewTransition;
}

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  clearMediaReaderViewTransition();
  if (ORIGINAL_START_VIEW_TRANSITION === undefined) {
    Reflect.deleteProperty(document, "startViewTransition");
  } else {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: ORIGINAL_START_VIEW_TRANSITION,
    });
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
});

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

  it("uses menuitem text as the pane title hint when no explicit hint exists", () => {
    const event = click();
    const paneRuntime = runtime();
    const element = anchor("/settings/reader", { role: "menuitem" });
    element.textContent = "Reader settings";

    handlePaneInternalAnchorClick(event, paneRuntime, element);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(paneRuntime.router.push).toHaveBeenCalledWith(
      "/settings/reader",
      { titleHint: "Reader settings" },
    );
  });

  it("adds media-reader transition intent only for eligible media anchors", () => {
    installStartViewTransition();
    installMatchMedia(false);
    const event = click();
    const paneRuntime = runtime();
    const element = anchor(`/media/${MEDIA_ID}`, {
      "data-view-transition": "media-reader",
    });
    element.innerHTML = `
      <span data-view-transition-part="thumb"></span>
      <span data-view-transition-part="title">Document</span>
    `;

    handlePaneInternalAnchorClick(event, paneRuntime, element);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(paneRuntime.router.push).toHaveBeenCalledWith(`/media/${MEDIA_ID}`, {
      viewTransition: { kind: "media-reader", mediaId: MEDIA_ID },
    });
    expect(
      (element.querySelector('[data-view-transition-part="thumb"]') as HTMLElement)
        .style.viewTransitionName,
    ).toContain("nexus-media-reader-thumb");
  });

  it("skips media-reader transition intent when reduced motion is requested", () => {
    installStartViewTransition();
    installMatchMedia(true);
    const event = click();
    const paneRuntime = runtime();
    const element = anchor(`/media/${MEDIA_ID}`, {
      "data-view-transition": "media-reader",
    });
    element.innerHTML = `
      <span data-view-transition-part="thumb"></span>
      <span data-view-transition-part="title">Document</span>
    `;

    handlePaneInternalAnchorClick(event, paneRuntime, element);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(paneRuntime.router.push).toHaveBeenCalledWith(`/media/${MEDIA_ID}`, undefined);
    expect(
      (element.querySelector('[data-view-transition-part="thumb"]') as HTMLElement)
        .style.viewTransitionName,
    ).toBe("");
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
