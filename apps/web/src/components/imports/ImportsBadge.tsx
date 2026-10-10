"use client";

import Pill from "@/components/ui/Pill";
import { attentionPhrase, countText } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";

/**
 * The Imports destination's label and attention badge, so the rail link and
 * the account menu item show one count with one meaning (contract D9). Zero or
 * an unknown summary shows the label only; the visible count is capped and the
 * accessible name, the whole name of the control, carries the exact one. A
 * collapsed rail hides the label and paints the count at the glyph's size.
 */
export default function ImportsBadge({
  label,
  labelVisible,
}: {
  readonly label: string;
  readonly labelVisible: boolean;
}) {
  const { summary } = useImports();
  const count =
    summary.status === "ready" ? summary.data.needs_attention_count : 0;
  if (count === 0) {
    return labelVisible ? (
      <>{label}</>
    ) : (
      <span className="sr-only">{label}</span>
    );
  }
  return (
    <>
      {labelVisible ? <span aria-hidden="true">{label}</span> : null}
      <Pill tone="warning" size={labelVisible ? "sm" : "xs"} aria-hidden="true">
        {countText(count)}
      </Pill>
      <span className="sr-only">{`${label}, ${attentionPhrase(count)}`}</span>
    </>
  );
}
