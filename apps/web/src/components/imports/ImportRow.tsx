"use client";

import ResourceRow from "@/components/ui/ResourceRow";
import type { ImportItem } from "@/lib/imports/api";
import {
  KIND_LABEL,
  ageLine,
  concurrentWorkLine,
  consequenceLine,
  matchLine,
  momentText,
  reasonLine,
} from "@/lib/imports/copy";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { ImportActions } from "./ImportActions";
import styles from "./Imports.module.css";

/**
 * One import: what it is, what it is doing or waiting for, why, and the
 * command that recovers it when the server offers one. Selecting it opens the
 * inspector; the accessible name stays the whole title however it truncates.
 */
export default function ImportRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: ImportItem;
  readonly selected: boolean;
  readonly onSelect: (ref: string, triggerElement: HTMLButtonElement) => void;
}) {
  const display = useRenderEnvironment();
  const now = new Date();
  const consequence = consequenceLine(item, (at) => momentText(at, display));
  const reason = reasonLine(item);
  const concurrent = concurrentWorkLine(item);
  const age = ageLine(item, display, now);
  return (
    <ResourceRow
      as="li"
      wrapped
      selected={selected}
      rootProps={{
        "aria-label": item.title,
        "aria-current": selected ? "true" : undefined,
        "data-import-ref": item.ref,
      }}
      primary={{
        kind: "button",
        label: item.title,
        onActivate: (triggerElement) => onSelect(item.ref, triggerElement),
      }}
      title={item.title}
      supporting={<span className={styles.consequence}>{consequence}</span>}
      status={
        <div className={styles.rowContext}>
          {reason === null ? null : <span>{reason}</span>}
          {concurrent === null ? null : <span>{concurrent}</span>}
          {item.matched_event.kind === "Present" ? (
            <span>{matchLine(item.matched_event.value, display, now)}</span>
          ) : null}
          <span className={styles.provenance}>
            <span>{KIND_LABEL[item.media_kind]}</span>
            {item.source_label.kind === "Present" ? (
              <span>{item.source_label.value}</span>
            ) : null}
            {item.original_filename.kind === "Present" &&
            item.original_filename.value !== item.title ? (
              <span>original file: {item.original_filename.value}</span>
            ) : null}
            <time dateTime={age.dateTime}>{age.text}</time>
          </span>
        </div>
      }
      primaryControl={
        <span className={styles.rowActions}>
          <ImportActions item={item} />
        </span>
      }
    />
  );
}
