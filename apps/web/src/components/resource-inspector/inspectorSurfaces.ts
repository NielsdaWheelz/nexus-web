// Pure composition of the Inspector's published surfaces + fallback default
// (A12 role resolution + A13 composition table). Given the subject's typed
// `ResourceInspectorResourcePolicy` and the route-owned domain bodies the pane
// supplies, it wires the tab host's publication: Contents (when a Contents body
// exists) · the single LinkedItems surface (Evidence|Context|Connections) ·
// Forks (Conversation only) · the always-published Dossier — in that fixed tab
// order — and resolves `default_surface_order` (fallback preference, NOT tab
// order) to the first concrete published surface.
import type { ReactNode } from "react";
import type {
  ResourceInspectorLinkedItemsSurface,
  ResourceInspectorResourcePolicy,
  ResourceInspectorSurfaceRole,
} from "@/lib/resources/resourceCapabilities";
import type { PaneSecondarySurfacePublication } from "@/lib/panes/panePublications";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";

export interface InspectorDomainBodies {
  /** `resource-contents` — published only when the pane supplies it (Media TOC). */
  contents?: ReactNode;
  /** The single LinkedItems body (Evidence | Context | Connections). */
  linkedItems?: ReactNode;
  /** `resource-forks` — Conversation only. */
  forks?: ReactNode;
}

export interface InspectorSurfacePlan {
  surfaces: PaneSecondarySurfacePublication[];
  defaultSurfaceId: WorkspaceSecondarySurfaceId;
}

function linkedItemsSurfaceId(
  linkedItems: ResourceInspectorLinkedItemsSurface,
): WorkspaceSecondarySurfaceId {
  switch (linkedItems) {
    case "MediaEvidence":
      return "resource-evidence";
    case "ConversationContext":
      return "resource-context";
    case "ResourceConnections":
      return "resource-connections";
    default: {
      const exhaustive: never = linkedItems;
      throw new Error(`Unhandled linked-items surface: ${String(exhaustive)}`);
    }
  }
}

/**
 * Build the ordered surface publications + resolved default. `dossierBody` is the
 * reference-stable Dossier element (so streaming does not republish). Throws via
 * `normalizePaneSecondaryPublication` downstream if the result is empty — but
 * Dossier is always appended, so there is always ≥1 surface (A12 guarantee).
 */
export function planInspectorSurfaces(input: {
  policy: ResourceInspectorResourcePolicy;
  bodies: InspectorDomainBodies;
  dossierBody: ReactNode;
}): InspectorSurfacePlan {
  const { policy, bodies, dossierBody } = input;
  const surfaces: PaneSecondarySurfacePublication[] = [];
  const linkedId = linkedItemsSurfaceId(policy.linkedItems);

  if (bodies.linkedItems == null) {
    throw new Error(
      `Resource Inspector policy requires a linked-items body for ${policy.linkedItems}`,
    );
  }
  if (policy.forks === "ConversationForks" && bodies.forks == null) {
    throw new Error("Resource Inspector policy requires a Forks body");
  }

  // Fixed tab order (A13): Contents · LinkedItems · Forks · Dossier.
  if (bodies.contents != null) {
    surfaces.push({ id: "resource-contents", body: bodies.contents });
  }
  surfaces.push({ id: linkedId, body: bodies.linkedItems });
  if (policy.forks === "ConversationForks") {
    surfaces.push({ id: "resource-forks", body: bodies.forks });
  }
  surfaces.push({ id: "resource-dossier", body: dossierBody });

  const publishedIds = new Set(surfaces.map((surface) => surface.id));
  const roleSurfaceId = (
    role: ResourceInspectorSurfaceRole,
  ): WorkspaceSecondarySurfaceId | null => {
    switch (role) {
      case "Contents":
        return publishedIds.has("resource-contents") ? "resource-contents" : null;
      case "LinkedItems":
        return publishedIds.has(linkedId) ? linkedId : null;
      case "Forks":
        return publishedIds.has("resource-forks") ? "resource-forks" : null;
      case "Dossier":
        return "resource-dossier";
      default: {
        const exhaustive: never = role;
        throw new Error(`Unhandled surface role: ${String(exhaustive)}`);
      }
    }
  };

  // `default_surface_order` is fallback preference (NOT tab order): first role
  // that maps to a published surface. It always ends in Dossier, so this
  // resolves.
  let defaultSurfaceId: WorkspaceSecondarySurfaceId = "resource-dossier";
  for (const role of policy.defaultSurfaceOrder) {
    const resolved = roleSurfaceId(role);
    if (resolved !== null) {
      defaultSurfaceId = resolved;
      break;
    }
  }

  return { surfaces, defaultSurfaceId };
}
