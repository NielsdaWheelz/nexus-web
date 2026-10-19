"use client";

import { useLayoutEffect } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { useHoverPreview } from "@/components/ui/HoverPreview";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { ReaderCitationData } from "@/lib/resourceGraph/citations";
import { cx } from "@/lib/ui/cx";
import styles from "./ReaderCitation.module.css";

/** Inline ordinal; its interactive preview is the common resource outline. */
export default function ReaderCitation({ index, edgeId, item, className }: ReaderCitationData & { className?: string }) {
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const hover = useHoverPreview(active, `Citation ${index} preview`);
  const closePreview = hover.close;
  useLayoutEffect(() => closePreview({ restoreFocus: false }), [closePreview, runtime?.href, runtime?.visitId, runtime?.paneEntryDelivery?.activationId]);
  const href = item.activation.href;
  const preview = hover.render(<ResourceOutlineList scope={`citation-preview:${edgeId}`} ariaLabel={`Citation ${index}`}>
    <ResourceOutlineRow item={item} occurrenceKey={`citation:${edgeId}`} historical occurrenceLabel={`citation ${index}`} />
  </ResourceOutlineList>);
  return <>
    {href ? <a className={cx(styles.citation, className)} href={href} aria-label={`Open citation ${index}`} aria-haspopup="dialog" data-workspace-rich-target="true" data-pane-find-exclude="true" {...hover.trigger}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); hover.show(event.currentTarget, true); } else activateTargetLink({ event, runtime, target: { href, labelHint: item.label } }); }}
      onClick={(event) => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}>{index}</a>
      : <button type="button" className={cx(styles.citation, styles.unavailable, className)} aria-label={`Preview unavailable citation ${index}`} aria-haspopup="dialog" data-pane-find-exclude="true" {...hover.trigger} onClick={(event) => hover.show(event.currentTarget, true)}>{index}</button>}
    {preview}
  </>;
}
