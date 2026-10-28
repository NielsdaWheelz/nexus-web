"use client";

import { useId } from "react";
import type { Schema } from "@/lib/api/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import styles from "./ResourceLink.module.css";

/** A compact reference follows the same canonical target as the resource outline. */
export default function ResourceLink({ item, label = item.label }: {
  item: Schema<"ResourceItemOut">;
  label?: string;
}) {
  const runtime = usePaneRuntime();
  const statusId = useId();
  const reason = item.activation.unavailable_reason;
  const sourceOnly = !item.activation.href && reason === "location_unavailable";
  const activation = sourceOnly
    ? item.preview.source?.activation ?? item.activation
    : item.activation;
  const href = activation.href;
  const unavailable = reason === "location_unavailable" ? "quoted location unavailable"
    : reason === "source_unavailable" ? "source unavailable"
    : !activation.href ? "resource unavailable" : null;
  if (item.missing && item.preview.body.kind === "named" && item.preview.source === null
    && reason === "source_unavailable") {
    return <span className={styles.unavailable}>source unavailable</span>;
  }
  return <span className={styles.reference}>
    {href ? <a className={styles.link} href={href}
      aria-label={sourceOnly ? `open source: ${label}` : undefined}
      aria-describedby={sourceOnly ? statusId : undefined}
      data-workspace-rich-target="true"
      onClick={(event) => activateTargetLink({ event, runtime, target: href ? { href, labelHint: label } : null })} onKeyDown={(event) => activateTargetLink({ event, runtime, target: href ? { href, labelHint: label } : null })}>
      {label}
    </a> : <span>{label}</span>}
    {unavailable ? <><span aria-hidden="true"> · </span><span id={statusId} className={styles.unavailable}>{unavailable}</span></> : null}
  </span>;
}
