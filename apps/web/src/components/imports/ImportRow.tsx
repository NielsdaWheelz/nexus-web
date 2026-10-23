"use client";

import { useRef } from "react";
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
import { useImportActions } from "./ImportActions";
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
  const moreRef = useRef<HTMLButtonElement>(null);
  const returnFocus = () => {
    const more = moreRef.current;
    if (more?.isConnected && more.getClientRects().length && !more.closest("[hidden], [inert]")) return more;
    return more?.closest("[data-import-ref]")?.querySelector<HTMLElement>("[data-row-focusable]") ?? null;
  };
  const actions = useImportActions({ item, triggerRef: moreRef, returnFocus });
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
      primaryControl={actions.shortcuts}
      actions={actions.menu}
      expanded={actions.feedback}
    />
  );
}
