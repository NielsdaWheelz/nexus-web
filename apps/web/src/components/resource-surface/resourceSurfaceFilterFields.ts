import type { ResourceSurfaceOccurrence } from "@/lib/resources/resourceItems";

export function resourceSurfaceFilterFields(
  occurrence: Pick<ResourceSurfaceOccurrence, "target">,
): readonly string[] {
  const { item, content } = occurrence.target;
  if (content.kind === "note_body") return [content.bodyText];
  return [
    item.label.trim() || item.scheme.replaceAll("_", " "),
    ...(item.summary ? [item.summary] : []),
  ];
}
