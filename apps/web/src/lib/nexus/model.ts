// The Nexus vocabulary: what a row is, where it leads, and which page the launcher shows.
import type { ComponentType } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { Schema } from "@/lib/api/wire";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";

export type NexusIcon = ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
export type NexusCommandId = `Nexus.Quick.${"Note" | "Page" | "Chat" | "Library" | "Import"}`;

export type NexusHistorySource = Schema<"NexusSelectionRecordRequest">["source"];
export type NexusRecent = Schema<"NexusHistoryRecentOut">;

export interface AddSeed {
  readonly kind: "Content";
  readonly initialFocus: "Url" | "File";
  readonly initialDestinations: readonly LibraryDestinationSelection[];
  readonly initialUrlDraft?: string;
}

export type DailyPageLocator = { readonly kind: "Today" } | { readonly kind: "LocalDate"; readonly value: string };

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

/** Every navigation is an InternalHref; the rest open a tab, Today, the player, or a page. */
export type NexusTarget =
  | { readonly kind: "InternalHref"; readonly href: string; readonly labelHint?: string }
  | { readonly kind: "PaneOpen"; readonly paneId: string }
  | {
      readonly kind: "OpenDailyPage";
      readonly date: DailyPageLocator;
      readonly entry:
        | { readonly kind: "View" }
        | { readonly kind: "AppendNote"; readonly initialText: string };
    }
  | { readonly kind: "ResumeCurrentPlayback" }
  | { readonly kind: "OpenAdd"; readonly seed: AddSeed }
  | { readonly kind: "CreatePage"; readonly titleDraft: string }
  | { readonly kind: "CreateLibrary"; readonly nameDraft: string }
  | { readonly kind: "ChooseCreate"; readonly initialDraft: string }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | { readonly kind: "ManageTabs" };

export type MaterializedNexusTarget =
  | Exclude<NexusTarget, { kind: "OpenDailyPage" }>
  | MaterializedOpenDailyPageTarget;

export interface NexusTargetActivation {
  readonly disposition: WorkspaceTargetDisposition;
  readonly modality: PaneNavigationModality;
}

export const PROGRAMMATIC_NEXUS_TARGET_ACTIVATION: NexusTargetActivation = {
  disposition: { kind: "Follow" },
  modality: "Programmatic",
};

export type RetainedTarget = Extract<MaterializedNexusTarget, { kind: "InternalHref" | "OpenDailyPage" }>;

export type NexusDispatchOutcome =
  | { readonly kind: "Accepted" }
  | { readonly kind: "DailyPageAccepted"; readonly activationId: string; readonly localDate: string }
  | { readonly kind: "Rejected"; readonly target: RetainedTarget }
  | { readonly kind: "Restricted" };

export type NexusAction =
  | { readonly kind: "Available"; readonly target: NexusTarget }
  | { readonly kind: "Unavailable"; readonly reason: string };

export type NexusRankTier = "ExplicitIntent" | "Exact" | "PrefixOrToken" | "CurrentContext" | "FuzzyOrSynonym" | "MetadataOrFullText";

export interface NexusRow {
  /** "Pane:<id>", "Destination:<id>", "Resource:<ref>", "QuickAction:<id>", …: identity and last tie-break. */
  readonly key: string;
  readonly label: string;
  readonly icon: NexusIcon;
  readonly type?: string;
  readonly detail?: string;
  readonly state?: "Current" | "Open" | "Minimized";
  readonly snippet?: readonly EmphasisSegment[];
  readonly shortcut?: string;
  readonly parent?: { readonly key: string; readonly label: string };
  readonly action: NexusAction;
  readonly menu?:
    | { readonly kind: "Resource"; readonly subject: ResourceActionSubject }
    | { readonly kind: "Tab"; readonly paneId: string };
  /** Present iff an accepted selection of this row is remembered in Nexus history. */
  readonly source?: NexusHistorySource;
  readonly rank: { readonly tier: NexusRankTier; readonly score: number; readonly frecency: number };
}

export interface NexusGroup {
  readonly id: "Open" | "Continue" | "Recent" | "QuickActions" | "Places" | "Results";
  readonly label: string;
  readonly rows: readonly NexusRow[];
}

export type NexusSource = "Openables" | "Owned";

export interface NexusPane {
  readonly id: string;
  readonly href: string;
  readonly visibility: "visible" | "minimized";
  readonly label: string;
  readonly current: boolean;
}

export type ReplayableSubmitState =
  | { readonly kind: "Ready" }
  | { readonly kind: "Running" }
  | { readonly kind: "Retryable"; readonly content: FeedbackContent };

export type TodayAppend = { readonly kind: "Available" } | { readonly kind: "Unavailable"; readonly reason: string };

/** A navigation the tab limit refused, kept so the user can make room and retry it. */
export interface Retained {
  readonly target: RetainedTarget;
  readonly activation: NexusTargetActivation;
  readonly completion: "Destination" | "Page" | "Library" | "Import";
}

export type NexusPage =
  | { readonly kind: "Root" }
  | { readonly kind: "ChooseCreate"; readonly draft: string }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | {
      readonly kind: "CreatePage";
      readonly pageId: string;
      readonly title: string;
      readonly activation: NexusTargetActivation;
      readonly submit: ReplayableSubmitState;
    }
  | {
      readonly kind: "CreateLibrary";
      readonly libraryId: string;
      readonly name: string;
      readonly activation: NexusTargetActivation;
      readonly submit: ReplayableSubmitState;
    }
  | { readonly kind: "Add"; readonly sessionId: string; readonly activation: NexusTargetActivation }
  | { readonly kind: "Blocked"; readonly retained: Retained }
  | { readonly kind: "ManageTabs"; readonly retained: Retained | null; readonly restoreBlocked: string | null }
  | { readonly kind: "Restricted" };

export type NexusOpenIntent =
  | { readonly kind: "Root" }
  | { readonly kind: "Add"; readonly seed: AddSeed }
  | { readonly kind: "QuickAction"; readonly actionId: NexusCommandId };
