import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateTargetAnchor,
  activateTargetLink,
  type TargetLinkActivationRuntime,
} from "./targetLinkActivation";
import { clearMediaReaderViewTransition } from "@/lib/ui/viewTransitions";

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
    detail: 1,
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    ...overrides,
  } as ReactMouseEvent;
}

function runtime(): TargetLinkActivationRuntime {
  return { activateTarget: vi.fn() };
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

describe("targetLinkActivation", () => {
  it("dispatches a plain supported anchor as Follow", () => {
    const event = click();
    const activation = runtime();
    const element = anchor("/authors/ursula-le-guin", {
      "data-pane-label-hint": "Ursula K. Le Guin",
    });

    expect(activateTargetAnchor({ event, runtime: activation, anchor: element })).toBe(
      "handled",
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(activation.activateTarget).toHaveBeenCalledWith({
      target: { href: "/authors/ursula-le-guin", labelHint: "Ursula K. Le Guin" },
      disposition: { kind: "Follow" },
    });
  });

  it("dispatches Shift-click as Fork", () => {
    const event = click({ shiftKey: true });
    const activation = runtime();

    activateTargetLink({
      event,
      runtime: activation,
      href: "/lectern",
      labelHint: "Lectern",
    });

    expect(activation.activateTarget).toHaveBeenCalledWith({
      target: { href: "/lectern", labelHint: "Lectern" },
      disposition: { kind: "Fork" },
    });
  });

  it("keeps Shift+keyboard activation as Follow", () => {
    const event = click({ detail: 0, shiftKey: true });
    const activation = runtime();

    activateTargetLink({ event, runtime: activation, href: "/lectern" });

    expect(activation.activateTarget).toHaveBeenCalledWith({
      target: { href: "/lectern" },
      disposition: { kind: "Follow" },
    });
  });

  it("preserves an eligible media-reader view transition for Follow", () => {
    const startViewTransition = installStartViewTransition();
    installMatchMedia(false);
    const event = click();
    const activation = runtime();
    const element = anchor("/media/11111111-1111-4111-8111-111111111111", {
      "data-view-transition": "media-reader",
    });
    element.innerHTML = `
      <span data-view-transition-part="thumb"></span>
      <span data-view-transition-part="title">Document</span>
    `;

    activateTargetAnchor({ event, runtime: activation, anchor: element });

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(
      (element.querySelector('[data-view-transition-part="thumb"]') as HTMLElement)
        .style.viewTransitionName,
    ).toContain("nexus-media-reader-thumb");
  });

  it("delivers rich-link secondary activation without changing its disposition", () => {
    const event = click();
    const activation = runtime();
    const element = anchor("/conversations/22222222-2222-4222-8222-222222222222", {
      "data-pane-secondary-surface": "resource-dossier",
      "data-pane-secondary-activation": "DossierCurrent",
    });

    activateTargetAnchor({ event, runtime: activation, anchor: element });

    expect(activation.activateTarget).toHaveBeenCalledWith({
      target: {
        href: "/conversations/22222222-2222-4222-8222-222222222222",
        secondaryActivation: { kind: "DossierCurrent", surfaceId: "resource-dossier" },
      },
      disposition: { kind: "Follow" },
    });
  });

  it("leaves marked rich links for their bubble owner", () => {
    const event = click();
    const activation = runtime();
    const element = anchor("/lectern", { "data-workspace-rich-target": "true" });

    expect(activateTargetAnchor({ event, runtime: activation, anchor: element })).toBe(
      "unhandled",
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(activation.activateTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["already prevented", { defaultPrevented: true }],
    ["middle click", { button: 1 }],
    ["meta click", { metaKey: true }],
    ["control click", { ctrlKey: true }],
    ["alt click", { altKey: true }],
  ])("leaves %s browser-owned", (_label, overrides) => {
    const event = click(overrides);
    const activation = runtime();

    expect(
      activateTargetLink({ event, runtime: activation, href: "/lectern" }),
    ).toBe("unhandled");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(activation.activateTarget).not.toHaveBeenCalled();
  });

  it.each([
    anchor("https://example.com/report"),
    anchor("/api/podcasts/export/opml"),
    anchor("/lectern", { target: "_blank" }),
    anchor("/lectern", { download: "" }),
  ])("leaves external and browser-directed anchors alone", (element) => {
    const event = click();
    const activation = runtime();

    expect(activateTargetAnchor({ event, runtime: activation, anchor: element })).toBe(
      "unhandled",
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(activation.activateTarget).not.toHaveBeenCalled();
  });
});
