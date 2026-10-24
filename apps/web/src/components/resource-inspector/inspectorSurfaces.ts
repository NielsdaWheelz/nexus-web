// Compose route-owned Contents, Members, Connections and Forks in that order.
// The capability policy owns the default preference; Connections is always
// published, including when it is the inspector's only tab.
import type { ReactNode } from "react";
import type {
  ResourceInspectorLinkedItemsSurface,
  ResourceInspectorResourcePolicy,
  ResourceInspectorSurfaceRole,
} from "@/lib/resources/resourceCapabilities";
import type { WorkspaceSecondarySurfaceIdOf } from "@/lib/panes/paneSecondaryModel";

type InspectorSurfaceId = WorkspaceSecondarySurfaceIdOf<"resource-inspector">;

export interface InspectorDomainBodies {
  /** `resource-contents` — published only when the pane supplies it (Media TOC). */
  contents?: ReactNode;
  /** `resource-members` — an authorized Library governance surface. */
  members?: ReactNode;
  /** The single LinkedItems body (Connections). */
  linkedItems?: ReactNode;
  /** `resource-forks` — Conversation only. */
  forks?: ReactNode;
}

interface InspectorSurfacePlan {
  surfaces: { id: InspectorSurfaceId; body: ReactNode }[];
  defaultSurfaceId: InspectorSurfaceId;
}

function linkedItemsSurfaceId(
  linkedItems: ResourceInspectorLinkedItemsSurface,
): InspectorSurfaceId {
  switch (linkedItems) {
    case "MediaEvidence":
    case "ResourceConnections":
      return "resource-connections";
    default: {
      const exhaustive: never = linkedItems;
      throw new Error(`Unhandled linked-items surface: ${String(exhaustive)}`);
    }
  }
}

/** Build the ordered surfaces and resolve the policy's default preference. */
export function planInspectorSurfaces(input: {
  policy: ResourceInspectorResourcePolicy;
  bodies: InspectorDomainBodies;
}): InspectorSurfacePlan {
  const { policy, bodies } = input;
  const surfaces: InspectorSurfacePlan["surfaces"] = [];
  const linkedId = linkedItemsSurfaceId(policy.linked_items);

  if (bodies.linkedItems == null) {
    throw new Error(
      `Resource Inspector policy requires a linked-items body for ${policy.linked_items}`,
    );
  }
  if (policy.forks === "ConversationForks" && bodies.forks == null) {
    throw new Error("Resource Inspector policy requires a Forks body");
  }

  // Fixed tab order: Contents · Members · Connections · Forks.
  if (bodies.contents != null) {
    surfaces.push({ id: "resource-contents", body: bodies.contents });
  }
  if (bodies.members != null) {
    surfaces.push({ id: "resource-members", body: bodies.members });
  }
  surfaces.push({ id: linkedId, body: bodies.linkedItems });
  if (policy.forks === "ConversationForks") {
    surfaces.push({ id: "resource-forks", body: bodies.forks });
  }

  const publishedIds = new Set(surfaces.map((surface) => surface.id));
  const roleSurfaceId = (
    role: ResourceInspectorSurfaceRole,
  ): InspectorSurfaceId | null => {
    switch (role) {
      case "Contents":
        return publishedIds.has("resource-contents") ? "resource-contents" : null;
      case "LinkedItems":
        return publishedIds.has(linkedId) ? linkedId : null;
      case "Forks":
        return publishedIds.has("resource-forks") ? "resource-forks" : null;
      default: {
        const exhaustive: never = role;
        throw new Error(`Unhandled surface role: ${String(exhaustive)}`);
      }
    }
  };

  // Preference order is independent of tab order. Connections is always present.
  let defaultSurfaceId: InspectorSurfaceId = linkedId;
  for (const role of policy.default_surface_order) {
    const resolved = roleSurfaceId(role);
    if (resolved !== null) {
      defaultSurfaceId = resolved;
      break;
    }
  }

  return { surfaces, defaultSurfaceId };
}
