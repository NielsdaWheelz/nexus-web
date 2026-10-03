import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import {
  samePaneResourceLocator,
  type PaneResourceLocator,
} from "@/lib/panes/paneResourceLocator";

export type ResourceLocatorResolution =
  ApiJson<"/resource-items/locators/resolve", "post">["data"]["resolutions"][number];

export async function resolveResourceLocators(
  locators: readonly PaneResourceLocator[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<ResourceLocatorResolution[]> {
  if (locators.length === 0) return [];
  const response = await apiFetch<ApiJson<"/resource-items/locators/resolve", "post">>(
    "/api/resource-items/locators/resolve",
    {
      method: "POST",
      body: JSON.stringify({ locators }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return decodeApiPayload(
    response.data,
    () => {
      const resolutions = response.data.resolutions;
      if (resolutions.length !== locators.length) {
        throw new TypeError(
          `resource locator response returned ${resolutions.length} rows for ${locators.length} locators`,
        );
      }
      for (let index = 0; index < resolutions.length; index++) {
        const resolution = resolutions[index];
        const requestedLocator = locators[index];
        if (
          requestedLocator === undefined ||
          !samePaneResourceLocator(resolution.locator, requestedLocator)
        ) {
          throw new TypeError(
            `resource locator response identity mismatch at index ${index}`,
          );
        }
        if (resolution.canonicalHref !== resolution.resourceItem.route) {
          throw new TypeError(
            "resource locator resolution.canonicalHref must match resource item.route",
          );
        }
      }
      return resolutions;
    },
    "Resource locator resolve",
  );
}

export async function resolveResourceLocator(
  locator: PaneResourceLocator,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ResourceLocatorResolution> {
  const resolutions = await resolveResourceLocators([locator], options);
  return resolutions[0]!;
}
