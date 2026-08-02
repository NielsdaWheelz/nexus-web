import type { ComponentType } from "react";
import type { Presence } from "@/lib/api/presence";
import type { LibraryDestinationSelection } from "@/lib/libraries/client";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { CanonicalResourceRef, ShareTarget } from "@/lib/sharing/types";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";

export type NexusIcon = ComponentType<{
  size?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export type NexusCommandId =
  | "Nexus.Quick.Note"
  | "Nexus.Quick.Page"
  | "Nexus.Quick.Chat"
  | "Nexus.Quick.Library"
  | "Nexus.Quick.Import";

export type NexusEntryKey =
  | { readonly kind: "Pane"; readonly paneId: string }
  | { readonly kind: "PaneSearch" }
  | {
      readonly kind: "Destination";
      readonly destinationId: string;
    }
  | {
      readonly kind: "Resource";
      readonly occurrenceRef: string;
    }
  | {
      readonly kind: "QuickAction";
      readonly actionId: NexusCommandId;
    }
  | {
      readonly kind: "ImportUrl";
      readonly normalizedUrl: string;
    }
  | {
      readonly kind: "Intent";
      readonly id:
        | "Ask"
        | "ChooseBrowse"
        | "Browse.WebArticle"
        | "Browse.Podcast"
        | "Browse.Video"
        | "Browse.Epub";
    }
  | { readonly kind: "ManageTabs" }
  | {
      readonly kind: "Continuation";
      readonly id: "Ask" | "AddToToday" | "Browse" | "Create" | "SeeAll";
    };

export function nexusEntryKeyValue(key: NexusEntryKey): string {
  switch (key.kind) {
    case "Pane":
      return `Pane:${key.paneId}`;
    case "PaneSearch":
      return "PaneSearch";
    case "Destination":
      return `Destination:${key.destinationId}`;
    case "Resource":
      return `Resource:${key.occurrenceRef}`;
    case "QuickAction":
      return `QuickAction:${key.actionId}`;
    case "ImportUrl":
      return `ImportUrl:${key.normalizedUrl}`;
    case "Intent":
      return `Intent:${key.id}`;
    case "ManageTabs":
      return "ManageTabs";
    case "Continuation":
      return `Continuation:${key.id}`;
  }
}

export type NexusRankTier =
  | "ExplicitIntent"
  | "Exact"
  | "PrefixOrToken"
  | "CurrentContext"
  | "FuzzyOrSynonym"
  | "MetadataOrFullText";

export type NexusHistorySource =
  | "Static"
  | "Workspace"
  | "Recent"
  | "Oracle"
  | "Search"
  | "Ai";

export type AddSeed =
  | {
      readonly kind: "Content";
      readonly initialFocus: "Url" | "File";
      readonly initialDestinations: readonly LibraryDestinationSelection[];
      readonly initialUrlDraft?: string;
    }
  | {
      readonly kind: "Opml";
      readonly initialDestinations: readonly LibraryDestinationSelection[];
    };

export interface NexusTargetActivation {
  readonly disposition: WorkspaceTargetDisposition;
  readonly modality: PaneNavigationModality;
}

export type DailyPageLocator =
  | { readonly kind: "Today" }
  | { readonly kind: "LocalDate"; readonly value: string };

export type MaterializedOpenDailyPageTarget = {
  readonly kind: "OpenDailyPage";
  readonly date: { readonly kind: "LocalDate"; readonly value: string };
  readonly entry:
    | { readonly kind: "View" }
    | {
        readonly kind: "AppendNote";
        readonly initialText: string;
        readonly noteId: string;
        readonly clientMutationId: string;
      };
};

export type NexusTarget =
  | {
      readonly kind: "InternalHref";
      readonly href: string;
      readonly labelHint?: string;
    }
  | {
      readonly kind: "ResourceOpen";
      readonly subject: ResourceActionSubject;
      readonly labelHint?: string;
    }
  | { readonly kind: "ResourceShare"; readonly subject: ResourceActionSubject }
  | { readonly kind: "ResourceChat"; readonly ref: CanonicalResourceRef }
  | { readonly kind: "Ask"; readonly text: string }
  | {
      readonly kind: "QueueAdd";
      readonly mediaId: string;
      readonly title: string;
    }
  | { readonly kind: "NewConversation"; readonly initialDraft: string }
  | { readonly kind: "Share"; readonly target: ShareTarget }
  | { readonly kind: "CopyExternalLink"; readonly href: string }
  | { readonly kind: "PaneOpen"; readonly paneId: string }
  | { readonly kind: "PaneClose"; readonly paneId: string }
  | { readonly kind: "PaneSearch" }
  | {
      readonly kind: "OpenDailyPage";
      readonly date: DailyPageLocator;
      readonly entry:
        | { readonly kind: "View" }
        | { readonly kind: "AppendNote"; readonly initialText: string };
    }
  | { readonly kind: "OpenAdd"; readonly seed: AddSeed }
  | { readonly kind: "CreatePage"; readonly titleDraft: string }
  | { readonly kind: "CreateLibrary"; readonly nameDraft: string }
  | { readonly kind: "ChooseCreate"; readonly initialDraft: string }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | {
      readonly kind: "Browse";
      readonly query: string;
      readonly browseKind: "WebArticle" | "Podcast" | "Video" | "Epub";
    }
  | { readonly kind: "ResumeCurrentPlayback" }
  | { readonly kind: "ManageTabs" };

export type NexusActionAvailability =
  | { readonly kind: "Available"; readonly target: NexusTarget }
  | { readonly kind: "Unavailable"; readonly reason: string };

export interface NexusAction {
  readonly id: string;
  readonly label: string;
  readonly icon: NexusIcon;
  readonly activation:
    | { readonly kind: "Standard" }
    | { readonly kind: "DailyTextHandoff" };
  readonly availability: NexusActionAvailability;
}

export interface NexusEntry {
  readonly key: NexusEntryKey;
  /** Typed observability provenance. Never infer this from display copy. */
  readonly historySource: NexusHistorySource;
  readonly label: string;
  readonly shortcutHint?: string;
  readonly typeLabel?: string;
  readonly metadata?: string;
  readonly snippetSegments?: readonly EmphasisSegment[];
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

export interface NexusCommand {
  readonly id: NexusCommandId;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly category: "Create" | "Acquire";
  readonly icon: NexusIcon;
  readonly activation: NexusAction["activation"];
  readonly shortcut:
    | { readonly kind: "None" }
    | {
        readonly kind: "Keybinding";
        readonly actionId: NexusCommandId;
      };
  target(input: { readonly argument: string }): NexusTarget;
}

export type NexusSurface = "Desktop" | "Mobile";

export type NexusSectionId =
  | "Open"
  | "Continue"
  | "Recent"
  | "QuickActions"
  | "Places"
  | "Results"
  | "QueryActions";

export interface NexusGroup {
  readonly id: NexusSectionId;
  readonly label: string;
  readonly layout: "Flow" | "CompactRail" | "PinnedBelowInput";
  readonly entries: readonly NexusEntry[];
}

export interface NexusProjection {
  readonly surface: NexusSurface;
  readonly groups: readonly NexusGroup[];
  readonly activeKey: NexusEntryKey | null;
}

export interface NexusFeedbackContent {
  readonly tone: "Neutral" | "Info" | "Success" | "Warning" | "Danger";
  readonly title: string;
  readonly message?: string;
  readonly requestId?: string;
}

export type FrozenNexusTarget =
  | Exclude<NexusTarget, { kind: "OpenDailyPage" }>
  | MaterializedOpenDailyPageTarget;

export type ReplayableSubmitState =
  | { readonly kind: "Ready" }
  | { readonly kind: "Running" }
  | {
      readonly kind: "Retryable";
      readonly content: NexusFeedbackContent;
    };

export type CommittedWorkflow =
  | { readonly kind: "Page"; readonly replayId: string }
  | { readonly kind: "Library"; readonly replayId: string }
  | { readonly kind: "Import"; readonly replayId: string };

export type RetainedNexusTarget =
  | Extract<NexusTarget, { kind: "InternalHref" }>
  | MaterializedOpenDailyPageTarget;

export function retainedNexusTargetLabel(target: RetainedNexusTarget): string {
  switch (target.kind) {
    case "InternalHref":
      return target.labelHint ?? target.href;
    case "OpenDailyPage":
      return target.entry.kind === "AppendNote" ? "Quick Note" : "Today";
  }
}

export type NexusReturnPoint = {
  readonly kind: "Root";
  readonly query: string;
  readonly activeKey: NexusEntryKey | null;
};

export type RetainedActivationSource =
  | "Result"
  | "Place"
  | "QuickAction"
  | "Page"
  | "Chat"
  | "Library"
  | "Import";

export interface RetainedActivation {
  readonly target: RetainedNexusTarget;
  readonly activation: NexusTargetActivation;
  readonly source: RetainedActivationSource;
  readonly completion: Presence<CommittedWorkflow>;
  readonly returnTo: NexusReturnPoint;
}

export type ManageTabsOrigin =
  | { readonly kind: "Direct" }
  | { readonly kind: "Recovery"; readonly retained: RetainedActivation };

export type NexusPage =
  | { readonly kind: "Root" }
  | { readonly kind: "UnsupportedLink" }
  | {
      readonly kind: "CommandFailed";
      readonly content: NexusFeedbackContent;
      readonly target: FrozenNexusTarget;
      readonly activation: NexusTargetActivation;
    }
  | {
      readonly kind: "OperationBlocked";
      readonly title: string;
      readonly message?: string;
      readonly manualValue?: string;
      readonly retry: {
        readonly target: Extract<NexusTarget, { kind: "CopyExternalLink" }>;
        readonly activation: NexusTargetActivation;
      } | null;
    }
  | { readonly kind: "EntryActions"; readonly entry: NexusEntry }
  | { readonly kind: "ChooseCreate"; readonly initialDraft: string }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | { readonly kind: "ManageTabs"; readonly origin: ManageTabsOrigin }
  | {
      readonly kind: "CreatePage";
      readonly titleDraft: string;
      readonly pageId: string;
      readonly submit: ReplayableSubmitState;
      readonly activation: NexusTargetActivation;
    }
  | {
      readonly kind: "CreateLibrary";
      readonly nameDraft: string;
      readonly libraryId: string;
      readonly submit: ReplayableSubmitState;
      readonly activation: NexusTargetActivation;
    }
  | {
      readonly kind: "Add";
      readonly sessionId: string;
      readonly activation: NexusTargetActivation;
    }
  | { readonly kind: "ActivationBlocked"; readonly retained: RetainedActivation };

export type NexusOpenIntent =
  | { readonly kind: "Root" }
  | { readonly kind: "Add"; readonly seed: AddSeed }
  | { readonly kind: "QuickAction"; readonly actionId: NexusCommandId }
  | { readonly kind: "UnsupportedLink" };
