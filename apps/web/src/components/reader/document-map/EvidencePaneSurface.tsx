"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { LocateFixed } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Chip from "@/components/ui/Chip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import type {
  ReaderEvidence,
  ReaderEvidenceItem,
  ReaderEvidenceObject,
  ReaderEvidencePassageGroup,
  ReaderEvidenceSourceTarget,
  ReaderEvidenceUserEdge,
} from "@/lib/reader/documentMap";
import { isReaderEvidenceUserLink } from "@/lib/reader/documentMap";
import {
  evidenceItemPassesFilters,
  type EvidenceFilters,
} from "@/lib/reader/useEvidenceFilters";
import styles from "./EvidencePaneSurface.module.css";
import {
  AssociationDisclosure,
  EvidenceItemRow,
  type EvidenceHighlightActions,
  type EvidenceLinkActions,
} from "./EvidenceItemRow";

type EvidenceScope = "passages" | "document";

export interface EvidencePaneSurfaceProps {
  evidence: ReaderEvidence | null;
  filters: EvidenceFilters;
  activeItemId: string | null;
  followGeneration: number;
  hoveredItemId: string | null;
  loading: boolean;
  error: FeedbackContent | null;
  aggregateStatus: "ready" | "empty" | "partial" | null;
  highlightActions: EvidenceHighlightActions;
  onActivatePassage: (group: ReaderEvidencePassageGroup) => boolean;
  onActivateObject: (
    object: ReaderEvidenceObject,
    options: { newPane: boolean },
  ) => void;
  onActivateSourceTarget: (
    target: ReaderEvidenceSourceTarget,
    options: { newPane: boolean },
  ) => void;
  onHoverItem: (item: ReaderEvidenceItem | null) => void;
  onDismissSynapse: (edgeId: string) => void;
  /** Remove an explicit user edge whether it is a top-level Link or folded
   * association. The caller dispatches context to Link DELETE and stances to
   * stance DELETE from the typed role; generated associations never qualify. */
  onRemoveUserEdge: (edge: ReaderEvidenceUserEdge) => void;
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

export default function EvidencePaneSurface({
  evidence,
  filters,
  activeItemId,
  followGeneration,
  hoveredItemId,
  loading,
  error,
  aggregateStatus,
  highlightActions,
  onActivatePassage,
  onActivateObject,
  onActivateSourceTarget,
  onHoverItem,
  onDismissSynapse,
  onRemoveUserEdge,
  onSaveLinkNote,
  onDeleteLinkNote,
}: EvidencePaneSurfaceProps) {
  const [scope, setScope] = useState<EvidenceScope>("passages");
  const [openDisclosureIds, setOpenDisclosureIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingHighlightId, setEditingHighlightId] = useState<string | null>(
    null,
  );
  // The one open link-note editor, keyed by the Link's edge id (mirrors
  // editingHighlightId's single-editor rule for the folded link note).
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const visiblePassageGroups = useMemo(
    () =>
      (evidence?.passage_groups ?? [])
        .map((group) => ({
          group,
          items: group.items.filter((item) =>
            evidenceItemPassesFilters(item, filters.filter),
          ),
        }))
        .filter(({ items }) => items.length > 0),
    [evidence?.passage_groups, filters.filter],
  );
  const visibleDocumentItems = useMemo(
    () =>
      (evidence?.document_items ?? []).filter((item) =>
        evidenceItemPassesFilters(item, filters.filter),
      ),
    [evidence?.document_items, filters.filter],
  );
  const resolvedGroups = visiblePassageGroups.filter(
    ({ group }) => group.resolution.kind === "Resolved",
  );
  const unavailableGroups = visiblePassageGroups.filter(
    ({ group }) => group.resolution.kind === "Unavailable",
  );
  const currentScopeHasRows =
    scope === "passages"
      ? visiblePassageGroups.length > 0
      : visibleDocumentItems.length > 0;
  const currentScopeFactCount = evidence
    ? scope === "passages"
      ? evidence.passage_groups.reduce(
          (count, group) => count + group.items.length,
          0,
        )
      : evidence.document_items.length
    : 0;
  const anyFilterEnabled = Object.values(filters.filter).some(Boolean);
  const totalFacts = evidence
    ? evidence.counts.highlights +
      evidence.counts.citations +
      evidence.counts.links +
      evidence.counts.synapses
    : 0;

  // Drop the open link-note editor when its Link fact leaves the evidence set.
  useEffect(() => {
    if (!editingLinkId || !evidence) return;
    const exists = [
      ...evidence.passage_groups.flatMap((group) => group.items),
      ...evidence.document_items,
    ].some(
      (item) =>
        isReaderEvidenceUserLink(item) &&
        item.role === "context" &&
        item.edge_id === editingLinkId,
    );
    if (!exists) setEditingLinkId(null);
  }, [editingLinkId, evidence]);

  const linkActions: EvidenceLinkActions = {
    editingLinkId,
    onRemoveUserEdge,
    onEditLink: setEditingLinkId,
    onSaveLinkNote,
    onDeleteLinkNote,
  };

  useEffect(() => {
    if (!activeItemId || followPaused) return;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-evidence-item-id="${CSS.escape(activeItemId)}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [activeItemId, followGeneration, followPaused, scope]);

  useEffect(() => {
    if (!activeItemId || followGeneration === 0) return;
    setScope("passages");
    setFollowPaused(false);
  }, [activeItemId, followGeneration]);

  useEffect(() => {
    if (!editingHighlightId || !evidence) return;
    const exists = [
      ...evidence.passage_groups.flatMap((group) => group.items),
      ...evidence.document_items,
    ].some(
      (item) =>
        item.kind === "Highlight" && item.highlight_id === editingHighlightId,
    );
    if (!exists) setEditingHighlightId(null);
  }, [editingHighlightId, evidence]);

  const toggleDisclosure = (id: string) => {
    setOpenDisclosureIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pauseFollow = () => setFollowPaused(true);
  const handleListPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) pauseFollow();
  };
  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target === event.currentTarget &&
      MANUAL_SCROLL_KEYS.has(event.key)
    ) {
      pauseFollow();
    }
  };

