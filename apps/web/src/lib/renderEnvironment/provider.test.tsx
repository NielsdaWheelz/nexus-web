import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderEnvironmentProvider, useViewportState } from "./provider";
import type { RenderEnvironment } from "./types";

const ENVIRONMENT: RenderEnvironment = {
  androidShell: false,
  platform: "other",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentLocalDate: "2026-06-18",
  initialViewport: "desktop",
};

function installMatchMedia(matches: boolean) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        get matches() {
          return matches;
        },
        media: "(max-width: 768px)",
        onchange: null,
        addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
          listeners.add(listener);
        },
        removeEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
          listeners.delete(listener);
        },
        addListener: (listener: EventListenerOrEventListenerObject) => {
          listeners.add(listener);
        },
        removeListener: (listener: EventListenerOrEventListenerObject) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList,
  );
  return {
    setMatches(next: boolean) {
      matches = next;
      const event = new Event("change");
      for (const listener of listeners) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    },
  };
}

function ViewportProbe() {
  const viewport = useViewportState();
  return (
    <output aria-label="viewport">
      {viewport.kind}:{viewport.hydrated ? "hydrated" : "pending"}
    </output>
  );
}

describe("RenderEnvironmentProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the measured browser viewport after mount", async () => {
    installMatchMedia(true);

    render(
      <RenderEnvironmentProvider value={ENVIRONMENT}>
        <ViewportProbe />
      </RenderEnvironmentProvider>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("viewport")).toHaveTextContent("mobile:hydrated"),
    );
  });
});
