import {
  RESOURCE_ACTION_CATALOG,
  type ResourceActionCatalogKey,
  type ResourceCoreCatalogKey,
  resolveResourceCoreCatalogKeys,
} from "@/lib/actions/resourceActions";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { NexusAction, NexusTarget } from "./model";

function projectCatalogAction(
  catalogKey: ResourceActionCatalogKey,
  target: NexusTarget,
): NexusAction {
  const catalog = RESOURCE_ACTION_CATALOG[catalogKey];
  return {
    id: catalog.id,
    label: catalog.label,
    icon: catalog.icon,
    activation: { kind: "Standard" },
    availability: { kind: "Available", target },
  };
}

function projectResourceAction(
  subject: ResourceActionSubject,
  label: string,
  catalogKey: ResourceCoreCatalogKey,
): NexusAction {
  switch (catalogKey) {
    case "Open":
      return projectCatalogAction("Open", {
        kind: "ResourceOpen",
        subject,
        labelHint: label,
      });
    case "Share":
      return projectCatalogAction("Share", {
        kind: "ResourceShare",
        subject,
      });
    case "Chat":
      return projectCatalogAction("Chat", {
        kind: "ResourceChat",
        ref: subject.ref,
      });
  }
}

export function buildResourceNexusActions(
  subject: ResourceActionSubject,
  label: string,
): readonly NexusAction[] {
  return resolveResourceCoreCatalogKeys(subject, "Representation").map(
    (catalogKey) => projectResourceAction(subject, label, catalogKey),
  );
}