  const header = (
    <header className={styles.header}>
      <h2 className={styles.title}>Evidence</h2>
      <TabsList aria-label="Evidence scope" className={styles.scopeTabs}>
        <TabsTrigger
          id="evidence-scope-passages"
          value="passages"
          aria-controls="evidence-panel-passages"
        >
          Passages{" "}
          <span className={styles.count}>{evidence?.counts.passages ?? 0}</span>
        </TabsTrigger>
        <TabsTrigger
          id="evidence-scope-document"
          value="document"
          aria-controls="evidence-panel-document"
        >
          Whole document{" "}
          <span className={styles.count}>{evidence?.counts.document ?? 0}</span>
        </TabsTrigger>
      </TabsList>
      <div className={styles.filters} role="group" aria-label="Evidence types">
        <Chip
          pressed={filters.filter.highlight}
          onPressedChange={() => filters.toggleFilter("highlight")}
        >
          Highlights {evidence?.counts.highlights ?? 0}
        </Chip>
        <Chip
          pressed={filters.filter.citation}
          onPressedChange={() => filters.toggleFilter("citation")}
        >
          Citations {evidence?.counts.citations ?? 0}
        </Chip>
        <Chip
          pressed={filters.filter.link}
          onPressedChange={() => filters.toggleFilter("link")}
        >
          Links {evidence?.counts.links ?? 0}
        </Chip>
        <Chip
          pressed={filters.filter.synapse}
          onPressedChange={() => filters.toggleFilter("synapse")}
        >
          Synapses {evidence?.counts.synapses ?? 0}
        </Chip>
      </div>
      {followPaused && activeItemId ? (
        <button
          type="button"
          className={styles.followButton}
          onClick={() => {
            setScope("passages");
            setFollowPaused(false);
          }}
        >
          <LocateFixed size={13} aria-hidden="true" />
          Return to current passage
        </button>
      ) : null}
    </header>
  );

