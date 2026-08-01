import { useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import {
  MobileViewportProvider,
  useMobileViewport,
} from "@/lib/mobileViewport/MobileViewportProvider";

function readRootLength(property: string): number {
  const probe = document.createElement("div");
  probe.style.height = `var(${property})`;
  document.body.append(probe);
  const value = Number.parseFloat(getComputedStyle(probe).height);
  probe.remove();
  return value;
}

function SafeAreaCompositionProbe() {
  const capability = useMobileViewport();
  const playerRef = useRef<HTMLDivElement>(null);
  const nexusRef = useRef<HTMLDivElement>(null);
  const unregisterPlayerRef = useRef<(() => void) | null>(null);
  const unregisterNexusRef = useRef<(() => void) | null>(null);
  const keyboardReportsRef = useRef<Array<() => void>>([]);

  return (
    <>
      <div
        ref={playerRef}
        style={{ position: "fixed", insetInline: 0, bottom: 0, height: 80 }}
      />
      <div
        ref={nexusRef}
        style={{ position: "fixed", insetInline: 0, bottom: 0, height: 150 }}
      />
      <button
        type="button"
        onClick={() => {
          const player = playerRef.current;
          if (!player) throw new Error("safe-area proof player did not mount");
          unregisterPlayerRef.current =
            capability.registerFixedObstruction("Player", player);
        }}
      >
        Register Player
      </button>
      <button
        type="button"
        onClick={() => {
          const nexus = nexusRef.current;
          if (!nexus) throw new Error("safe-area proof Nexus did not mount");
          unregisterNexusRef.current =
            capability.registerFixedObstruction("Nexus", nexus);
        }}
      >
        Register Nexus
      </button>
      <button
        type="button"
        onClick={() => {
          unregisterNexusRef.current?.();
          unregisterNexusRef.current = null;
        }}
      >
        Unregister Nexus
      </button>
      <button
        type="button"
        onClick={() => {
          unregisterPlayerRef.current?.();
          unregisterPlayerRef.current = null;
        }}
      >
        Unregister Player
      </button>
      {[212, 312].map((inset) => (
        <button
          key={inset}
          type="button"
          onClick={() => {
            keyboardReportsRef.current.push(
              capability.reportMobileOverlayKeyboardInset(inset),
            );
          }}
        >
          Report keyboard {inset}
        </button>
      ))}
      <button
        type="button"
        onClick={() => keyboardReportsRef.current.pop()?.()}
      >
        Release newest keyboard
      </button>
    </>
  );
}

describe("mobile safe-area composition", () => {
  afterEach(() => {
    for (const property of [
      "--viewport-safe-top",
      "--viewport-safe-right",
      "--viewport-safe-bottom",
      "--viewport-safe-left",
    ]) {
      document.documentElement.style.removeProperty(property);
    }
  });

  it("composes safe bottom, measured chrome, and keyboard without stale teardown state", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.setProperty("--viewport-safe-bottom", "37px");
    const { unmount } = render(
      <MobileViewportProvider>
        <SafeAreaCompositionProbe />
      </MobileViewportProvider>,
    );

    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(37);
    expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(37);

    fireEvent.click(screen.getByRole("button", { name: "Register Player" }));
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(80);
      expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(80);
    });

    fireEvent.click(screen.getByRole("button", { name: "Register Nexus" }));
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(150);
      expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(80);
    });

    fireEvent.click(screen.getByRole("button", { name: "Report keyboard 212" }));
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(212);
    });
    fireEvent.click(screen.getByRole("button", { name: "Report keyboard 312" }));
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(312);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Release newest keyboard" }),
    );
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(212);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Release newest keyboard" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unregister Nexus" }));
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(80);
    });
    fireEvent.click(screen.getByRole("button", { name: "Unregister Player" }));
    await waitFor(() => {
      expect(readRootLength("--mobile-content-bottom-clearance")).toBe(37);
    });

    document.documentElement.style.setProperty("--viewport-safe-bottom", "93px");
    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(93);
    expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(93);

    unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--mobile-content-bottom-clearance",
      ),
    ).toBe("");
    expect(readRootLength("--mobile-content-bottom-clearance")).toBe(93);
    expect(readRootLength("--mobile-nexus-bottom-offset")).toBe(93);
  });

  it("keeps floating actions inside canonical mobile side insets", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.setProperty("--viewport-safe-top", "0px");
    document.documentElement.style.setProperty("--viewport-safe-right", "13px");
    document.documentElement.style.setProperty("--viewport-safe-bottom", "0px");
    document.documentElement.style.setProperty("--viewport-safe-left", "19px");
    const props = {
      open: true,
      strategy: "text-selection" as const,
      role: "group" as const,
      label: "Floating actions",
      onDismiss: () => undefined,
    };
    const { rerender } = render(
      <FloatingActionSurface
        {...props}
        anchor={new DOMRect(0, 180, 20, 20)}
      >
        <button type="button" style={{ width: 160, height: 48 }}>
          Actions
        </button>
      </FloatingActionSurface>,
    );
    const surface = await screen.findByRole("group", {
      name: "Floating actions",
    });

    await waitFor(() => {
      expect(surface.getBoundingClientRect().left).toBeGreaterThanOrEqual(27);
    });

    rerender(
      <FloatingActionSurface
        {...props}
        anchor={new DOMRect(370, 180, 20, 20)}
      >
        <button type="button" style={{ width: 160, height: 48 }}>
          Actions
        </button>
      </FloatingActionSurface>,
    );
    await waitFor(() => {
      expect(surface.getBoundingClientRect().right).toBeLessThanOrEqual(369);
    });
  });
});
