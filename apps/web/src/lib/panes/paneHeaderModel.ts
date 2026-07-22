import { getDestination } from "@/lib/navigation/destinations";
import type { PaneRouteHeaderContract } from "@/lib/panes/paneRouteModel";
import { formatFolio, type Folio } from "@/lib/ui/folio";

export interface PaneHeaderCredit {
  readonly label: string;
  readonly href?: string;
}

export type PaneHeaderCreditGroup =
  | {
      readonly kind: "authors";
      readonly credits: readonly PaneHeaderCredit[];
    }
  | {
      readonly kind: "role";
      readonly label: string;
      readonly credits: readonly PaneHeaderCredit[];
    };

export type PaneResourceHeaderPublication =
  | {
      readonly status: "ready";
      readonly title: string;
      readonly creditGroups: readonly PaneHeaderCreditGroup[];
    }
  | { readonly status: "unavailable"; readonly title: string }
  | { readonly status: "failed"; readonly title: string };

export type PaneHeaderPublication =
  | {
      readonly kind: "section";
      readonly folio: Folio;
      readonly pending: boolean;
    }
  | {
      readonly kind: "resource";
      readonly resource: PaneResourceHeaderPublication;
    };

export type PaneResourceHeaderState =
  | { readonly status: "pending"; readonly accessibleLabel: string }
  | PaneResourceHeaderPublication;

export type PaneHeaderModel =
  | {
      readonly kind: "section";
      readonly standingHead: string;
      readonly folio: Folio;
      readonly pending: boolean;
    }
  | {
      readonly kind: "resource";
      readonly resource: PaneResourceHeaderState;
    };

interface PaneHeaderPublicationRecord {
  readonly routeKey: string;
  readonly header?: PaneHeaderPublication;
}

interface ResolvePaneHeaderModelInput {
  readonly currentRouteKey: string;
  readonly routeHeader: PaneRouteHeaderContract;
  readonly paneLabel: string;
  readonly paneLabelPending: boolean;
  readonly publication: PaneHeaderPublicationRecord | null;
}

const NONE_FOLIO: Folio = { kind: "none" };

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty.`);
  }
}

function validateResourcePublication(publication: PaneResourceHeaderPublication): void {
  requireNonEmpty(publication.title, "Resource header title");
  if (publication.status !== "ready") return;

  let authorGroups = 0;
  for (const group of publication.creditGroups) {
    if (group.credits.length === 0) {
      throw new Error("Resource header credit groups must be non-empty.");
    }
    if (group.kind === "authors") {
      authorGroups += 1;
      if (authorGroups > 1) {
        throw new Error("Resource header may contain at most one authors group.");
      }
    } else {
      requireNonEmpty(group.label, "Resource header credit role label");
    }
    for (const credit of group.credits) {
      requireNonEmpty(credit.label, "Resource header credit label");
    }
  }
}

function defaultSectionFolio(
  contract: Extract<PaneRouteHeaderContract, { kind: "section" }>,
  paneLabel: string,
): Folio {
  switch (contract.defaultFolio) {
    case "none":
      return NONE_FOLIO;
    case "pane-label":
      requireNonEmpty(paneLabel, "Pane label");
      return { kind: "title", value: paneLabel };
  }
}

export function resolvePaneHeaderModel({
  currentRouteKey,
  routeHeader,
  paneLabel,
  paneLabelPending,
  publication,
}: ResolvePaneHeaderModelInput): PaneHeaderModel {
  const acceptedHeader =
    publication?.routeKey === currentRouteKey ? publication.header : undefined;

  switch (routeHeader.kind) {
    case "section": {
      const standingHead = getDestination(routeHeader.destinationId).label;
      if (!acceptedHeader) {
        return {
          kind: "section",
          standingHead,
          folio: defaultSectionFolio(routeHeader, paneLabel),
          pending: routeHeader.defaultFolio === "pane-label" && paneLabelPending,
        };
      }
      if (acceptedHeader.kind !== "section") {
        throw new Error("Section route received a resource header publication.");
      }
      return {
        kind: "section",
        standingHead,
        folio: acceptedHeader.folio,
        pending: acceptedHeader.pending,
      };
    }
    case "resource": {
      requireNonEmpty(routeHeader.pendingLabel, "Resource pending label");
      if (!acceptedHeader) {
        return {
          kind: "resource",
          resource: {
            status: "pending",
            accessibleLabel: routeHeader.pendingLabel,
          },
        };
      }
      if (acceptedHeader.kind !== "resource") {
        throw new Error("Resource route received a section header publication.");
      }
      validateResourcePublication(acceptedHeader.resource);
      return { kind: "resource", resource: acceptedHeader.resource };
    }
  }
}

export function paneHeaderAccessibleName(model: PaneHeaderModel): string {
  switch (model.kind) {
    case "section": {
      const folio = model.pending ? "Loading…" : formatFolio(model.folio);
      return folio ? `${model.standingHead} — ${folio}` : model.standingHead;
    }
    case "resource":
      return model.resource.status === "pending"
        ? model.resource.accessibleLabel
        : model.resource.title;
  }
}
