import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import {
  decodeResourceItem,
  type ResourceItem,
} from "@/lib/resources/resourceItems";
import {
  decodePaneResourceLocator,
  samePaneResourceLocator,
  type PaneResourceLocator,
} from "@/lib/panes/paneResourceLocator";
import { expectExactRecord } from "@/lib/validation";

export interface ResourceLocatorResolution {
  locator: PaneResourceLocator;
  resourceItem: ResourceItem;
  canonicalHref: string | null;
}

export function decodeResourceLocatorResolutions(
  requestedLocators: readonly PaneResourceLocator[],
  raw: unknown,
): ResourceLocatorResolution[] {
  const data = expectExactRecord(
    raw,
    ["resolutions"],
    "resource locator response",
  );
  if (!Array.isArray(data.resolutions)) {
    throw new TypeError(
      "resource locator response.resolutions must be an array",
    );
  }
  if (data.resolutions.length !== requestedLocators.length) {
    throw new TypeError(
      `resource locator response returned ${data.resolutions.length} rows for ${requestedLocators.length} locators`,
    );
  }

  return data.resolutions.map((rawResolution, index) => {
    const row = expectExactRecord(
      rawResolution,
      ["locator", "resourceItem", "canonicalHref"],
      "resource locator resolution",
    );
    const locator = decodePaneResourceLocator(row.locator);
    const requestedLocator = requestedLocators[index];
    if (
      requestedLocator === undefined ||
      !samePaneResourceLocator(locator, requestedLocator)
    ) {
      throw new TypeError(
        `resource locator response identity mismatch at index ${index}`,
      );
    }
    const resourceItem = decodeResourceItem(row.resourceItem);
    const canonicalHref = row.canonicalHref;
    if (canonicalHref !== null && typeof canonicalHref !== "string") {
      throw new TypeError(
        "resource locator resolution.canonicalHref must be a string or null",
      );
    }
    if (canonicalHref !== resourceItem.route) {
      throw new TypeError(
        "resource locator resolution.canonicalHref must match resource item.route",
      );
    }
    return { locator, resourceItem, canonicalHref };
  });
}

export async function resolveResourceLocators(
  locators: readonly PaneResourceLocator[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<ResourceLocatorResolution[]> {
  if (locators.length === 0) return [];
  const response = await apiFetch<{ data: unknown }>(
    "/api/resource-items/locators/resolve",
    {
      method: "POST",
      body: JSON.stringify({ locators }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return decodeApiPayload(
    response.data,
    (raw) => decodeResourceLocatorResolutions(locators, raw),
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
