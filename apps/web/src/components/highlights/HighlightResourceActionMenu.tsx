"use client";

import type { ComponentProps } from "react";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { canonicalResourceRef } from "@/lib/sharing/targets";

/** Thin typed identity adapter; the canonical menu owns every action. */
export default function HighlightResourceActionMenu({
  highlight,
  className,
  anchored,
}: {
  readonly highlight: Pick<AnchoredReaderRow, "id">;
  readonly className?: string;
  readonly anchored?: ComponentProps<typeof ResourceActionMenu>["anchored"];
}) {
  return (
    <span className={className}>
      <ResourceActionMenu
        actionSubject={{
          ref: canonicalResourceRef({ scheme: "highlight", id: highlight.id }),
        }}
        label="Highlight actions"
        anchored={anchored}
        align={anchored ? "center" : undefined}
      />
    </span>
  );
}
