import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MobileViewportProvider,
  useMobileViewport,
  type MobileViewportCapability,
} from "@/lib/mobileViewport/MobileViewportProvider";

let capability: MobileViewportCapability | null = null;

function CapabilityProbe() {
  capability = useMobileViewport();
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

describe("MobileViewportProvider", () => {
  afterEach(() => {
    capability = null;
    document.documentElement.style.removeProperty(
      "--mobile-content-bottom-clearance",
    );
    document.documentElement.style.removeProperty(
      "--mobile-nexus-bottom-offset",
    );
    document.documentElement.style.removeProperty(
      "--mobile-overlay-keyboard-inset",
    );
  });

  it("publishes measured player and content clearance", async () => {
    const { unmount } = render(
      <MobileViewportProvider>
        <RegisteredPlayer />
      </MobileViewportProvider>,
    );

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-nexus-bottom-offset",
        ),
      ).toContain("80px");
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-content-bottom-clearance",
        ),
      ).toContain("80px");
    });

    unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-content-bottom-clearance",
      ),
    ).toBe("");
  });

  it("defects on a duplicate active named registration and unregisters synchronously", () => {
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
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
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-content-bottom-clearance",
        ),
      ).toContain("150px");
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-nexus-bottom-offset",
        ),
      ).toContain("80px");
    });

    act(() => unregisterNexus!());
    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-content-bottom-clearance",
        ),
      ).toContain("80px");
    });

    act(() => unregisterPlayer!());
    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-content-bottom-clearance",
        ),
      ).toContain("0px");
      expect(
        document.documentElement.style.getPropertyValue(
          "--mobile-nexus-bottom-offset",
        ),
      ).toContain("0px");
    });
    player.remove();
    nexus.remove();
  });

  it("publishes and clears the one MobileSheet keyboard channel", () => {
    render(
      <MobileViewportProvider>
        <CapabilityProbe />
      </MobileViewportProvider>,
    );

    let release: (() => void) | null = null;
    act(() => {
      release = capability!.reportMobileSheetKeyboardInset(312);
    });
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("312px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-content-bottom-clearance",
      ),
    ).toContain("312px");

    act(() => release!());
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-overlay-keyboard-inset",
      ),
    ).toBe("0px");
  });
});
