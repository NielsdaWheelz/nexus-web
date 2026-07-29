import type { ReactNode } from "react";
import type { EmphasisSegment } from "@/lib/ui/emphasis";

interface EmphasisSegmentsProps {
  readonly segments: readonly EmphasisSegment[];
  readonly emphasisClassName?: string;
}

export default function EmphasisSegments({
  segments,
  emphasisClassName,
}: EmphasisSegmentsProps): ReactNode {
  return segments.map((segment, index) =>
    segment.emphasized ? (
      <mark key={index} className={emphasisClassName}>
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );
}
