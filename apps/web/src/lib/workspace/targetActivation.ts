// Where a link lands: one pure planner over the open panes. The store
// executes the plan; callers never choose or create panes themselves.
import { matchWorkspaceTargetHref, resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { SourceArrivalTarget } from "@/lib/resources/sourceTarget";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import type { WorkspaceState } from "@/lib/workspace/model";
import type { Selection } from "@/lib/chat/wire";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export interface WorkspaceTarget {
  href: string;
  labelHint?: string;
  secondaryActivation?: WorkspaceSecondaryActivation;
}

export type WorkspaceTargetDisposition =
  | { kind: "Follow" }
  | { kind: "Fork" };

/**
 * What the landing pane does once it is ready (contract: campaign
 * notes/activation-contract.md). The href picks the pane; ids are plain uuids.
 * The consuming pane claims an entry before acting and owns every outcome.
 */
export type WorkspacePaneEntry =
  | { readonly kind: "ComposeChat"; readonly text: string }
  | { readonly kind: "ComposePage"; readonly title: string }
  | { readonly kind: "InspectSource"; readonly target: SourceArrivalTarget }
  // a fresh chat pane: review the complete reader question with its observed model.
  | { readonly kind: "ComposeReaderQuestion"; readonly text: string; readonly selection: Selection | null }
  // page or daily pane: a new empty row at the end, focused (a latent day: its draft)
  | { readonly kind: "AppendNote" }
  // page or daily pane: the caret at the end of that note's row
  | { readonly kind: "FocusNote"; readonly noteBlockId: string }
  // page pane: focus the title
  | { readonly kind: "EditPageTitle"; readonly pageId: string }
  // note pane: focus the body
  | { readonly kind: "EditNoteBody"; readonly noteBlockId: string }
  // media pane: one highlight; a null note block adds a note
  | { readonly kind: "EditHighlight"; readonly highlightId: string }
  | {
      readonly kind: "EditHighlightNote";
      readonly highlightId: string;
      readonly noteBlockId: string | null;
    }
  | { readonly kind: "EditHighlightBounds"; readonly highlightId: string }
  | { readonly kind: "DeleteHighlight"; readonly highlightId: string }
  // chat pane: one message of the loaded transcript
  | {
      readonly kind: "ForkMessage" | "DeleteMessage";
      readonly messageId: string;
    };

export interface WorkspaceTargetActivationRequest {
  originPaneId: string;
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
  /** Replace a provisional origin only when Follow navigates that origin. */
  originHistory?: "replace";
  /** Hand `entry` to the exact visit the target lands on. */
  entry?: WorkspacePaneEntry;
  /** Source input actually retired by this transition. */
  discardOwnerIds?: readonly string[];
}

export interface PaneEntryDelivery {
  activationId: string;
  paneId: string;
  visitId: string;
  entry: WorkspacePaneEntry;
}

/** A daily page pane's identity, published by its body (under either href). */
export interface PaneDailyPage {
  localDate: string;
  pageId: string | null;
}

type Landed =
  | "Unchanged"
  | "ActivatedExisting"
  | "NavigatedOrigin"
  | "NavigatedExisting"
  | "CreatedPane";
export type WorkspaceTargetActivationResult = { kind: Landed; paneId: string } | { kind: "Cancelled" };

export function paneEntryWorkOwnerId(delivery: PaneEntryDelivery): string {
  return JSON.stringify(["pane-entry", delivery.activationId]);
}
/** CreatedPane names the origin; the store mints the new pane after it. */
export type WorkspaceTargetPlan = { kind: Landed; paneId: string; href: string };

/**
 * An open pane matches on resource and material view, or as the same daily
 * page under its other href. Preference: origin, first visible, first. Fork
 * always creates; without a match Follow navigates the origin. Creation never
 * evicts an existing pane.
 */
export function planWorkspaceTarget(
  state: WorkspaceState,
  dailyPages: ReadonlyMap<string, { routeKey: string; value: PaneDailyPage }>,
  request: WorkspaceTargetActivationRequest,
): WorkspaceTargetPlan {
  const href = normalizeWorkspaceHref(request.target.href);
  const origin = state.panes.find((pane) => pane.id === request.originPaneId);
  if (!href || !origin) {
    // justify-defect: callers pass same-origin hrefs from a live pane.
    throw new Error(`Invalid workspace target: ${request.target.href}`);
  }
  const target = resolvePaneRouteModel(href);
  const sameDay = (paneId: string, route: { id: string; routeKey: string }) => {
    const daily = dailyPages.get(paneId);
    if (route.id === target.id || daily?.routeKey !== route.routeKey) return false;
    return target.id === "dailyDate"
      ? daily.value.localDate === target.params.localDate
      : target.id === "page" && daily.value.pageId === target.params.pageId;
  };
  const matches = state.panes.flatMap((pane) => {
    const route = resolvePaneRouteModel(pane.current_visit.href);
    const landingHref = matchWorkspaceTargetHref(pane.current_visit.href, href);
    if (landingHref !== null) return [{ pane, href: landingHref }];
    return sameDay(pane.id, route) ? [{ pane, href: pane.current_visit.href }] : [];
  });
  const match =
    matches.find((m) => m.pane === origin) ??
    matches.find((m) => m.pane.visibility === "visible") ??
    matches[0];
  const create: WorkspaceTargetPlan = { kind: "CreatedPane", paneId: origin.id, href };
  if (request.disposition.kind === "Fork") return create;
  if (!match) {
    return { kind: "NavigatedOrigin", paneId: origin.id, href };
  }
  const { pane } = match;
  if (pane.current_visit.href !== match.href) {
    return { kind: "NavigatedExisting", paneId: pane.id, href: match.href };
  }
  const kind = pane === origin ? "Unchanged" : "ActivatedExisting";
  return { kind, paneId: pane.id, href: match.href };
}
