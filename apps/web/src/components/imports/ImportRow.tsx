"use client";

import { ChevronRight } from "lucide-react";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import ResourceDisclosure from "@/components/resources/ResourceDisclosure";
import outlineStyles from "@/components/resources/ResourceOutline.module.css";
import ResourceRow from "@/components/ui/ResourceRow";
import { FeedbackStatus } from "@/components/feedback/Feedback";
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
  const open=useResourceDraft<boolean>(`Imports.Disclosure:${item.ref}`,()=>false);
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
      supporting={<FeedbackStatus
        content={{ tone: item.classification === "NeedsAttention" ? "Warning" : "Neutral", title: consequence,
          message: [reason, concurrent].filter(Boolean).join(" · ") || undefined }}
        announcement="None"
      />}
      status={
        <div className={styles.rowContext}>
          {item.matched_event !== null ? (
            <span>{matchLine(item.matched_event, display, now)}</span>
          ) : null}
          <span className={styles.provenance}>
            <span>{KIND_LABEL[item.media_kind]}</span>
            {item.source_label !== null ? (
              <span>{item.source_label}</span>
            ) : null}
            {item.original_filename !== null &&
            item.original_filename !== item.title ? (
              <span>original file: {item.original_filename}</span>
            ) : null}
            <time dateTime={age.dateTime}>{age.text}</time>
          </span>
        </div>
      }
      leadingControl={item.media_id!==null ? <>
        <button type="button" className={outlineStyles.control} aria-label={`${open.value ? "hide" : "show"} linked resources for ${item.title}`} aria-expanded={open.value} onClick={()=>open.set(!open.value)}><ChevronRight className={outlineStyles.arrow} data-open={open.value || undefined} size={14} aria-hidden="true" /></button>
        <a href={`/media/${item.media_id}`} className={outlineStyles.control} aria-label={`open ${item.title}`}>•</a>
      </> : undefined}
      expanded={open.value && item.media_id!==null ? <ResourceDisclosure resourceRef={`media:${item.media_id}`} occurrencePrefix={`imports:${item.ref}`} /> : undefined}
      primaryControl={
        <div className={styles.rowActions}>
          <ImportActions item={item} onAddItem={()=>open.set(true)} />
        </div>
      }
    />
  );
}
