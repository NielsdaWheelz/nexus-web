"use client";

import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { canonicalResourceRef } from "@/lib/sharing/targets";

/** Thin typed identity adapter; the canonical menu owns every action. */
export default function HighlightResourceActionMenu({
  highlight,
  className,
}: {
  readonly highlight: Pick<AnchoredReaderRow, "id">;
  readonly className?: string;
}) {
  return (
    <span className={className}>
      <ResourceActionMenu
        actionSubject={{
          ref: canonicalResourceRef({ scheme: "highlight", id: highlight.id }),
        }}
        label="Highlight actions"
      />
    </span>
  );
}
