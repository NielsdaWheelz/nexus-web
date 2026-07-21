"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import { ExternalLink, X } from "lucide-react";
import { MessageSquare } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import type { HighlightActionTarget } from "@/components/highlights/highlightActions";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import ItemCard from "@/components/items/ItemCard";
import Pill from "@/components/ui/Pill";
import MachineText from "@/components/ui/MachineText";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchNoteBlock } from "@/lib/notes/api";
import { NOTE_LAYOUT_MEASURE_DELAY_MS } from "@/lib/notes/useNoteEditorSession";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import {
  readerApparatusRowPresentation,
  type ReaderApparatusResponse,
  type ReaderApparatusRow,
} from "@/lib/reader/apparatus";
import type { ReaderConnectionRow } from "@/lib/reader/documentMap";
import { anchoredRowFromConnection } from "@/lib/reader/marginItems";
import type { EvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import { useStringIdSet } from "@/lib/useStringIdSet";
import AnchoredSidecarSurface from "../AnchoredSidecarSurface";
import type { AnchoredReaderRow } from "../useAnchoredReaderProjection";
import styles from "./EvidencePaneSurface.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EvidenceRow =
  | { kind: "highlight"; id: string; data: AnchoredReaderRow }
  | {
      kind: "apparatus";
      id: string;
      data: ReaderApparatusRow;
      anchor: AnchoredReaderRow | null;
    }
  | {
      kind: "connection";
      id: string;
      data: ReaderConnectionRow;
      anchor: AnchoredReaderRow | null;
    };

export interface EvidencePaneSurfaceProps {
  contentRef: RefObject<HTMLElement | null>;
  filters: EvidenceFilters;
  highlights: AnchoredReaderRow[];
  readerApparatusRows: ReaderApparatusRow[];
  connectionRows: ReaderConnectionRow[];
  readerApparatus: ReaderApparatusResponse | null | undefined;
  focusedApparatusItemId: string | null;
  focusedHighlightId: string | null;
  isReflowable: boolean;
  isEditingBounds: boolean;
  hoveredId: string | null;
  canQuoteToChat: boolean;
  loading: boolean;
  error: FeedbackContent | null;
  measureKey: string | number;
  layoutVersion: number;
  isMobile: boolean;
  onHighlightClick: (id: string) => void;
  onFocusHighlight: (highlightId: string) => void;
  onHoverHighlight: (highlightId: string | null) => void;
  onQuoteToChat: (highlightId: string) => void;
  onLink: (target: HighlightActionTarget) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string,
  ) => Promise<HighlightLinkedNoteBlock>;
  onNoteDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean,
  ) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
  onOpenNoteLink: (href: string, options: { newPane: boolean }) => void;
  onApparatusRowActivate: (row: ReaderApparatusRow) => void;
  onOpenConnectionSource: (row: ReaderConnectionRow, event?: MouseEvent) => void;
  onActivateConnectionTarget: (row: ReaderConnectionRow) => void;
  onDismissSynapse: (edgeId: string) => void;
  /** Remove a stable user Link/stance row; the caller dispatches by `row.connection.kind`
   * (`links.ts` `deleteLink` for `context`, `stances.ts` `deleteStance` otherwise). */
  onRemoveLink: (row: ReaderConnectionRow) => void;
  /** Add/edit the one ordinary note folded onto a neutral (context) Link — mirrors
   * `links.ts` `putLinkNote(linkId, {noteBlockId, bodyPmJson})`. */
  onSaveLinkNote: (
    linkId: string,
    noteBlockId: string,
    bodyPmJson: Record<string, unknown>,
  ) => Promise<{ note_block_id: string }>;
  /** Remove the Link's note; mirrors `links.ts` `deleteLinkNote(linkId)`. The Link
   * itself is preserved. */
  onDeleteLinkNote: (linkId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EvidencePaneSurface({
  contentRef,
  filters,
  highlights,
  readerApparatusRows,
  connectionRows,
  readerApparatus,
  focusedApparatusItemId,
  focusedHighlightId,
  isReflowable,
  isEditingBounds,
  hoveredId,
  canQuoteToChat,
  loading,
  error,
  measureKey,
  layoutVersion,
  isMobile,
  onHighlightClick,
  onFocusHighlight,
  onHoverHighlight,
  onQuoteToChat,
  onLink,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  onNoteSave,
  onNoteDelete,
  onOpenConversation,
  onOpenNoteLink,
  onApparatusRowActivate,
  onOpenConnectionSource,
  onActivateConnectionTarget,
  onDismissSynapse,
  onRemoveLink,
  onSaveLinkNote,
  onDeleteLinkNote,
}: EvidencePaneSurfaceProps) {
  const { filter, toggleFilter } = filters;
  const feedback = useFeedback();

  const noteLayoutTimerRef = useRef<number | null>(null);
  const [noteLayoutVersion, setNoteLayoutVersion] = useState(0);
  const expandedTextIds = useStringIdSet();
  const draftNoteEditorKeysRef = useRef(new Map<string, string>());
  const noteEditorKeysByBlockIdRef = useRef(new Map<string, string>());
  const expandedLinkNoteIds = useStringIdSet();
  const [fetchedLinkNotes, setFetchedLinkNotes] = useState(
    new Map<string, HighlightLinkedNoteBlock>(),
  );

  const getDraftNoteEditorKey = useCallback((highlightId: string) => {
    const existing = draftNoteEditorKeysRef.current.get(highlightId);
    if (existing) return existing;
    const key = `draft-note-${highlightId}`;
    draftNoteEditorKeysRef.current.set(highlightId, key);
    return key;
  }, []);

  const getNoteEditorKey = useCallback(
    (
      highlightId: string,
      note: NonNullable<AnchoredReaderRow["linked_note_blocks"]>[number] | null,
    ) => {
      if (!note) return getDraftNoteEditorKey(highlightId);
      const noteKey =
        noteEditorKeysByBlockIdRef.current.get(note.note_block_id) ??
        `note-${note.note_block_id}`;
      if (!draftNoteEditorKeysRef.current.has(highlightId)) {
        draftNoteEditorKeysRef.current.set(highlightId, noteKey);
      }
      return noteKey;
    },
    [getDraftNoteEditorKey],
  );

  const scheduleNoteLayoutMeasure = useCallback(() => {
    if (noteLayoutTimerRef.current !== null) {
      window.clearTimeout(noteLayoutTimerRef.current);
    }
    noteLayoutTimerRef.current = window.setTimeout(() => {
      noteLayoutTimerRef.current = null;
      setNoteLayoutVersion((v) => v + 1);
    }, NOTE_LAYOUT_MEASURE_DELAY_MS);
  }, []);

  const handleNoteSave = useCallback(
    async (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      clientMutationId: string,
    ) => {
      if (!noteBlockId) {
        noteEditorKeysByBlockIdRef.current.set(
          createBlockId,
          getDraftNoteEditorKey(highlightId),
        );
      }
      return onNoteSave(highlightId, noteBlockId, createBlockId, bodyPmJson, clientMutationId);
    },
    [getDraftNoteEditorKey, onNoteSave],
  );

  // Add/Edit/Remove note on a neutral (context) Link connection row. The
  // connection projection only carries a `preview` string (§ ConnectionOut);
  // the full ProseMirror body is fetched lazily on expand so Edit never
  // clobbers existing rich content with a plain-text reconstruction.
  const toggleLinkNote = useCallback(
    (connRow: ReaderConnectionRow) => {
      if (expandedLinkNoteIds.has(connRow.id)) {
        expandedLinkNoteIds.remove(connRow.id);
        return;
      }
      expandedLinkNoteIds.add(connRow.id);
      const linkNote = connRow.connection.link_note;
      if (!linkNote || fetchedLinkNotes.has(linkNote.note_block_id)) return;
      void fetchNoteBlock(linkNote.note_block_id)
        .then((block) => {
          setFetchedLinkNotes((previous) => {
            const next = new Map(previous);
            next.set(linkNote.note_block_id, {
              note_block_id: block.id,
              body_pm_json: block.bodyPmJson,
              body_text: block.bodyText,
            });
            return next;
          });
        })
        .catch((thrown: unknown) => {
          if (handleUnauthenticatedApiError(thrown)) return;
          feedback.show(toFeedback(thrown, { fallback: "Failed to load note" }));
        });
    },
    [expandedLinkNoteIds, feedback, fetchedLinkNotes],
  );

  const handleSaveLinkNote = useCallback(
    async (
      linkId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
    ): Promise<HighlightLinkedNoteBlock> => {
      const targetNoteBlockId = noteBlockId ?? createBlockId;
      const saved = await onSaveLinkNote(linkId, targetNoteBlockId, bodyPmJson);
      const block: HighlightLinkedNoteBlock = {
        note_block_id: saved.note_block_id,
        body_pm_json: bodyPmJson,
        body_text: "",
      };
      setFetchedLinkNotes((previous) => {
        const next = new Map(previous);
        next.set(saved.note_block_id, block);
        return next;
      });
      return block;
    },
    [onSaveLinkNote],
  );

  const removeLinkNote = useCallback(
    async (linkId: string, noteBlockId: string) => {
      await onDeleteLinkNote(linkId);
      setFetchedLinkNotes((previous) => {
        if (!previous.has(noteBlockId)) return previous;
        const next = new Map(previous);
        next.delete(noteBlockId);
        return next;
      });
    },
    [onDeleteLinkNote],
  );

  const handleDeleteLinkNote = useCallback(
    async (linkId: string, noteBlockId: string, _clientMutationId: string, shouldApply: () => boolean) => {
      // shouldApply guards the editor's own auto-delete-on-empty-body path
      // (see HighlightNoteEditor.saveDoc) against a resourceKey/edit-version
      // race; the explicit "Remove note" button below calls `removeLinkNote`
      // directly since it has no such race to guard against.
      await onDeleteLinkNote(linkId);
      if (shouldApply()) {
        setFetchedLinkNotes((previous) => {
          if (!previous.has(noteBlockId)) return previous;
          const next = new Map(previous);
          next.delete(noteBlockId);
          return next;
        });
      }
    },
    [onDeleteLinkNote],
  );

  const capabilities = readerApparatus?.capabilities ?? null;

  const { allRows, anchoredRows } = useMemo(() => {
    const merged: EvidenceRow[] = [];

    if (filter.highlight) {
      // One row per highlight id: a highlight data source can momentarily surface
      // the same highlight twice, and the sidecar keys rows by id, so collapse
      // duplicates here rather than emit two nodes with the same test id.
      const seenHighlightIds = new Set<string>();
      for (const h of highlights) {
        if (seenHighlightIds.has(h.id)) continue;
        seenHighlightIds.add(h.id);
        merged.push({ kind: "highlight", id: h.id, data: h });
      }
    }

    if (filter.apparatus) {
      for (const row of readerApparatusRows) {
        const anchor = toAnchoredApparatusRow(row);
        merged.push({ kind: "apparatus", id: row.id, data: row, anchor });
      }
    }

    if (filter.connection) {
      for (const row of connectionRows) {
        const anchor = anchoredRowFromConnection(row);
        merged.push({ kind: "connection", id: row.id, data: row, anchor });
      }
    }

    merged.sort((a, b) => {
      const ka = sortKeyForRow(a);
      const kb = sortKeyForRow(b);
      if (!ka && !kb) return 0;
      if (!ka) return 1;
      if (!kb) return -1;
      return ka.localeCompare(kb);
    });

    const anchored: AnchoredReaderRow[] = merged
      .map((row) => anchorForRow(row))
      .filter((a): a is AnchoredReaderRow => a !== null);

    return { allRows: merged, anchoredRows: anchored };
  }, [filter, highlights, readerApparatusRows, connectionRows]);

  const sidecarMeasureKey = [measureKey, noteLayoutVersion, layoutVersion].join("|");

  const header = (
    <header className={styles.header}>
      <h2 className={styles.title}>Evidence</h2>
      <nav className={styles.filterNav} aria-label="Evidence filter">
        <button
          type="button"
          className={`${styles.filterToggle} ${filter.highlight ? styles.filterToggleActive : ""}`}
          aria-pressed={filter.highlight}
          onClick={() => toggleFilter("highlight")}
        >
          Highlights
        </button>
        <button
          type="button"
          className={`${styles.filterToggle} ${filter.apparatus ? styles.filterToggleActive : ""}`}
          aria-pressed={filter.apparatus}
          onClick={() => toggleFilter("apparatus")}
        >
          Citations
        </button>
        <button
          type="button"
          className={`${styles.filterToggle} ${filter.connection ? styles.filterToggleActive : ""}`}
          aria-pressed={filter.connection}
          onClick={() => toggleFilter("connection")}
        >
          Connections
        </button>
      </nav>
    </header>
  );

  const renderRow = useCallback(
    (
      row: EvidenceRow,
      props: { className: string; style?: CSSProperties; ref: (el: HTMLElement | null) => void },
    ) => {
      if (row.kind === "highlight") {
        const highlight = row.data;
        const isFocused = focusedHighlightId === highlight.id;
        const linkedNotes = highlight.linked_note_blocks ?? [];
        const notesToRender = linkedNotes.length > 0 ? linkedNotes : [null];
        return (
          <ItemCard
            key={highlight.id}
            content={{
              kind: "highlight",
              snippet: { exact: highlight.exact, color: highlight.color },
            }}
            actions={
              <HighlightActionBar
                variant="existing"
                presentation="menu"
                highlight={highlight}
                canQuoteToChat={canQuoteToChat}
                isReflowable={isReflowable}
                isEditingBounds={isFocused && isEditingBounds}
                onSelectColor={(color) => onColorChange(highlight.id, color)}
                onLink={() => onLink({ kind: "existing", highlight })}
                onDelete={() => onDelete(highlight.id)}
                onQuoteToNewChat={() => onQuoteToChat(highlight.id)}
                onQuoteToExistingChat={() => onQuoteToChat(highlight.id)}
                onToggleEditBounds={() => {
                  if (isFocused && isEditingBounds) {
                    onCancelEditBounds();
                  } else {
                    onFocusHighlight(highlight.id);
                    onStartEditBounds();
                  }
                }}
              />
            }
            note={notesToRender.map((note) => {
              const key = getNoteEditorKey(highlight.id, note);
              return (
                <div key={key} data-note-editor-key={key}>
                  <HighlightNoteEditor
                    highlightId={highlight.id}
                    note={note}
                    editable
                    onSave={handleNoteSave}
                    onDelete={onNoteDelete}
                    onLocalChange={scheduleNoteLayoutMeasure}
                    onOpenLink={onOpenNoteLink}
                  />
                </div>
              );
            })}
            linkedItems={highlight.linked_conversations?.map((conv) => ({
              id: conv.conversation_id,
              icon: <MessageSquare size={14} aria-hidden="true" />,
              label: conv.title,
              onActivate: () => onOpenConversation(conv.conversation_id, conv.title),
            }))}
            meta={
              isFocused && isEditingBounds
                ? "Select new text in the reader to replace this highlight."
                : undefined
            }
            selected={isFocused}
            hovered={hoveredId === highlight.id}
            showFullText={expandedTextIds.ids.has(highlight.id)}
            onToggleFullText={() => {
              if (expandedTextIds.has(highlight.id)) {
                expandedTextIds.remove(highlight.id);
              } else {
                expandedTextIds.add(highlight.id);
              }
            }}
            rootRef={props.ref}
            style={props.style}
            className={props.className || undefined}
            highlightId={highlight.id}
            testId={`evidence-highlight-row-${highlight.id}`}
            onActivate={() => onHighlightClick(highlight.id)}
            onMouseEnter={() => onHoverHighlight(highlight.id)}
            onMouseLeave={() => onHoverHighlight(null)}
          />
        );
      }

      if (row.kind === "apparatus") {
        const { data: apparatusRow } = row;
        const presentation = capabilities
          ? readerApparatusRowPresentation(apparatusRow, capabilities)
          : null;
        const canActivate = presentation
          ? presentation.canActivateMarker || presentation.canActivateTarget
          : false;
        return (
          <button
            key={apparatusRow.id}
            ref={(el) => props.ref(el)}
            type="button"
            className={`${styles.apparatusCard} ${props.className}`}
            style={props.style}
            disabled={!canActivate}
            data-testid="evidence-apparatus-row"
            data-active={
              canActivate && focusedApparatusItemId === apparatusRow.id ? "true" : "false"
            }
            onClick={() => {
              if (canActivate) onApparatusRowActivate(apparatusRow);
            }}
          >
            <div className={styles.apparatusMeta}>
              <span className={styles.apparatusKind}>
                {kindLabel(apparatusRow.marker.kind)}
              </span>
              {apparatusRow.marker.confidence !== "exact" ? (
                <Pill tone="warning">{apparatusRow.marker.confidence}</Pill>
              ) : null}
            </div>
            <div className={styles.apparatusLabel}>
              {apparatusRow.marker.label ?? apparatusRow.target?.label ?? "Citation"}
            </div>
            {apparatusRow.targets.some((t) => t.body_text) ? (
              <div className={styles.apparatusBodyList}>
                {apparatusRow.targets
                  .filter((t) => t.body_text)
                  .map((t, i) => (
                    <p key={t.stable_key} className={styles.apparatusBody}>
                      {apparatusRow.targets.length > 1 ? (
                        <span className={styles.apparatusTargetLabel}>
                          {t.label ?? `Reference ${i + 1}`}
                        </span>
                      ) : null}
                      {t.body_text}
                    </p>
                  ))}
              </div>
            ) : presentation ? (
              <div className={styles.apparatusTargetMissing}>
                {presentation.targetStatusText}
              </div>
            ) : null}
          </button>
        );
      }

      if (row.kind === "connection") {
        const { data: connRow } = row;
        const Icon = resourceIconForUri(connRow.connection.other.ref);
        const isSynapse = connRow.connection.origin === "synapse";
        // "Stable" here means persisted (every row read off the connections
        // page is), as opposed to the Synapse-suggested rows that are only
        // ever dismissed, never removed as a user relation.
        const isUserLink = connRow.source_category === "user_link";
        const isNeutralLink = isUserLink && connRow.connection.kind === "context";
        const linkNote = connRow.connection.link_note ?? null;
        const noteExpanded = expandedLinkNoteIds.has(connRow.id);
        const fetchedNote = linkNote ? fetchedLinkNotes.get(linkNote.note_block_id) : undefined;
        const targetState = connectionTargetStatusText(connRow);
        return (
          <article
            key={connRow.id}
            ref={(el) => props.ref(el as HTMLElement | null)}
            className={`${styles.connectionCard} ${props.className}`}
            style={props.style}
          >
            <button
              type="button"
              className={styles.connectionButton}
              onClick={(event) => onOpenConnectionSource(connRow, event)}
            >
              <span className={styles.connectionMeta}>
                <span className={styles.connectionCategory}>
                  <Icon size={14} aria-hidden="true" />
                  {categoryLabel(connRow.source_category)}
                </span>
                <Pill
                  tone={connRow.connection.origin === "citation" ? "info" : "neutral"}
                >
                  {connRow.connection.kind}
                </Pill>
              </span>
              <span className={styles.connectionTitle}>{connRow.title}</span>
              {connRow.excerpt ? (
                isSynapse ? (
                  <MachineText
                    variant="inline"
                    origin={{ label: "Synapse" }}
                    className={styles.connectionExcerpt}
                  >
                    {connRow.excerpt}
                  </MachineText>
                ) : (
                  <span className={styles.connectionExcerpt}>{connRow.excerpt}</span>
                )
              ) : null}
              {targetState ? (
                <span className={styles.connectionTargetState}>{targetState}</span>
              ) : null}
            </button>
            <div className={styles.connectionActions}>
              {connRow.anchor ? (
                <button
                  type="button"
                  className={styles.connectionTargetButton}
                  onClick={() => onActivateConnectionTarget(connRow)}
                  aria-label={`Open target in reader for ${connRow.title}`}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  Target
                </button>
              ) : null}
              {isNeutralLink ? (
                <button
                  type="button"
                  className={styles.connectionTargetButton}
                  aria-pressed={noteExpanded}
                  aria-label={
                    linkNote
                      ? `Edit note on link to ${connRow.title}`
                      : `Add note to link to ${connRow.title}`
                  }
                  onClick={() => toggleLinkNote(connRow)}
                >
                  <MessageSquare size={13} aria-hidden="true" />
                  {linkNote ? "Note" : "Add note"}
                </button>
              ) : null}
              {isUserLink ? (
                <button
                  type="button"
                  className={styles.connectionDismissButton}
                  onClick={() => onRemoveLink(connRow)}
                  aria-label={`Remove connection to ${connRow.title}`}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
              {isSynapse ? (
                <button
                  type="button"
                  className={styles.connectionDismissButton}
                  onClick={() => onDismissSynapse(connRow.connection.edge_id)}
                  aria-label={`Dismiss Synapse connection to ${connRow.title}`}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {isNeutralLink && noteExpanded ? (
              <div className={styles.connectionNote}>
                {linkNote && fetchedNote === undefined ? (
                  <p className={styles.connectionNoteLoading}>Loading note…</p>
                ) : (
                  <>
                    <HighlightNoteEditor
                      highlightId={connRow.connection.edge_id}
                      note={linkNote ? fetchedNote ?? null : null}
                      editable
                      onSave={(linkId, noteBlockId, createBlockId, bodyPmJson) =>
                        handleSaveLinkNote(linkId, noteBlockId, createBlockId, bodyPmJson)
                      }
                      onDelete={handleDeleteLinkNote}
                      onOpenLink={onOpenNoteLink}
                    />
                    {linkNote ? (
                      <button
                        type="button"
                        className={styles.connectionNoteRemoveButton}
                        onClick={() => {
                          expandedLinkNoteIds.remove(connRow.id);
                          void removeLinkNote(connRow.connection.edge_id, linkNote.note_block_id);
                        }}
                      >
                        Remove note
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </article>
        );
      }

      return null;
    },
    [
      canQuoteToChat,
      capabilities,
      expandedLinkNoteIds,
      expandedTextIds,
      fetchedLinkNotes,
      focusedApparatusItemId,
      focusedHighlightId,
      getNoteEditorKey,
      handleDeleteLinkNote,
      handleNoteSave,
      handleSaveLinkNote,
      hoveredId,
      isEditingBounds,
      isReflowable,
      onActivateConnectionTarget,
      onApparatusRowActivate,
      onCancelEditBounds,
      onLink,
      onColorChange,
      onDelete,
      onDismissSynapse,
      onFocusHighlight,
      onHighlightClick,
      onHoverHighlight,
      onNoteDelete,
      onOpenConnectionSource,
      onOpenConversation,
      onOpenNoteLink,
      onQuoteToChat,
      onRemoveLink,
      onStartEditBounds,
      removeLinkNote,
      scheduleNoteLayoutMeasure,
      toggleLinkNote,
    ],
  );

  if (loading) {
    return (
      <section className={styles.root} aria-label="Evidence" data-testid="evidence-pane-surface">
        {header}
        <div className={styles.empty}>
          <FeedbackNotice severity="info" title="Loading evidence..." />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.root} aria-label="Evidence" data-testid="evidence-pane-surface">
        {header}
        <div className={styles.empty}>
          <FeedbackNotice feedback={error} />
        </div>
      </section>
    );
  }

  return (
    <AnchoredSidecarSurface
      ariaLabel="Evidence"
      header={header}
      rows={allRows}
      anchoredRows={anchoredRows}
      contentRef={contentRef}
      measureKey={sidecarMeasureKey}
      isMobile={isMobile}
      rowHeight={112}
      testId="evidence-pane-surface"
      empty={
        <FeedbackNotice
          severity="neutral"
          title="No highlights, citations, or connections in this context."
        />
      }
      idForRow={(row) => row.id}
      renderRow={renderRow}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortKeyForRow(row: EvidenceRow): string | null {
  if (row.kind === "highlight") return row.data.stable_order_key ?? null;
  if (row.kind === "apparatus") return row.data.sort_key;
  if (row.kind === "connection") return row.anchor?.stable_order_key ?? null;
  return null;
}

function anchorForRow(row: EvidenceRow): AnchoredReaderRow | null {
  if (row.kind === "highlight") return row.data;
  if (row.kind === "apparatus") return row.anchor;
  if (row.kind === "connection") return row.anchor;
  return null;
}

function toAnchoredApparatusRow(row: ReaderApparatusRow): AnchoredReaderRow | null {
  const locator = row.marker.locator ?? row.target?.locator ?? null;
  if (!locator) return null;
  const exact =
    row.marker.label ?? row.target?.label ?? row.target?.body_text ?? "Citation";
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
    if (quads.length === 0) return null;
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

function connectionTargetStatusText(row: ReaderConnectionRow): string | null {
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

function categoryLabel(category: ReaderConnectionRow["source_category"]): string {
  switch (category) {
    case "chat": return "Chat";
    case "dossier": return "Dossier";
    case "oracle": return "Oracle";
    case "note": return "Note";
    case "highlight_note": return "Highlight note";
    case "user_link": return "Link";
    case "synapse": return "Synapse";
    case "system": return "System";
    case "document_embed": return "Embedded media";
    default: return "Connection";
  }
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
    case "sidenote_ref":
    case "sidenote":
      return "Sidenote";
    case "margin_note_ref":
    case "margin_note":
      return "Margin note";
    case "reference_section":
      return "References";
    default:
      return "Citation";
  }
}
