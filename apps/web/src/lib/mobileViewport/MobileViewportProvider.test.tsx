import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import {
  MobileViewportProvider,
  useMobileViewport,
  useRootTextEntryFocused,
  type MobileViewportCapability,
} from "@/lib/mobileViewport/MobileViewportProvider";

let capability: MobileViewportCapability | null = null;
let rootTextEntryFocused = false;
const rootLengthProbes = new Map<string, HTMLDivElement>();

function CapabilityProbe() {
  capability = useMobileViewport();
  return null;
}

function TextEntryFocusProbe() {
  rootTextEntryFocused = useRootTextEntryFocused();
  return null;
}

function RegisteredPlayer() {
  const ref = useRef<HTMLDivElement>(null);
  const mobileViewport = useMobileViewport();
  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }
    return mobileViewport.registerFixedObstruction("Player", ref.current);
  }, [mobileViewport]);
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        inset: "auto 0 0",
        width: "100px",
        height: "80px",
      }}
    />
  );
}

function readRootLength(property: string): number {
  let probe = rootLengthProbes.get(property);
  if (!probe) {
    probe = document.createElement("div");
    probe.style.height = `var(${property})`;
    document.body.append(probe);
    rootLengthProbes.set(property, probe);
  }
  return Number.parseFloat(getComputedStyle(probe).height);
}

