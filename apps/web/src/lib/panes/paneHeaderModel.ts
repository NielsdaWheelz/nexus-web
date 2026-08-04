// Pure resolution of a pane's identity: the route contract plus whatever the
// body published for the route currently mounted. This module owns the
// invariants; it owns no presentation strings — formatting metadata and credits
// belongs to the projection.
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

/** The one typed support fact a section header may carry beside its title. */
export type PaneHeaderMeta =
  | { readonly kind: "None" }
  | { readonly kind: "Pending" }
  | { readonly kind: "Count"; readonly value: number; readonly unit: string }
  | { readonly kind: "Date"; readonly iso: string };

export type PaneResourceHeaderPublication =
  | {
      readonly status: "Ready";
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

type PaneResourceHeaderState =
  | { readonly status: "Pending"; readonly accessibleLabel: string }
  | PaneResourceHeaderPublication;

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

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    // justify-defect: every pane owes the reader a visible identity, and a
    // blank string leaves the header with nothing to say.
    throw new Error(`${field} must be non-empty.`);
  }
}

function sectionContext(
  contract: Extract<PaneRouteHeaderContract, { kind: "Section" }>,
  title: string,
): Presence<string> {
  switch (contract.context) {
    case "None":
      return absent();
    case "Destination": {
      const label = getDestination(contract.destinationId).label;
      // A library actually named "Libraries" must not read "Libraries — Libraries".
      return label === title ? absent() : present(label);
    }
  }
}

function validatedSectionMeta(meta: PaneHeaderMeta): PaneHeaderMeta {
  switch (meta.kind) {
    case "None":
    case "Pending":
      return meta;
    case "Count":
      if (!Number.isInteger(meta.value) || meta.value < 0) {
        // justify-defect: a count is a whole quantity of published rows; any
        // other number means the body counted something it does not own.
        throw new Error(
          `Pane header count must be a non-negative integer, got ${meta.value}.`,
        );
      }
      requireNonEmpty(meta.unit, "Pane header count unit");
      return meta;
    case "Date": {
      // Validated here, once, so the projection — which parses this as a local
      // calendar day — has no failure branch. The round-trip rejects the
      // impossible days (`2026-02-30`, Feb 29 of a common year) that a
      // shape-only regex would wave through.
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(meta.iso);
      const year = Number(match?.[1]);
      const month = Number(match?.[2]);
      const day = Number(match?.[3]);
      const parsed = new Date(year, month - 1, day);
      if (
        parsed.getFullYear() !== year ||
        parsed.getMonth() !== month - 1 ||
        parsed.getDate() !== day
      ) {
        // justify-defect: the header can only render a real calendar day, so a
        // value that is not one is a producer bug, not a viewer-facing state.
        throw new Error(
          `Pane header date must be a date-only ISO calendar day, got ${JSON.stringify(meta.iso)}.`,
        );
      }
      return meta;
    }
  }
}

function validatedResourcePublication(
  publication: PaneResourceHeaderPublication,
): PaneResourceHeaderPublication {
  switch (publication.status) {
    case "Unavailable":
    case "Failed":
      return publication;
    case "Ready": {
      let authorsGroups = 0;
      for (const group of publication.creditGroups) {
        if (group.credits.length === 0) {
          // justify-defect: an empty group would project a bare role prefix
          // crediting nobody. Publishing zero groups is legitimate; publishing
          // a group that credits no one is not.
          throw new Error(
            `Pane header ${group.kind} credit group must list at least one credit.`,
          );
        }
        if (group.kind === "Authors") {
          authorsGroups += 1;
          if (authorsGroups > 1) {
            // justify-defect: authorship is one fact about a resource; two
            // groups mean two producers disagree about who wrote it.
            throw new Error(
              "Pane header may carry at most one Authors credit group.",
            );
          }
        } else {
          requireNonEmpty(group.label, "Pane header credit role label");
        }
        for (const credit of group.credits) {
          requireNonEmpty(credit.label, "Pane header credit label");
        }
      }
      return publication;
    }
  }
}

export function resolvePaneHeaderModel({
  currentRouteKey,
  routeHeader,
  paneLabel,
  paneLabelPending,
  publication,
}: ResolvePaneHeaderModelInput): PaneHeaderModel {
  // A publication stamped with another route key is an ordinary mid-navigation
  // race: the pane falls back to its route defaults rather than reading out the
  // previous route's facts.
  const accepted =
    publication?.routeKey === currentRouteKey ? publication.header : undefined;
  requireNonEmpty(paneLabel, "Pane label");

  switch (routeHeader.kind) {
    case "Section": {
      if (accepted && accepted.kind !== "Section") {
        // justify-defect: the route contract fixes the header kind, so a
        // current-route Resource publication means a body is publishing
        // against a contract it does not own.
        throw new Error(
          "Section pane route received a Resource header publication.",
        );
      }
      return {
        kind: "Section",
        title: paneLabel,
        titlePending: paneLabelPending,
        context: sectionContext(routeHeader, paneLabel),
        meta: validatedSectionMeta(accepted?.meta ?? { kind: "None" }),
      };
    }
    case "Resource": {
      requireNonEmpty(routeHeader.pendingLabel, "Resource pending label");
      if (!accepted) {
        return {
          kind: "Resource",
          title: paneLabel,
          resource: {
            status: "Pending",
            accessibleLabel: routeHeader.pendingLabel,
          },
        };
      }
      if (accepted.kind !== "Resource") {
        // justify-defect: see above — the contract, not the body, decides.
        throw new Error(
          "Resource pane route received a Section header publication.",
        );
      }
      return {
        kind: "Resource",
        title: paneLabel,
        resource: validatedResourcePublication(accepted.resource),
      };
    }
  }
}

/**
 * The pane landmark's accessible name: the exact title, plus the section it
 * sits under when that adds information. Never the metadata or credits — those
 * change while the user reads, and a landmark that renames itself is noise.
 */
export function paneHeaderAccessibleName(model: PaneHeaderModel): string {
  switch (model.kind) {
    case "Section":
      return model.context.kind === "Present"
        ? `${model.title} — ${model.context.value}`
        : model.title;
    case "Resource":
      return model.title;
  }
}
