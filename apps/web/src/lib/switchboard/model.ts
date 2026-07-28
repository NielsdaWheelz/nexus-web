import type { Presence } from "@/lib/api/presence";
import type { DestinationId } from "@/lib/navigation/destinations";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import type { WorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import type { LauncherAction, LauncherItem } from "@/lib/launcher/model";

export type SwitchboardFindScope =
  | "All"
  | "Media"
  | "Notes"
  | "Highlights"
  | "Chats"
  | "Libraries"
  | "People";

export const SWITCHBOARD_FIND_SCOPES = [
  "All",
  "Media",
  "Notes",
  "Highlights",
  "Chats",
  "Libraries",
  "People",
] as const satisfies readonly SwitchboardFindScope[];

export type SwitchboardItem =
  | {
      kind: "OpenPane";
      paneId: string;
      activationRouteId: WorkspaceActivationRouteId;
    }
  | { kind: "ClosedPane"; paneId: string }
  | { kind: "Destination"; destinationId: DestinationId }
  | {
      kind: "Resource";
      occurrenceRef: string;
      ownerRef: string;
      activationRouteId: WorkspaceActivationRouteId;
      subject: ResourceActionSubject;
      label: string;
      summary: string;
      match: "Exact" | "Metadata" | "Deep";
    };

export type ReplayableSubmitState =
  | { kind: "Ready" }
  | { kind: "Running" }
  | { kind: "Retryable"; message: string };

export type CommittedWorkflow =
  | { kind: "TodayCapture"; replayId: string }
  | { kind: "Page"; replayId: string }
  | { kind: "Library"; replayId: string }
  | { kind: "Import"; replayId: string }
  | { kind: "PodcastSubscription"; replayId: string };

export interface RetainedActivation {
  target: WorkspaceTarget;
  source:
    | "Find"
    | "Place"
    | "TodayCapture"
    | "Page"
    | "Chat"
    | "Library"
    | "Import"
    | "Podcast";
  completion: Presence<CommittedWorkflow>;
  returnTo:
    | { kind: "Root" }
    | { kind: "Find"; query: string; scope: SwitchboardFindScope };
}

export type LauncherPage =
  | { kind: "Root" }
  | { kind: "Find"; query: string; scope: SwitchboardFindScope }
  | {
      kind: "Actions";
      item: LauncherItem;
      actions: LauncherAction[];
    }
  | { kind: "TodayCapture"; sessionId: string }
  | { kind: "CreatePage"; pageId: string; submit: ReplayableSubmitState }
  | {
      kind: "CreateLibrary";
      nameDraft: string;
      libraryId: string;
      submit: ReplayableSubmitState;
    }
  | { kind: "Add"; sessionId: string }
  | { kind: "PodcastDiscovery"; query: string; sessionId: string }
  | { kind: "ActivationBlocked"; retained: RetainedActivation }
  | { kind: "ManageTabs"; retained: RetainedActivation };

export interface SwitchboardRowModel {
  id: string;
  /**
   * Group headings are presentation-only. Canonical search supplies an owner
   * ref, but not an owner activation; keeping `item` absent prevents the
   * client from manufacturing an actionable owner by rewriting a deep
   * occurrence route.
   */
  item: SwitchboardItem | null;
  label: string;
  metadata: string;
  recent: boolean;
  parentId?: string;
}

export function switchboardItemId(item: SwitchboardItem): string {
  switch (item.kind) {
    case "OpenPane":
      return `OpenPane:${item.paneId}`;
    case "ClosedPane":
      return `ClosedPane:${item.paneId}`;
    case "Destination":
      return `Destination:${item.destinationId}`;
    case "Resource":
      return `Resource:${item.occurrenceRef}`;
  }
}