  let content;
  if (loading) {
    content = <FeedbackNotice severity="info" title="Loading evidence..." />;
  } else if (error) {
    content = <FeedbackNotice feedback={error} />;
  } else if (totalFacts === 0) {
    content = (
      <FeedbackNotice
        severity="neutral"
        title="No highlights, citations, links, or Synapses in this document."
      />
    );
  } else if (currentScopeFactCount === 0) {
    content = (
      <FeedbackNotice
        severity="neutral"
        title={
          scope === "passages"
            ? "No passage-aligned evidence in this document."
            : "No whole-document evidence in this document."
        }
      />
    );
  } else if (!anyFilterEnabled || !currentScopeHasRows) {
    content = (
      <div className={styles.filteredEmpty}>
        <FeedbackNotice
          severity="neutral"
          title="No evidence matches these filters."
        />
        <button
          type="button"
          className={styles.showAllButton}
          onClick={filters.showAll}
        >
          Show all
        </button>
      </div>
    );
  } else if (scope === "passages") {
    content = (
      <>
        {resolvedGroups.map(({ group, items }) => (
          <PassageGroup
            key={group.locus_ref}
            group={group}
            items={items}
            activeItemId={activeItemId}
            hoveredItemId={hoveredItemId}
            openDisclosureIds={openDisclosureIds}
            editingHighlightId={editingHighlightId}
            highlightActions={highlightActions}
            onActivate={() => {
              if (onActivatePassage(group)) setFollowPaused(false);
            }}
            onToggleDisclosure={toggleDisclosure}
            onEditHighlight={setEditingHighlightId}
            onActivateObject={onActivateObject}
            onActivateSourceTarget={onActivateSourceTarget}
            onHoverItem={onHoverItem}
            onDismissSynapse={onDismissSynapse}
            linkActions={linkActions}
          />
        ))}
        {unavailableGroups.length > 0 ? (
          <section
            className={styles.attention}
            aria-labelledby="evidence-needs-attention"
          >
            <h3 id="evidence-needs-attention" className={styles.sectionHeading}>
              Needs attention
            </h3>
            {unavailableGroups.map(({ group, items }) => (
              <PassageGroup
                key={group.locus_ref}
                group={group}
                items={items}
                activeItemId={activeItemId}
                hoveredItemId={hoveredItemId}
                openDisclosureIds={openDisclosureIds}
                editingHighlightId={editingHighlightId}
                highlightActions={highlightActions}
                onActivate={() => {}}
                onToggleDisclosure={toggleDisclosure}
                onEditHighlight={setEditingHighlightId}
                onActivateObject={onActivateObject}
                onActivateSourceTarget={onActivateSourceTarget}
                onHoverItem={onHoverItem}
                onDismissSynapse={onDismissSynapse}
                linkActions={linkActions}
              />
            ))}
          </section>
        ) : null}
      </>
    );
  } else {
    content = (
      <div className={styles.documentList}>
        {visibleDocumentItems.map((item) => (
          <EvidenceItemRow
            key={item.id}
            item={item}
            group={null}
            active={activeItemId === item.id}
            hovered={hoveredItemId === item.id}
            disclosureOpen={openDisclosureIds.has(`item:${item.id}`)}
            editing={
              item.kind === "Highlight" &&
              editingHighlightId === item.highlight_id
            }
            highlightActions={highlightActions}
            onToggleDisclosure={() => toggleDisclosure(`item:${item.id}`)}
            onEditHighlight={setEditingHighlightId}
            onActivateObject={onActivateObject}
            onActivateSourceTarget={onActivateSourceTarget}
            onHoverItem={onHoverItem}
            onDismissSynapse={onDismissSynapse}
            linkActions={linkActions}
          />
        ))}
      </div>
    );
  }

  return (
    <Tabs
      value={scope}
      onValueChange={(value) => {
        if (value !== "passages" && value !== "document") {
          throw new Error(`Unsupported Evidence scope: ${value}`);
        }
        setScope(value);
      }}
      variant="segmented"
      className={styles.root}
      aria-label="Evidence"
      data-testid="evidence-pane-surface"
    >
      {header}
      {aggregateStatus === "partial" && !loading && !error ? (
        <FeedbackNotice
          severity="warning"
          title="Some document evidence is unavailable."
        />
      ) : null}
      <TabsContent
        id="evidence-panel-passages"
        value="passages"
        aria-labelledby="evidence-scope-passages"
        className={styles.tabPanel}
      >
        <div
          ref={scope === "passages" ? listRef : undefined}
          className={styles.list}
          aria-label="Passage evidence"
          tabIndex={0}
          onWheel={pauseFollow}
          onTouchMove={pauseFollow}
          onPointerDown={handleListPointerDown}
          onKeyDown={handleListKeyDown}
        >
          {scope === "passages" ? content : null}
        </div>
      </TabsContent>
      <TabsContent
        id="evidence-panel-document"
        value="document"
        aria-labelledby="evidence-scope-document"
        className={styles.tabPanel}
      >
        <div
          ref={scope === "document" ? listRef : undefined}
          className={styles.list}
          aria-label="Whole-document evidence"
          tabIndex={0}
          onWheel={pauseFollow}
          onTouchMove={pauseFollow}
          onPointerDown={handleListPointerDown}
          onKeyDown={handleListKeyDown}
        >
          {scope === "document" ? content : null}
        </div>
      </TabsContent>
    </Tabs>
  );
}

