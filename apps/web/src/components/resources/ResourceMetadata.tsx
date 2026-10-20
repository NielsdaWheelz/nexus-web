"use client";

import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { ResourceMetadataPart } from "@/lib/resources/metadata";
import styles from "./ResourceOutline.module.css";

/** A launcher row already owns its link; an outline can expose the source separately. */
export default function ResourceMetadata({ parts, linkSource }: {
  parts: readonly ResourceMetadataPart[];
  linkSource: boolean;
}) {
  const runtime = usePaneRuntime();
  return <>{parts.map((part, index) => <span key={part.key}>
    {index > 0 ? <><span aria-hidden="true">{" ·\u00a0"}</span><span className="sr-only">, </span></> : null}
    {linkSource && part.href ? <a className={styles.source} href={part.href} aria-label={`Open source: ${part.text}`} data-workspace-rich-target="true" onClick={(event) => activateTargetLink({ event, runtime, target: part.href ? { href: part.href, labelHint: part.text } : null })} onKeyDown={(event) => activateTargetLink({ event, runtime, target: part.href ? { href: part.href, labelHint: part.text } : null })}>{part.text}</a> : part.text}
  </span>)}</>;
}
