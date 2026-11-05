"use client";

import { useLayoutEffect } from "react";
import ResourceQuotation from "@/components/resources/ResourceQuotation";
import { useHoverPreview } from "@/components/ui/HoverPreview";
import type { Schema } from "@/lib/api/wire";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { cx } from "@/lib/ui/cx";
import styles from "./ReaderCitation.module.css";

/** Inline ordinal with a preview of the supplied citation evidence. */
export default function ReaderCitation({ ordinal, item, className }: Schema<"CitationOut"> & { className?: string }) {
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const hover = useHoverPreview(active, `citation ${ordinal} preview`);
  const closePreview = hover.close;
  useLayoutEffect(() => closePreview({ restoreFocus: false }), [closePreview, runtime?.href, runtime?.visitId, runtime?.paneEntryDelivery?.activationId]);
  const href = item.activation.href;
  const preview = hover.render(<ResourceQuotation item={item} />);
  return <>
    {href ? <a className={cx(styles.citation, className)} href={href} aria-label={`open citation ${ordinal}`} aria-haspopup="dialog" data-workspace-rich-target="true" data-pane-find-exclude="true" {...hover.trigger}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); hover.show(event.currentTarget, true); } else activateTargetLink({ event, runtime, target: { href, labelHint: item.label } }); }}
      onClick={(event) => activateTargetLink({ event, runtime, target: { href, labelHint: item.label } })}>{ordinal}</a>
      : <button type="button" className={cx(styles.citation, className)} aria-label={`preview citation ${ordinal}`} aria-haspopup="dialog" data-pane-find-exclude="true" {...hover.trigger}
        onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); hover.show(event.currentTarget, true); } }}
        onClick={(event) => hover.show(event.currentTarget, true)}>{ordinal}</button>}
    {preview}
  </>;
}