function PassageGroup({
  group,
  items,
  activeItemId,
  hoveredItemId,
  openDisclosureIds,
  editingHighlightId,
  highlightActions,
  onActivate,
  onToggleDisclosure,
  onEditHighlight,
  onActivateObject,
  onActivateSourceTarget,
  onHoverItem,
  onDismissSynapse,
  linkActions,
}: {
  group: ReaderEvidencePassageGroup;
  items: ReaderEvidenceItem[];
  activeItemId: string | null;
  hoveredItemId: string | null;
  openDisclosureIds: Set<string>;
  editingHighlightId: string | null;
  highlightActions: EvidenceHighlightActions;
  onActivate: () => void;
  onToggleDisclosure: (id: string) => void;
  onEditHighlight: (highlightId: string | null) => void;
  onActivateObject: EvidencePaneSurfaceProps["onActivateObject"];
  onActivateSourceTarget: EvidencePaneSurfaceProps["onActivateSourceTarget"];
  onHoverItem: EvidencePaneSurfaceProps["onHoverItem"];
  onDismissSynapse: (edgeId: string) => void;
  linkActions: EvidenceLinkActions;
}) {
  const resolved = group.resolution.kind === "Resolved";
  const active = group.items.some((item) => item.id === activeItemId);
  const passageLabel =
    group.target_excerpt.kind === "Present" && group.target_excerpt.value.trim()
      ? group.target_excerpt.value
      : "Passage";
  const groupDisclosureId = `group:${group.locus_ref}`;
  return (
    <section className={styles.group} data-active={active ? "true" : undefined}>
      <div className={styles.groupHeader}>
        <div className={styles.groupTarget}>
          <span className={styles.groupKicker}>
            {resolved ? "Passage" : "Unavailable passage"}
          </span>
          <span className={styles.groupLabel}>{passageLabel}</span>
          {!resolved ? (
            <span className={styles.unavailableReason}>
              {unavailableReason(group)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.jumpButton}
          disabled={!resolved}
          aria-current={active && resolved ? "location" : undefined}
          aria-label={
            resolved ? `Jump to ${passageLabel}` : "Passage unavailable"
          }
          onClick={onActivate}
        >
          <LocateFixed size={14} aria-hidden="true" />
          Jump
        </button>
      </div>
      <div className={styles.groupItems}>
        {items.map((item) => (
          <EvidenceItemRow
            key={item.id}
            item={item}
            group={group}
            active={activeItemId === item.id}
            hovered={hoveredItemId === item.id}
            disclosureOpen={openDisclosureIds.has(`item:${item.id}`)}
            editing={
              item.kind === "Highlight" &&
              editingHighlightId === item.highlight_id
            }
            highlightActions={highlightActions}
            onToggleDisclosure={() => onToggleDisclosure(`item:${item.id}`)}
            onEditHighlight={onEditHighlight}
            onActivateObject={onActivateObject}
            onActivateSourceTarget={onActivateSourceTarget}
            onHoverItem={onHoverItem}
            onDismissSynapse={onDismissSynapse}
            linkActions={linkActions}
          />
        ))}
      </div>
      {group.also_references.length > 0 ? (
        <AssociationDisclosure
          label="Also references this passage"
          associations={group.also_references}
          open={openDisclosureIds.has(groupDisclosureId)}
          onToggle={() => onToggleDisclosure(groupDisclosureId)}
          onActivateObject={onActivateObject}
          onRemoveUserEdge={linkActions.onRemoveUserEdge}
        />
      ) : null}
    </section>
  );
}

function unavailableReason(group: ReaderEvidencePassageGroup): string {
  if (group.resolution.kind !== "Unavailable") return "";
  switch (group.resolution.reason) {
    case "Missing":
      return "The target no longer exists.";
    case "Unanchorable":
      return "This target cannot be placed in the reader.";
    case "Stale":
      return "The source changed after this target was created.";
  }
}

const MANUAL_SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);
