import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { PaneResourceLocator } from "@/lib/panes/paneRouteModel";

type Resolve = ApiJson<"/resource-items/locators/resolve", "post">;

/** Resolves one typed link's locator; python answers one resolution per locator. */
export async function resolveResourceLocator(
  locator: PaneResourceLocator,
): Promise<Resolve["data"]["resolutions"][number]> {
  const response = await apiFetch<Resolve>("/api/resource-items/locators/resolve", {
    method: "POST",
    body: JSON.stringify({ locators: [locator] }),
  });
  return response.data.resolutions[0]!;
}
