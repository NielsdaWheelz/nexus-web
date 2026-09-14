"use client";

import type { ReactNode } from "react";
import FeatureErrorBoundary from "@/components/feedback/FeatureErrorBoundary";
import { FeedbackNotice } from "@/components/feedback/Feedback";

export interface ReaderContentDefect {
  readonly key: string;
  readonly error: unknown;
  retry(): void;
}

function ReadFailure({ defect }: { defect: ReaderContentDefect | null }) {
  if (defect !== null) throw defect.error;
  return null;
}

/** Read failure feedback leaves already admitted roots and media drafts mounted. */
export default function ReaderContentBoundary({ defect, ready, retry, children }: {
  readonly defect: ReaderContentDefect | null;
  readonly ready: boolean;
  readonly retry: () => void;
  readonly children: ReactNode;
}) {
  const notice = (retry: () => void) => (
    <FeedbackNotice content={{ tone: "Danger", title: "The reader couldn’t load this part." }}
      announcement="Assertive" actions={[{ label: "Retry reader", onClick: retry }]} />
  );
  return (
    <>
      {/* Resetting by key belongs to a new defect alone: keying on readiness
          would remount the children on every page turn and drop their focus. */}
      <FeatureErrorBoundary key={defect?.key ?? "healthy"} scope="ReaderContent" onRetry={defect?.retry ?? retry} fallback={notice}>
        <ReadFailure defect={defect} />
      </FeatureErrorBoundary>
      {/* A defect before anything is admitted leaves nothing worth keeping. */}
      {defect !== null && !ready ? null : children}
    </>
  );
}
