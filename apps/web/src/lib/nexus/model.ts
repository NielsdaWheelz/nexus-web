// The Nexus vocabulary: what a row is, where it leads, and which page the launcher shows.
import type { ComponentType } from "react";
import type { RecentEntry } from "@/lib/recent/model";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { LocalMatch } from "@/lib/search/localSearch";
import type { Schema } from "@/lib/api/wire";
import type { LibraryDestination } from "@/lib/libraries/api";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { PanePresentation } from "@/lib/workspace/presentations";
import type {
  WorkspacePaneEntry,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";

export type NexusIcon = ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
export type NexusCommandId = `Nexus.Quick.${"Note" | "Page" | "Chat" | "Library" | "Import" | "Browse"}`;


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

/** Every navigation is an InternalHref; the rest open a pane, Today, the player, or a page. */
export type NexusTarget =
  | { readonly kind: "Resource"; readonly activation: Schema<"ResourceActivationOut">; readonly label: string }
  | {
      readonly kind: "InternalHref";
      readonly href: string;
      readonly labelHint?: string;
      readonly secondaryActivation?: WorkspaceSecondaryActivation;
      readonly entry?: WorkspacePaneEntry;
    }
  | { readonly kind: "PaneOpen"; readonly paneId: string }
  | {
      readonly kind: "OpenAcceptedSource";
      readonly sourceAttemptId: string;
      readonly label: string;
      readonly destination: "import" | "media";
    }
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
  | { readonly kind: "UseText"; readonly text: string };

export interface NexusTargetActivation {
  readonly disposition: WorkspaceTargetDisposition;
}

export const PROGRAMMATIC_NEXUS_TARGET_ACTIVATION: NexusTargetActivation = {
  disposition: { kind: "Follow" },
};

export type NexusAction =
  | { readonly kind: "Available"; readonly target: NexusTarget }
  | { readonly kind: "Unavailable"; readonly reason: string };

export type NexusRankTier = "ExplicitIntent" | "Exact" | "PrefixOrToken" | "Substring" | "Lexical" | "FuzzyOrSynonym" | "Semantic";

export interface NexusRow {
  /** "Pane:<id>", "Destination:<id>", "Resource:<ref>", "QuickAction:<id>", …: identity and last tie-break. */
  readonly key: string;
  readonly localMatch: LocalMatch | null;
  readonly label: string;
  readonly icon: NexusIcon;
  readonly type?: string;
  readonly detail?: string;
  readonly state?: "Current" | "Minimized";
  readonly item?: Schema<"ResourceItemOut">;
  readonly match?: Schema<"SearchMatchOut"> | null;
  readonly matchMethod?: "lexical" | "semantic" | null;
  readonly matchingPassage?: Schema<"SearchOccurrenceOut"> | null;
  readonly action: NexusAction;
  readonly secondary?:
    | { readonly kind: "TargetMenu"; readonly resourceRef: CanonicalResourceRef | null; readonly closePanes: readonly { readonly id: string; readonly label: string }[] }
    | { readonly kind: "ClosePane"; readonly paneId: string };
  /** Present iff an accepted selection of this row is remembered in Nexus history. */
  readonly learns_selection?: boolean;
  readonly recentEntry?: RecentEntry;
  readonly rank: { readonly stream: "Navigation" | "Local" | "Resources" | "Saved" | "Passages"; readonly tier: NexusRankTier; readonly score: number; readonly frecency: number };
}

export interface NexusGroup {
  readonly id: "Open" | "Continue" | "Recent" | "QuickActions" | "Places" | "Results" | "Continuations";
  readonly label: string;
  readonly rows: readonly NexusRow[];
}

export type NexusSource = "Direct" | "Lexical" | "Hybrid" | "Reference";

export interface NexusPane {
  readonly id: string;
  readonly href: string;
  readonly resourceRef: string | null;
  readonly visibility: "visible" | "minimized";
  readonly presentation: PanePresentation;
  readonly current: boolean;
}

export type NexusRootMode = "Overview" | "Search" | "NewPane";
export interface NexusRootOrigin {
  readonly mode: NexusRootMode;
  readonly control: string;
}

export type UseTextPage = { readonly kind: "UseText"; readonly text: string; readonly origin: NexusRootOrigin; readonly activation: NexusTargetActivation };
export type ChoiceReturn = { readonly kind: "Root"; readonly origin: NexusRootOrigin } | UseTextPage;
type CreateChoice = { readonly kind: "ChooseCreate"; readonly draft: string; readonly returnTo: ChoiceReturn; readonly activation: NexusTargetActivation };

export type ReplayableSubmitState =
  | { readonly kind: "Ready" }
  | { readonly kind: "Acknowledged"; readonly content: FeedbackContent }
  | { readonly kind: "Running"; readonly unconfirmed: boolean; readonly content?: FeedbackContent }
  | { readonly kind: "Retryable"; readonly unconfirmed: boolean; readonly content: FeedbackContent };

export type NexusPage =
  | { readonly kind: "Root" }
  | UseTextPage
  | CreateChoice
  | { readonly kind: "ChooseBrowse"; readonly query: string; readonly returnTo: ChoiceReturn; readonly activation: NexusTargetActivation }
  | {
      readonly kind: "CreateLibrary";
      readonly returnTo: CreateChoice | ChoiceReturn;
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
      readonly origin: NexusRootOrigin;
      readonly activation: NexusTargetActivation;
      readonly submit: ReplayableSubmitState;
    }
  | { readonly kind: "Add"; readonly sessionId: string };

export type NexusOpenIntent =
  | { readonly kind: "Root" }
  | { readonly kind: "Add"; readonly seed: AddSeed }
  | { readonly kind: "QuickAction"; readonly actionId: NexusCommandId };
