"use client";

import {
  useCallback,
  useMemo,
  type CSSProperties,
  type RefObject,
} from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Pill from "@/components/ui/Pill";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import {
  readerApparatusRowPresentation,
  type ReaderApparatusCapabilities,
  type ReaderApparatusRow,
} from "@/lib/reader/apparatus";
import AnchoredSidecarSurface from "./AnchoredSidecarSurface";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";
import styles from "./ReaderApparatusSurface.module.css";

const ROW_HEIGHT = 112;

interface ReaderApparatusSurfaceProps {
  rows: ReaderApparatusRow[];
  projectRows?: ReaderApparatusRow[];
  capabilities: ReaderApparatusCapabilities;
  contentRef: RefObject<HTMLElement | null>;
  activeItemId: string | null;
  hoveredItemId: string | null;
  onActivateRow: (row: ReaderApparatusRow) => void;
  onHoverItem: (itemId: string | null) => void;
  measureKey?: string | number;
  isMobile: boolean;
  pdfActivePage?: number | null;
}

export default function ReaderApparatusSurface({
  rows,
  projectRows,
  capabilities,
  contentRef,
  activeItemId,
  hoveredItemId,
  onActivateRow,
  onHoverItem,
  measureKey = 0,
  isMobile,
  pdfActivePage = null,
}: ReaderApparatusSurfaceProps) {
  const anchoredRows = useMemo(
    () =>
      (projectRows ?? rows)
        .map((row) => toAnchoredRow(row))
        .filter((row): row is AnchoredReaderRow => row !== null),
    [projectRows, rows],
  );
  const apparatusTargetSelector = useCallback(
    (escapedId: string) => `[data-reader-apparatus-item-id="${escapedId}"]`,
    [],
  );

  const renderRow = useCallback(
    (
      row: ReaderApparatusRow,
      className: string,
      style: CSSProperties | undefined,
      rootRef: (element: HTMLElement | null) => void,
    ) => {
      const presentation = readerApparatusRowPresentation(row, capabilities);
      const canActivateRow =
        presentation.canActivateMarker || presentation.canActivateTarget;
      return (
        <button
          key={row.id}
          ref={(element) => rootRef(element)}
          type="button"
          className={`${styles.card} ${className}`}
          style={style}
          disabled={!canActivateRow}
          data-active={
            canActivateRow && activeItemId === row.id ? "true" : "false"
          }
          data-hovered={hoveredItemId === row.id ? "true" : "false"}
          data-interactive={canActivateRow ? "true" : "false"}
          onClick={() => {
            if (canActivateRow) {
              onActivateRow(row);
            }
          }}
          onMouseEnter={() => {
            if (presentation.canPreview || canActivateRow) {
              onHoverItem(row.id);
            }
          }}
          onMouseLeave={() => onHoverItem(null)}
        >
          <div className={styles.meta}>
            <span className={styles.kind}>{kindLabel(row.marker.kind)}</span>
            {row.marker.confidence === "exact" ? null : (
              <Pill tone="warning">{row.marker.confidence}</Pill>
            )}
          </div>
          <div className={styles.label}>
            {row.marker.label ?? row.target?.label ?? "Citation"}
          </div>
          {row.targets.some((target) => target.body_text) ? (
            <div className={styles.bodyList}>
              {row.targets
                .filter((target) => target.body_text)
                .map((target, index) => (
                  <p key={target.stable_key} className={styles.body}>
                    {row.targets.length > 1 ? (
                      <span className={styles.targetLabel}>
                        {target.label ?? `Reference ${index + 1}`}
                      </span>
                    ) : null}
                    {target.body_text}
                  </p>
                ))}
            </div>
          ) : (
            <div className={styles.targetMissing}>
              {presentation.targetStatusText}
            </div>
          )}
        </button>
      );
    },
    [
      activeItemId,
      capabilities,
      hoveredItemId,
      onActivateRow,
      onHoverItem,
    ],
  );

  const header = (
    <header className={styles.header}>
      <div>
        <h2>Citations</h2>
        <p>{apparatusSummary(rows, capabilities)}</p>
      </div>
      {pdfActivePage ? <Pill tone="info">Page {pdfActivePage}</Pill> : null}
    </header>
  );

  return (
    <AnchoredSidecarSurface
      ariaLabel="Citations"
      header={header}
      rows={rows}
      anchoredRows={anchoredRows}
      contentRef={contentRef}
      measureKey={measureKey}
      isMobile={isMobile}
      rowHeight={ROW_HEIGHT}
      testId="reader-apparatus-container"
      targetSelector={apparatusTargetSelector}
      empty={<FeedbackNotice severity="neutral" title="No citations in this context." />}
      idForRow={(row) => row.id}
      renderRow={(row, props) => renderRow(row, props.className, props.style, props.ref)}
    />
  );
}

function apparatusSummary(
  rows: ReaderApparatusRow[],
  capabilities: ReaderApparatusCapabilities,
): string {
  const markerOnlyCount = rows.filter(
    (row) => readerApparatusRowPresentation(row, capabilities).markerOnly,
  ).length;
  const resolvedCount = rows.length - markerOnlyCount;
  if (markerOnlyCount === 0) {
    return `${rows.length} source-authored notes and references in this context.`;
  }
  if (resolvedCount === 0) {
    return `${markerOnlyCount} source-authored ${pluralize("marker", markerOnlyCount)} pending target resolution.`;
  }
  return `${resolvedCount} resolved ${pluralize("item", resolvedCount)} and ${markerOnlyCount} ${pluralize("marker", markerOnlyCount)} pending target resolution.`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function toAnchoredRow(row: ReaderApparatusRow): AnchoredReaderRow | null {
  const locator = row.marker.locator ?? row.target?.locator ?? null;
  if (!locator) {
    return null;
  }
  const exact =
    row.marker.label ??
    row.target?.label ??
    row.target?.body_text ??
    "Citation";
  if (
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets"
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
      stable_order_key: row.sort_key,
    };
  }
  if (locator.type === "pdf_page_geometry") {
    const quads = parseRawPdfQuads(locator.quads);
    if (quads.length === 0) {
      return null;
    }
    return {
      id: row.id,
      exact,
      color: "blue",
      page_number: locator.page_number,
      quads,
      stable_order_key: row.sort_key,
    };
  }
  return null;
}

function kindLabel(kind: ReaderApparatusRow["marker"]["kind"]): string {
  switch (kind) {
    case "footnote_ref":
    case "footnote":
      return "Footnote";
    case "endnote_ref":
    case "endnote":
      return "Endnote";
    case "bibliography_ref":
    case "bibliography_entry":
      return "Reference";
    case "reference_section":
      return "References";
    case "sidenote_ref":
    case "sidenote":
      return "Sidenote";
    case "margin_note_ref":
    case "margin_note":
      return "Margin note";
    default:
      return "Citation";
  }
}
