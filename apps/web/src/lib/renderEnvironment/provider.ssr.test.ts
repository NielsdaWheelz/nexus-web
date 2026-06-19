import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RenderEnvironmentProvider, useViewportState } from "./provider";
import type { RenderEnvironment } from "./types";

const ENVIRONMENT: RenderEnvironment = {
  androidShell: false,
  platform: "other",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentInstant: "2026-06-18T12:00:00.000Z",
  currentLocalDate: "2026-06-18",
  initialViewport: "desktop",
};

function ViewportProbe() {
  const viewport = useViewportState();
  return createElement(
    "output",
    null,
    `${viewport.kind}:${viewport.hydrated ? "hydrated" : "pending"}`,
  );
}

describe("RenderEnvironmentProvider SSR", () => {
  it("renders the server viewport before browser measurement is available", () => {
    const Provider = RenderEnvironmentProvider as (props: {
      value: RenderEnvironment;
      children?: ReactNode;
    }) => ReactElement;
    const view = renderToString(
      createElement(Provider, { value: ENVIRONMENT }, createElement(ViewportProbe)),
    );

    expect(view).toContain("desktop:pending");
  });
});
