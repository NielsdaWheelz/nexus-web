import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { PaneResourceLocator } from "@/lib/panes/paneResourceLocator";

export type ResourceLocatorResolution = Schema<"ResourceLocatorResolutionOut">;

export async function resolveResourceLocators(
  locators: readonly PaneResourceLocator[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<ResourceLocatorResolution[]> {
  if (locators.length === 0) return [];
  const response = await apiFetch<ApiJson<"/resource-items/locators/resolve", "post">>(
    "/api/resource-items/locators/resolve", {
      method: "POST", body: JSON.stringify({ locators }), signal: options.signal,
    },
  );
  return response.data.resolutions;
}

export async function resolveResourceLocator(
  locator: PaneResourceLocator,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ResourceLocatorResolution> {
  const resolutions = await resolveResourceLocators([locator], options);
  return resolutions[0]!;
}
