// The Nexus vocabulary: what a row is, where it leads, how the list holds, and which page the launcher shows.
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

/** Law 4's tiers, strongest first. */
export type RankTier = "ExplicitIntent" | "Latched" | "Exact" | "PrefixOrToken" | "Abbreviation" | "Substring" | "Lexical" | "Semantic";
export type NexusStream = "Navigation" | "Local" | "Recent" | "Resources" | "Saved" | "Passages";
/** `usages[query_normalized][canonical href]`; the untyped aggregate is `""`. */
export type UsageMap = Schema<"NexusUsageMapOut">["usages"];

export interface NexusRow {
  /** "Pane:<id>", "Destination:<id>", "Resource:<ref>", "QuickAction:<id>", "Recent:<target>", "Continuation:<id>", …: identity and last tie-break. */
  readonly key: string;
  readonly localMatch: LocalMatch | null;
  readonly label: string;
  readonly icon: NexusIcon;
  /** The facts line's byline or reason: contributors, a source, a state word. */
  readonly detail?: string;
  /** Bylines a query may match as Substring. */
  readonly keywords?: readonly string[];
  readonly state?: "Current" | "Minimized";
  readonly item?: Schema<"ResourceItemOut">;
  readonly match?: Schema<"SearchMatchOut"> | null;
  readonly matchMethod?: "lexical" | "semantic" | null;
  readonly matchingPassage?: Schema<"SearchOccurrenceOut"> | null;
  readonly action: NexusAction;
  readonly secondary?:
    | { readonly kind: "TargetMenu"; readonly resourceRef: CanonicalResourceRef | null; readonly closePanes: readonly { readonly id: string; readonly label: string }[] }
    | { readonly kind: "ClosePane"; readonly paneId: string };
  /** Whether an accepted selection of this row contributes to server selection ranking. */
  readonly learns_selection?: boolean;
  readonly recentEntry?: RecentEntry;
  /** The raw destination; `rank.canonicalHref` derives the identity the latch and frecency key on. */
  readonly href: string | null;
  /** Matched by content only; released on keystroke. */
  readonly evidence: boolean;
  readonly frecency: number;
  /** Newer is larger; the comparator's second tie-break. */
  readonly recency: number;
  readonly rank: { readonly tier: RankTier; readonly stream: NexusStream };
}

export interface NexusGroup {
  readonly id: "Here" | "Open" | "Recent" | "QuickActions" | "Results" | "Continuations";
  readonly label: string;
  readonly rows: readonly NexusRow[];
}

/** A query's list: the held band, then the arriving band, and what enter fires. */
export interface NexusList {
  readonly identity: string;
  readonly rows: readonly NexusRow[];
  /** rows[0..held) are the held band. */
  readonly held: number;
  readonly armed: string | null;
  readonly armedAt: number;
  readonly deliberate: boolean;
  /** The row armed before the latest arming, only while it is still in rows. */
  readonly previous: string | null;
  readonly paintedAt: number;
}

export type FireTarget = { readonly kind: "Fire"; readonly key: string } | { readonly kind: "Wait"; readonly until: number } | { readonly kind: "None" };

/** The verb rail over one row: which row, the focused descriptor id and the typed filter. */
export type Rail = { readonly key: string; readonly focus: string | null; readonly filter: string } | null;

export type NexusSource = "Direct" | "Lexical" | "Hybrid" | "Reference";

export interface NexusPane {
  readonly id: string;
  readonly href: string;
  readonly resourceRef: string | null;
  readonly visibility: "visible" | "minimized";
  readonly presentation: PanePresentation;
  readonly current: boolean;
}

export type NexusRootMode = "Blank" | "Typed";
export interface NexusRootOrigin {
  readonly mode: NexusRootMode;
  readonly control: string;
}
/** The palette as the Add page left it; null on the page means it was opened from outside. */
export type NexusImportOrigin = NexusRootOrigin & { readonly query: string };

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
  | { readonly kind: "Add"; readonly sessionId: string; readonly origin: NexusImportOrigin | null };

export type NexusOpenIntent =
  | { readonly kind: "Root" }
  | { readonly kind: "Add"; readonly seed: AddSeed }
  | { readonly kind: "QuickAction"; readonly actionId: NexusCommandId };
