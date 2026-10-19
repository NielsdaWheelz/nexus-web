"use client";

import { Fragment } from "react";
import type { Schema } from "@/lib/api/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { ResourceItem } from "@/lib/resources/items";
import { resourceMetadataParts } from "@/lib/resources/metadata";
import styles from "./ResourceOutline.module.css";

type MatchMethod = Schema<"SearchOccurrenceOut">["match_method"];

/** A launcher row already owns its link; an outline can expose the source separately. */
export default function ResourceMetadata({ item, matchMethod = null, linkSource }: {
  item: ResourceItem;
  matchMethod?: MatchMethod | null;
  linkSource: boolean;
}) {
  const runtime = usePaneRuntime();
  return <>{resourceMetadataParts(item, matchMethod).map((part, index) => <Fragment key={index}>
    {index > 0 ? <span aria-hidden="true"> · </span> : null}
    {linkSource && part.href ? <a className={styles.source} href={part.href} aria-label={`Open source: ${part.text}`} data-workspace-rich-target="true" onClick={(event) => activateTargetLink({ event, runtime, target: part.href ? { href: part.href, labelHint: part.text } : null })} onKeyDown={(event) => activateTargetLink({ event, runtime, target: part.href ? { href: part.href, labelHint: part.text } : null })}>{part.text}</a> : <span>{part.text}</span>}
  </Fragment>)}</>;
}
