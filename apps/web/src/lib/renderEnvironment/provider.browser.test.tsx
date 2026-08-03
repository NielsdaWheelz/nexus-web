import { render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { RenderEnvironmentProvider, useViewportState } from "./provider";
import type { RenderEnvironment } from "./types";

const ENVIRONMENT: RenderEnvironment = {
  androidShell: false,
  platform: "other",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentInstant: "2026-07-31T12:00:00.000Z",
  currentLocalDate: "2026-07-31",
  initialViewport: "desktop",
};

function ViewportProbe() {
  const viewport = useViewportState();
  return (
    <output aria-label="Render viewport">
      {viewport.kind}:{viewport.hydrated ? "hydrated" : "pending"}:
      {Math.round(window.visualViewport?.width ?? window.innerWidth)}
    </output>
  );
}

it("publishes a mounted visual viewport change to its consumer", async () => {
  const initialWidth = window.innerWidth;
  const initialHeight = window.innerHeight;
  await page.viewport(1_200, 800);
  const view = render(
    <RenderEnvironmentProvider value={ENVIRONMENT}>
      <ViewportProbe />
    </RenderEnvironmentProvider>,
  );

  try {
    await waitFor(() =>
      expect(screen.getByLabelText("Render viewport")).toHaveTextContent(
        "desktop:hydrated:1200",
      ),
    );

    await page.viewport(390, 800);

    await waitFor(() =>
      expect(screen.getByLabelText("Render viewport")).toHaveTextContent(
        "mobile:hydrated:390",
      ),
    );
  } finally {
    view.unmount();
    await page.viewport(initialWidth, initialHeight);
  }
});