describe("MobileViewportProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capability = null;
    rootTextEntryFocused = false;
    document.documentElement.style.removeProperty(
      "--mobile-content-bottom-clearance",
    );
    document.documentElement.style.removeProperty(
      "--mobile-nexus-bottom-offset",
    );
    document.documentElement.style.removeProperty(
      "--mobile-overlay-keyboard-inset",
    );
    document.documentElement.style.removeProperty(
      "--mobile-reader-paint-bottom-inset",
    );
    document.documentElement.style.removeProperty("--viewport-safe-bottom");
    for (const probe of rootLengthProbes.values()) {
      probe.remove();
    }
    rootLengthProbes.clear();
  });

  it("composes the canonical safe bottom and reveals the root defaults on teardown", () => {
    document.documentElement.style.setProperty("--viewport-safe-bottom", "37px");

    const { unmount } = render(
      <MobileViewportProvider>
        <CapabilityProbe />
      </MobileViewportProvider>,
    );

    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(37);
    expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(37);
    expect(readRootLength("--mobile-reader-paint-bottom-inset")).toBe(37);

    unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-content-bottom-clearance",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-nexus-bottom-offset",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-reader-paint-bottom-inset",
      ),
    ).toBe("");
    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(37);
    expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(37);
    expect(readRootLength("--mobile-reader-paint-bottom-inset")).toBe(37);
  });

  it("composes measured Player clearance with a larger canonical safe bottom", async () => {
    document.documentElement.style.setProperty("--viewport-safe-bottom", "23px");
    const { unmount } = render(
      <MobileViewportProvider>
        <RegisteredPlayer />
      </MobileViewportProvider>,
    );

    await waitFor(() => {
      expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(80);
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(80);
      expect(readRootLength("--mobile-reader-paint-bottom-inset")).toBe(0);
    });

    document.documentElement.style.setProperty("--viewport-safe-bottom", "93px");
    expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(93);
    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(93);
    expect(readRootLength("--mobile-reader-paint-bottom-inset")).toBe(13);

    unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-content-bottom-clearance",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-reader-paint-bottom-inset",
      ),
    ).toBe("");
  });

  it("defects on a duplicate active named registration and unregisters synchronously", () => {
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
        <TextEntryFocusProbe />
      </MobileViewportProvider>,
    );
    const element = document.createElement("div");
    document.body.append(element);
    let unregister: (() => void) | null = null;
    act(() => {
      unregister = capability!.registerFixedObstruction("Nexus", element);
    });
    expect(() =>
      capability!.registerFixedObstruction("Nexus", element),
    ).toThrow("Duplicate active mobile fixed obstruction: Nexus");
    act(() => unregister!());
    expect(() => {
      const release = capability!.registerFixedObstruction("Nexus", element);
      release();
    }).not.toThrow();
    element.remove();
  });

  it("publishes the named Nexus and Player union and shrinks it on unregister", async () => {
    document.documentElement.style.setProperty("--viewport-safe-bottom", "23px");
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
      </MobileViewportProvider>,
    );
    const player = document.createElement("div");
    player.style.cssText =
      "position: fixed; right: 0; bottom: 0; width: 100px; height: 80px";
    const nexus = document.createElement("div");
    nexus.style.cssText =
      "position: fixed; right: 0; bottom: 100px; width: 56px; height: 50px";
    document.body.append(player, nexus);

    let unregisterPlayer: (() => void) | null = null;
    let unregisterNexus: (() => void) | null = null;
    act(() => {
      unregisterPlayer = capability!.registerFixedObstruction("Player", player);
      unregisterNexus = capability!.registerFixedObstruction("Nexus", nexus);
    });

    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(150);
      expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(80);
    });

    act(() => unregisterNexus!());
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(80);
    });

    act(() => unregisterPlayer!());
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(23);
      expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(23);
    });
    player.remove();
    nexus.remove();
  });

  it("publishes and clears the mobile overlay keyboard channel", () => {
    document.documentElement.style.setProperty("--viewport-safe-bottom", "37px");
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
      </MobileViewportProvider>,
    );

    let release: (() => void) | null = null;
    act(() => {
      release = capability!.reportMobileOverlayKeyboardInset(312);
    });
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("312px");
    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(312);

    act(() => release!());
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("0px");
    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(37);
  });

  it("notifies bottom-clearance subscribers after publication until released", () => {
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
      </MobileViewportProvider>,
    );
    const publishedClearances: number[] = [];
    const unsubscribe = capability!.subscribeContentBottomClearance(() => {
      publishedClearances.push(
        readRootLength("--mobile-content-bottom-clearance"),
      );
    });

    let release: (() => void) | null = null;
    act(() => {
      release = capability!.reportMobileOverlayKeyboardInset(312);
    });
    expect(publishedClearances).toEqual([312]);

    unsubscribe();
    act(() => release!());
    expect(publishedClearances).toEqual([312]);
  });

  it("restores the preceding active keyboard report when the newest report releases", () => {
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
      </MobileViewportProvider>,
    );

    let releaseOuter: (() => void) | null = null;
    let releaseMiddle: (() => void) | null = null;
    let releaseInner: (() => void) | null = null;
    act(() => {
      releaseOuter = capability!.reportMobileOverlayKeyboardInset(184);
      releaseMiddle = capability!.reportMobileOverlayKeyboardInset(248);
      releaseInner = capability!.reportMobileOverlayKeyboardInset(312);
    });
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("312px");

    act(() => releaseMiddle!());
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("312px");

    act(() => releaseInner!());
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("184px");

    act(() => releaseOuter!());
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("0px");
  });

  it("owns root text-entry focus without treating other controls as text entry", async () => {
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
        <TextEntryFocusProbe />
        <input aria-label="Title" />
        <textarea aria-label="Notes" />
        <input aria-label="Enabled" type="checkbox" />
        <select aria-label="Sort">
          <option>Newest</option>
        </select>
        <div data-modal-backdrop="true">
          <input aria-label="Dialog title" />
        </div>
      </MobileViewportProvider>,
    );

    const stableCapability = capability;
    expect(rootTextEntryFocused).toBe(false);

    fireEvent.focus(screen.getByRole("textbox", { name: "Title" }));
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(true);
    });

    fireEvent.focus(screen.getByRole("checkbox", { name: "Enabled" }));
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(false);
    });

    fireEvent.focus(screen.getByRole("combobox", { name: "Sort" }));
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(false);
    });

    fireEvent.focus(screen.getByRole("textbox", { name: "Notes" }));
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(true);
    });

    fireEvent.focus(screen.getByRole("textbox", { name: "Dialog title" }));
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(false);
    });
    expect(capability).toBe(stableCapability);
  });

  it("re-reads active focus and removes its one document observer pair", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(
      <MobileViewportProvider>
        <CapabilityProbe />
        <TextEntryFocusProbe />
        <input aria-label="Title" />
      </MobileViewportProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Title" });

    input.focus();
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(true);
    });
    input.blur();
    expect(rootTextEntryFocused).toBe(true);
    await waitFor(() => {
      expect(rootTextEntryFocused).toBe(false);
    });

    const focusInRegistrations = addEventListener.mock.calls.filter(
      ([type]) => type === "focusin",
    );
    const focusOutRegistrations = addEventListener.mock.calls.filter(
      ([type]) => type === "focusout",
    );
    expect(focusInRegistrations).toHaveLength(1);
    expect(focusOutRegistrations).toHaveLength(1);
    const focusInListener = focusInRegistrations[0]?.[1];
    const focusOutListener = focusOutRegistrations[0]?.[1];
    expect(focusInListener).toBeTypeOf("function");
    expect(focusOutListener).toBeTypeOf("function");

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "focusin",
      focusInListener,
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "focusout",
      focusOutListener,
    );
  });
});
