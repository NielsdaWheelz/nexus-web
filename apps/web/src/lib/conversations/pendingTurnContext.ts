/**
 * `PendingTurnContext` — the composer's one turn-context prop.
 *
 * `Conversation` owns launch intent parsing and
 * `usePendingReaderSelection` owns canonical preview hydration through the
 * reader-selection API. Their composition passes exactly one
 * `PendingTurnContext` to `ChatComposer`. Only the hydrated `ReaderHighlight`
 * variant is sendable. `Loading` and `LoadFailed` block send; `NonSendable` is
 * an authoritative forbidden/geometry-only/over-limit state. A missing
 * just-launched Highlight is projection drift — a reported route defect, not a
 * `NonSendable`.
 */

import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { ReaderHighlightChatIntent } from "./readerHighlightChatIntent";
import type { ReaderSelectionPreview } from "./readerSelection";

export type PendingTurnContext =
  | { kind: "Loading"; intent: ReaderHighlightChatIntent }
  | { kind: "ReaderHighlight"; preview: ReaderSelectionPreview }
  | { kind: "LoadFailed"; intent: ReaderHighlightChatIntent; error: FeedbackContent }
  | {
      kind: "NonSendable";
      intent: ReaderHighlightChatIntent;
      reason: "Forbidden" | "GeometryOnly" | "TooLarge";
    };
