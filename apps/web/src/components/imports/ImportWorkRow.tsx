"use client";

import { useRef, type AnimationEventHandler } from "react";
import ResourceRow from "@/components/ui/ResourceRow";
import { ResourceIndexTitle } from "@/components/resources/ResourceType";
import type { ImportItem } from "@/lib/imports/api";
import { importLine } from "@/lib/imports/copy";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useImportActions } from "./ImportActions";
import styles from "./Imports.module.css";

/** An unsettled import keeps the collection's ordinary title, controls and focus contract. */
export default function ImportWorkRow({ item, selected, onSelect, className, onAnimationEnd }: {
  readonly item: ImportItem;
  readonly selected: boolean;
  readonly onSelect: (ref: string, trigger: HTMLElement | null) => void;
  readonly className?: string;
  readonly onAnimationEnd?: AnimationEventHandler<HTMLElement>;
}) {
  const display = useRenderEnvironment();
  const moreRef = useRef<HTMLButtonElement>(null);
  const actions = useImportActions({ item, onSelect, triggerRef: moreRef, returnFocus: () => moreRef.current });
  const readable = item.can_read || item.can_play;
  const title = readable ? item.title : item.pointer ?? item.title;
  const line = importLine(item, display);
  const progress = item.obligations.source?.progress;
  const counted = progress?.kind === "Counted" ? progress : null;
  return <ResourceRow selected={selected}
    rootProps={{ className, onAnimationEnd, "data-collection-row-id": item.ref, "aria-current": selected ? "true" : undefined }}
    primary={readable && item.media_id !== null ? { kind: "link", href: `/media/${item.media_id}`, label: title, paneLabelHint: item.title }
      : { kind: "button", label: title, onActivate: trigger => onSelect(item.ref, trigger) }}
    title={<ResourceIndexTitle type={{ scheme: "media", mediaKind: item.media_kind }} hasArtwork={false}>
      <span className={!readable && item.pointer !== null ? styles.pointer : undefined}>{title}</span>
    </ResourceIndexTitle>}
    content={{ kind: "Index", metadata: <>
      {line === null ? null : <span className={styles.line} data-tone={line.tone}>{line.text}</span>}
      {counted === null ? null : <span role="progressbar" aria-label="source extraction" aria-valuemin={0}
        aria-valuemax={counted.total} aria-valuenow={counted.completed} className={styles.rule}
        style={{ width: `${100 * counted.completed / counted.total}%` }} />}
    </> }}
    controls={<>{actions.shortcut === null ? null : <span data-row-primary-control="">{actions.shortcut}</span>}{actions.menu}</>}
  />;
}
