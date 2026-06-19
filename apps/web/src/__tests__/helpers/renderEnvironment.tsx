import type { ReactNode } from "react";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";

export const DEFAULT_RENDER_ENVIRONMENT: RenderEnvironment = {
  androidShell: false,
  platform: "other",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentInstant: "2026-06-03T12:00:00.000Z",
  currentLocalDate: "2026-06-03",
  initialViewport: "desktop",
};

export function withRenderEnvironment(
  children: ReactNode,
  overrides: Partial<RenderEnvironment> = {},
) {
  return (
    <RenderEnvironmentProvider value={{ ...DEFAULT_RENDER_ENVIRONMENT, ...overrides }}>
      {children}
    </RenderEnvironmentProvider>
  );
}
