import { apiFetch } from "@/lib/api/client";
import {
  decodeResourceItem,
  type ResourceItem,
} from "@/lib/resources/resourceItems";
import type { PaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import { expectExactRecord } from "@/lib/validation";

export interface ResourceLocatorResolution {
  locator: PaneResourceLocator;
  resourceItem: ResourceItem;
  canonicalHref: string | null;
}

export async function resolveResourceLocators(
  locators: readonly PaneResourceLocator[],
): Promise<ResourceLocatorResolution[]> {
  if (locators.length === 0) return [];
  const response = await apiFetch<{ data: unknown }>("/api/resource-items/locators/resolve", {
    method: "POST",
    body: JSON.stringify({ locators }),
  });
  const data = expectExactRecord(
    response.data,
    ["resolutions"],
    "resource locator response",
  );
  if (!Array.isArray(data.resolutions)) {
    throw new TypeError("resource locator response.resolutions must be an array");
  }
  const resolutions = data.resolutions;
  return resolutions.map((raw) => {
    const row = expectExactRecord(
      raw,
      ["locator", "resourceItem", "canonicalHref"],
      "resource locator resolution",
    );
    const canonicalHref = row.canonicalHref;
    if (canonicalHref !== null && typeof canonicalHref !== "string") {
      throw new TypeError(
        "resource locator resolution.canonicalHref must be a string or null",
      );
    }
    return {
      locator: row.locator as PaneResourceLocator,
      resourceItem: decodeResourceItem(row.resourceItem),
      canonicalHref,
    };
  });
}
