import type { DestinationId } from "@/lib/navigation/destinations";
import type { NexusFindScope } from "@/lib/nexus/model";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { WorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";

export const SWITCHBOARD_FIND_SCOPES = [
  "All",
  "Media",
  "Notes",
  "Highlights",
  "Chats",
  "Libraries",
  "People",
] as const satisfies readonly NexusFindScope[];

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
