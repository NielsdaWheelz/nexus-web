import type { ComponentType } from "react";
import type { Presence } from "@/lib/api/presence";
import type { LibraryDestinationSelection } from "@/lib/libraries/client";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { CanonicalResourceRef, ShareTarget } from "@/lib/sharing/types";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";

export type NexusIcon = ComponentType<{
  size?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export type NexusEntryKey =
  | { kind: "Pane"; paneId: string }
  | { kind: "Destination"; destinationId: string }
  | { kind: "Resource"; occurrenceRef: string }
  | { kind: "QuickAction"; actionId: NexusQuickActionId }
  | { kind: "ImportUrl"; normalizedUrl: string }
  | {
      kind: "Continuation";
      id: "Ask" | "SearchWeb" | "SeeAll";
    };

export type NexusRankTier =
  | "Exact"
  | "Prefix"
  | "Token"
  | "Alias"
  | "OpenContext"
  | "FuzzyTitle"
  | "Metadata"
  | "FullText";

export type NexusHistorySource =
  | "Static"
  | "Workspace"
  | "Recent"
  | "Oracle"
  | "Search"
  | "Ai";

export type NexusSnippetSegment = {
  readonly text: string;
  readonly emphasized: boolean;
};

export type AddSeed =
  | {
      kind: "Content";
      initialFocus: "Url" | "File";
      initialDestinations: readonly LibraryDestinationSelection[];
      initialUrlDraft?: string;
    }
  | {
      kind: "Opml";
      initialDestinations: readonly LibraryDestinationSelection[];
    };

export interface NexusTargetActivation {
  readonly disposition: WorkspaceTargetDisposition;
  readonly modality: PaneNavigationModality;
}

export type NexusTarget =
  | {
      kind: "InternalHref";
      href: string;
      labelHint?: string;
    }
  | {
      kind: "ResourceOpen";
      subject: ResourceActionSubject;
      labelHint?: string;
    }
  | { kind: "ResourceShare"; subject: ResourceActionSubject }
  | { kind: "ResourceChat"; ref: CanonicalResourceRef }
  | { kind: "Ask"; text: string }
  | { kind: "QueueAdd"; mediaId: string; title: string }
  | { kind: "NewConversation"; initialDraft?: string }
  | { kind: "Share"; target: ShareTarget }
  | { kind: "CopyExternalLink"; href: string }
  | { kind: "PaneOpen"; paneId: string }
  | { kind: "PaneClose"; paneId: string }
  | { kind: "OpenToday" }
  | { kind: "OpenAdd"; seed: AddSeed }
  | { kind: "OpenTodayCapture" }
  | { kind: "CreatePage" }
  | { kind: "CreateLibrary" }
  | { kind: "PodcastDiscovery" }
  | { kind: "OpenWebSearch"; query: string };

export interface NexusAction {
  readonly id: string;
  readonly label: string;
  readonly icon: NexusIcon;
  readonly target: NexusTarget;
}

export interface NexusEntry {
  readonly key: NexusEntryKey;
  /** Typed observability provenance. Never infer this from display copy. */
  readonly historySource: NexusHistorySource;
  readonly label: string;
  readonly typeLabel?: string;
  readonly metadata?: string;
  readonly snippetSegments?: readonly NexusSnippetSegment[];
  readonly icon: NexusIcon;
  readonly openState?: "Active" | "Open" | "Minimized";
  /**
   * Canonical presentation ownership. The parent may be an actionable entry
   * in this projection or a non-actionable grouping identity.
   */
  readonly parent?: {
    readonly key: NexusEntryKey;
    readonly label: string;
  };
  readonly primaryAction: NexusAction;
  readonly secondaryActions: readonly NexusAction[];
  readonly rank: {
    readonly tier: NexusRankTier;
    readonly score: number;
    readonly frecency: number;
  };
}

export type NexusQuickActionId =
  | "Nexus.Quick.Note"
  | "Nexus.Quick.Page"
  | "Nexus.Quick.Chat"
  | "Nexus.Quick.Library"
  | "Nexus.Quick.Import"
  | "Nexus.Quick.Podcast";

export type NexusQuickActionTarget =
  | { kind: "TodayCapture" }
  | { kind: "CreatePage" }
  | { kind: "CreateChat" }
  | { kind: "CreateLibrary" }
  | { kind: "Import"; seed: AddSeed }
  | { kind: "PodcastDiscovery" };

export interface NexusQuickAction {
  readonly id: NexusQuickActionId;
  readonly label: string;
  readonly icon: NexusIcon;
  readonly keywords: readonly string[];
  readonly category: "Create" | "Acquire";
  readonly target: NexusQuickActionTarget;
}

export type NexusFindScope =
  | "All"
  | "Media"
  | "Notes"
  | "Highlights"
  | "Chats"
  | "Libraries"
  | "People";

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
  readonly target: WorkspaceTarget;
  readonly activation: NexusTargetActivation;
  readonly source:
    | "Find"
    | "Place"
    | "TodayCapture"
    | "Page"
    | "Chat"
    | "Library"
    | "Import"
    | "Podcast";
  readonly completion: Presence<CommittedWorkflow>;
  readonly returnTo:
    | { kind: "Root" }
    | { kind: "Find"; query: string; scope: NexusFindScope };
}

export type NexusSourceStatus =
  | "Idle"
  | "Loading"
  | "Ready"
  | "RetryableFailure";

export type NexusPage =
  | { kind: "Root" }
  | { kind: "Find"; query: string; scope: NexusFindScope }
  | {
      kind: "Actions";
      entry: NexusEntry;
      actions: readonly NexusAction[];
    }
  | {
      kind: "WebSearch";
      query: string;
      status: NexusSourceStatus;
    }
  | {
      kind: "TodayCapture";
      sessionId: string;
      activation: NexusTargetActivation;
    }
  | {
      kind: "CreatePage";
      pageId: string;
      submit: ReplayableSubmitState;
      activation: NexusTargetActivation;
    }
  | {
      kind: "CreateLibrary";
      nameDraft: string;
      libraryId: string;
      submit: ReplayableSubmitState;
      activation: NexusTargetActivation;
    }
  | {
      kind: "Add";
      sessionId: string;
      activation: NexusTargetActivation;
    }
  | {
      kind: "PodcastDiscovery";
      query: string;
      sessionId: string;
      activation: NexusTargetActivation;
    }
  | { kind: "ActivationBlocked"; retained: RetainedActivation }
  | { kind: "ManageTabs"; retained: RetainedActivation };

export type NexusOpenIntent =
  | { kind: "Root" }
  | { kind: "Add"; seed: AddSeed }
  | { kind: "QuickAction"; actionId: NexusQuickActionId }
  | { kind: "WebSearch"; query: string };
