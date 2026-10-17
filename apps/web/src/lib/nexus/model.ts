// The Nexus vocabulary: what a row is, where it leads, and which page the launcher shows.
import type { ComponentType } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { Schema } from "@/lib/api/wire";
import type { LibraryDestination } from "@/lib/libraries/api";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { PanePresentation } from "@/lib/workspace/presentations";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type {
  WorkspacePaneEntry,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";

export type NexusIcon = ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
export type NexusCommandId = `Nexus.Quick.${"Note" | "Page" | "Chat" | "Library" | "Import"}`;

export type NexusHistorySource = Schema<"NexusSelectionRecordRequest">["source"];
export type NexusRecent = Schema<"NexusHistoryRecentOut">;

export interface AddSeed {
  readonly kind: "Content";
  readonly initialDestinations: readonly LibraryDestination[];
  readonly initialUrlDraft?: string;
}

export type DailyPageLocator = { readonly kind: "Today" } | { readonly kind: "LocalDate"; readonly value: string };

/** A day opened as is, with a new empty row, or at the note a capture just added. */
export type MaterializedOpenDailyPageTarget = {
  readonly kind: "OpenDailyPage";
  readonly date: { readonly kind: "LocalDate"; readonly value: string };
  readonly entry:
    | { readonly kind: "View" }
    | { readonly kind: "AppendNote" }
    | { readonly kind: "FocusNote"; readonly noteBlockId: string };
};

/** Every navigation is an InternalHref; the rest open a tab, Today, the player, or a page. */
export type NexusTarget =
  | {
      readonly kind: "InternalHref";
      readonly href: string;
      readonly labelHint?: string;
      readonly secondaryActivation?: WorkspaceSecondaryActivation;
      readonly entry?: WorkspacePaneEntry;
    }
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

export interface NexusTargetActivation {
  readonly disposition: WorkspaceTargetDisposition;
}

export const PROGRAMMATIC_NEXUS_TARGET_ACTIVATION: NexusTargetActivation = {
  disposition: { kind: "Follow" },
};

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
  readonly parent?: { readonly key: string; readonly label: string };
  readonly action: NexusAction;
  readonly secondary?:
    | { readonly kind: "ResourceMenu"; readonly resourceRef: CanonicalResourceRef }
    | { readonly kind: "CloseTab"; readonly paneId: string };
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
  readonly presentation: PanePresentation;
  readonly current: boolean;
}

export type NexusRootMode = "Overview" | "Search";
export interface NexusRootOrigin {
  readonly mode: NexusRootMode;
  readonly control: string;
}

type CreateChoice = { readonly kind: "ChooseCreate"; readonly draft: string; readonly origin: NexusRootOrigin };

export type ReplayableSubmitState =
  | { readonly kind: "Ready" }
  | { readonly kind: "Running" }
  | { readonly kind: "Retryable"; readonly content: FeedbackContent };

export type NexusPage =
  | { readonly kind: "Root" }
  | CreateChoice
  | { readonly kind: "ChooseBrowse"; readonly query: string; readonly origin: NexusRootOrigin }
  | {
      readonly kind: "CreatePage";
      readonly pageId: string;
      readonly title: string;
      readonly activation: NexusTargetActivation;
      readonly submit: ReplayableSubmitState;
    }
  | {
      readonly kind: "CreateLibrary";
      readonly returnTo: CreateChoice | { readonly kind: "Root"; readonly origin: NexusRootOrigin };
      readonly libraryId: string;
      readonly name: string;
      readonly activation: NexusTargetActivation;
      readonly submit: ReplayableSubmitState;
    }
  | {
      readonly kind: "CaptureToday";
      readonly text: string;
      readonly noteId: string;
      readonly localDate: string;
      readonly activation: NexusTargetActivation;
      readonly submit: ReplayableSubmitState;
    }
  | { readonly kind: "Add"; readonly sessionId: string; readonly activation: NexusTargetActivation }
  | { readonly kind: "ManageTabs" };

export type NexusOpenIntent =
  | { readonly kind: "Root" }
  | { readonly kind: "Add"; readonly seed: AddSeed }
  | { readonly kind: "QuickAction"; readonly actionId: NexusCommandId };
