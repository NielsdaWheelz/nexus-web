// A pane's identity: the route's header contract plus what its body
// published. Pure; formatting meta and credits belongs to PaneHeaderIdentity.
import { absent, present, type Presence } from "@/lib/api/presence";
import { getDestination } from "@/lib/navigation/destinations";
import type { PaneRouteHeaderContract } from "@/lib/panes/paneRouteModel";

export interface PaneHeaderCredit {
  readonly label: string;
  readonly href?: string;
}

export type PaneHeaderCreditGroup =
  | { readonly kind: "Authors"; readonly credits: readonly PaneHeaderCredit[] }
  | {
      readonly kind: "Role";
      readonly label: string;
      readonly credits: readonly PaneHeaderCredit[];
    };

/** The one support fact a section header carries beside its title. */
export type PaneHeaderMeta =
  | { readonly kind: "None" }
  | { readonly kind: "Pending" }
  /** `value` counts whole rows; its producer owns that. */
  | { readonly kind: "Count"; readonly value: number; readonly unit: string };

export type PaneResourceHeaderPublication =
  | {
      readonly status: "Ready";
      /** At most one Authors group; no group is empty. */
      readonly creditGroups: readonly PaneHeaderCreditGroup[];
    }
  | { readonly status: "Unavailable" }
  | { readonly status: "Failed" };

export type PaneHeaderPublication =
  | { readonly kind: "Section"; readonly meta: PaneHeaderMeta }
  | {
      readonly kind: "Resource";
      readonly resource: PaneResourceHeaderPublication;
    };

export type PaneHeaderModel =
  | {
      readonly kind: "Section";
      readonly title: string;
      readonly titlePending: boolean;
      readonly context: Presence<string>;
      readonly meta: PaneHeaderMeta;
    }
  | {
      readonly kind: "Resource";
      readonly title: string;
      readonly resource:
        | { readonly status: "Pending"; readonly accessibleLabel: string }
        | PaneResourceHeaderPublication;
    };

/**
 * The route decides the kind. A publication of the other kind is the previous
 * body's, read in the one render before its withdrawal commits: it is ignored.
 */
export function resolvePaneHeaderModel(input: {
  readonly route: PaneRouteHeaderContract;
  readonly title: string;
  readonly titlePending: boolean;
  readonly publication: PaneHeaderPublication | undefined;
}): PaneHeaderModel {
  const { route, title, publication } = input;
  switch (route.kind) {
    case "Section": {
      const section =
        route.context === "Destination"
          ? getDestination(route.destinationId).label
          : null;
      return {
        kind: "Section",
        title,
        titlePending: input.titlePending,
        // a library named "Libraries" must not read "Libraries — Libraries".
        context: section && section !== title ? present(section) : absent(),
        meta:
          publication?.kind === "Section" ? publication.meta : { kind: "None" },
      };
    }
    case "Resource":
      return {
        kind: "Resource",
        title,
        resource:
          publication?.kind === "Resource"
            ? publication.resource
            : { status: "Pending", accessibleLabel: route.pendingLabel },
      };
  }
}

/** The landmark's name: the title and its section, never meta or credits. */
export function paneHeaderAccessibleName(model: PaneHeaderModel): string {
  return model.kind === "Section" && model.context.kind === "Present"
    ? `${model.title} — ${model.context.value}`
    : model.title;
}
