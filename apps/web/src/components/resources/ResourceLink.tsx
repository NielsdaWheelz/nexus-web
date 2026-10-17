"use client";

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
  const reason = item.activation.unavailable_reason;
  const activation = !item.activation.href && reason === "location_unavailable"
    ? item.preview.source?.activation ?? item.activation
    : item.activation;
  const unavailable = reason === "location_unavailable" ? "quoted location unavailable"
    : reason === "source_unavailable" ? "source unavailable"
    : !activation.href ? "resource unavailable" : null;
  return <span className={styles.reference}>
    {activation.href ? <a className={styles.link} href={activation.href}
      data-workspace-rich-target="true"
      onClick={(event) => activateTargetLink({ event, runtime, href: activation.href, labelHint: label })}>
      {label}
    </a> : <span>{label}</span>}
    {unavailable ? <span className={styles.unavailable}> · {unavailable}</span> : null}
  </span>;
}
