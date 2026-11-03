/**
 * What a resource is called and drawn as: its scheme, narrowed for `media` by that
 * media's own kind. A null kind is a modeled state: the surface does not hold the medium.
 */
import type * as Icon from "@/lib/ui/icons";
import { mediaKindGlyph, mediaKindLabel, type MediaKind } from "@/lib/media/kind";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";
import { resourceIconForScheme, resourceTypeLabel, type ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "./items";

export type ResourceType =
  | { readonly scheme: "media"; readonly mediaKind: MediaKind | null }
  | { readonly scheme: Exclude<ResourceScheme, "media">; readonly mediaKind: null };

export const resourceType = (scheme: ResourceScheme, mediaKind: MediaKind | null): ResourceType =>
  scheme === "media" ? { scheme, mediaKind } : { scheme, mediaKind: null };

export const resourceTypeGlyph = ({ scheme, mediaKind }: ResourceType): Icon.Glyph =>
  mediaKind !== null ? mediaKindGlyph(mediaKind) : resourceIconForScheme(scheme);

export const resourceTypeName = ({ scheme, mediaKind }: ResourceType): string =>
  mediaKind !== null ? mediaKindLabel(mediaKind) : resourceTypeLabel(scheme);

/** A highlight answers with its source's kind, which metadata uses to choose a source's authors; `resourceType` keeps the kind only for a media ref. */
export const itemMediaKind = (item: ResourceItem): MediaKind | null => {
  const { body, source } = item.preview;
  return body.kind === "media" ? body.media_summary.media_kind
    : source?.media_kind ?? (body.kind === "named" ? body.media_kind : null);
};

export const paneGlyph = (href: string, mediaKind: MediaKind | undefined): Icon.Glyph =>
  mediaKind !== undefined ? mediaKindGlyph(mediaKind) : getPaneRouteIcon(href);
