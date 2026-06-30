"use client";

import {
  useMemo,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import { ExternalLink } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Pill from "@/components/ui/Pill";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import type { ReaderConnectionRow } from "@/lib/reader/documentMap";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import AnchoredSidecarSurface from "../AnchoredSidecarSurface";
import type { AnchoredReaderRow } from "../useAnchoredReaderProjection";
import styles from "./ReaderDocumentMapConnectionsLens.module.css";

interface ReaderDocumentMapConnectionsLensProps {
  contentRef: RefObject<HTMLElement | null>;
  rows: ReaderConnectionRow[];
  loading: boolean;
  error: FeedbackContent | null;
  onOpenSource: (row: ReaderConnectionRow, event?: MouseEvent) => void;
  onActivateTarget: (row: ReaderConnectionRow) => void;
  measureKey: string | number;
  isMobile: boolean;
}

export default function ReaderDocumentMapConnectionsLens({
  contentRef,
  rows,
  loading,
  error,
  onOpenSource,
  onActivateTarget,
  measureKey,
  isMobile,
}: ReaderDocumentMapConnectionsLensProps) {
  const anchoredRows = useMemo(
    () =>
      rows
        .map((row) => toAnchoredConnectionRow(row))
        .filter((row): row is AnchoredReaderRow => row !== null),
    [rows],
  );
  const header = (
    <header className={styles.header}>
      <div>
        <h2>Connections</h2>
        <p>{rows.length} linked items in this reader context.</p>
      </div>
    </header>
  );

  if (loading) {
    return (
      <section className={styles.root} aria-label="Connections">
        {header}
        <div className={styles.empty}>
          <FeedbackNotice severity="info" title="Loading connections..." />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.root} aria-label="Connections">
        {header}
        <div className={styles.empty}>
          <FeedbackNotice feedback={error} />
        </div>
      </section>
    );
  }

  return (
    <AnchoredSidecarSurface
      ariaLabel="Connections"
      header={header}
      rows={rows}
      anchoredRows={anchoredRows}
      contentRef={contentRef}
      measureKey={measureKey}
      isMobile={isMobile}
      rowHeight={112}
      testId="reader-connections-container"
      empty={<FeedbackNotice severity="neutral" title="No connections in this context." />}
      idForRow={(row) => row.id}
      renderRow={(row, props) => (
        <ConnectionRowCard
          key={row.id}
          row={row}
          className={props.className}
          style={props.style}
          rootRef={props.ref}
          onOpenSource={onOpenSource}
          onActivateTarget={onActivateTarget}
        />
      )}
    />
  );
}

function ConnectionRowCard({
  row,
  className,
  style,
  rootRef,
  onOpenSource,
  onActivateTarget,
}: {
  row: ReaderConnectionRow;
  className: string;
  style?: CSSProperties;
  rootRef: (element: HTMLElement | null) => void;
  onOpenSource: (row: ReaderConnectionRow, event?: MouseEvent) => void;
  onActivateTarget: (row: ReaderConnectionRow) => void;
}) {
  const Icon = resourceIconForUri(row.connection.other.ref);
  const targetState = targetStatusText(row);
  return (
    <article ref={rootRef} className={`${styles.card} ${className}`} style={style}>
      <button
        type="button"
        className={styles.cardButton}
        onClick={(event) => onOpenSource(row, event)}
      >
        <span className={styles.meta}>
          <span className={styles.category}>
            <Icon size={14} aria-hidden="true" />
            {categoryLabel(row.source_category)}
          </span>
          <Pill tone={row.connection.origin === "citation" ? "info" : "neutral"}>
            {row.connection.kind}
          </Pill>
        </span>
        <span className={styles.title}>{row.title}</span>
        {row.excerpt ? <span className={styles.excerpt}>{row.excerpt}</span> : null}
        {targetState ? <span className={styles.targetState}>{targetState}</span> : null}
      </button>
      {row.anchor ? (
        <button
          type="button"
          className={styles.targetButton}
          onClick={() => onActivateTarget(row)}
          aria-label={`Open target in reader for ${row.title}`}
        >
          <ExternalLink size={13} aria-hidden="true" />
          Target
        </button>
      ) : null}
    </article>
  );
}

function targetStatusText(row: ReaderConnectionRow): string | null {
  const status = row.connection.citation?.target_status;
  if (row.anchor || !status) return null;
  if (status === "missing" || status === "forbidden") {
    return "Target is no longer available.";
  }
  if (status === "unanchorable") {
    return "Target is not jumpable in this reader.";
  }
  return null;
}

function toAnchoredConnectionRow(row: ReaderConnectionRow): AnchoredReaderRow | null {
  const locator = row.anchor?.locator;
  if (!locator) return null;
  const exact = row.excerpt ?? row.title;
  if (locator.type === "pdf_page_geometry") {
    const quads = parseRawPdfQuads(locator.quads);
    if (quads.length === 0 || typeof locator.page_number !== "number") return null;
    return {
      id: row.id,
      exact,
      color: "blue",
      page_number: locator.page_number,
      quads,
      stable_order_key: row.anchor?.order_key ?? row.id,
    };
  }
  if (
    (locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets") &&
    typeof locator.fragment_id === "string" &&
    typeof locator.start_offset === "number" &&
    typeof locator.end_offset === "number"
  ) {
    return {
      id: row.id,
      exact,
      color: "blue",
      anchor: {
        fragment_id: locator.fragment_id,
        start_offset: locator.start_offset,
        end_offset: locator.end_offset,
      },
      stable_order_key: row.anchor?.order_key ?? row.id,
    };
  }
  return null;
}

function categoryLabel(category: ReaderConnectionRow["source_category"]): string {
  switch (category) {
    case "chat":
      return "Chat";
    case "library_intelligence":
      return "Library Intelligence";
    case "oracle":
      return "Oracle";
    case "note":
      return "Note";
    case "highlight_note":
      return "Highlight note";
    case "user_link":
      return "Link";
    case "synapse":
      return "Synapse";
    case "system":
      return "System";
    case "document_embed":
      return "Embedded media";
    default:
      return "Connection";
  }
}
