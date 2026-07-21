import { apiFetch } from "@/lib/api/client";
import { normalizeResourceItem, type ResourceItem } from "@/lib/resources/resourceItems";
import type { PaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import { isRecord } from "@/lib/validation";

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
  const data = isRecord(response.data) ? response.data : {};
  const resolutions = Array.isArray(data.resolutions) ? data.resolutions : [];
  return resolutions.map((raw) => {
    const row = isRecord(raw) ? raw : {};
    const item = isRecord(row.resourceItem)
      ? row.resourceItem
      : isRecord(row.resource_item)
        ? row.resource_item
        : {};
    return {
      locator: row.locator as PaneResourceLocator,
      resourceItem: normalizeResourceItem(item),
      canonicalHref:
        typeof row.canonicalHref === "string"
          ? row.canonicalHref
          : typeof row.canonical_href === "string"
            ? row.canonical_href
            : null,
    };
  });
}
