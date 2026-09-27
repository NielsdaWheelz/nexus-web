"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type CSSProperties,
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
  ReaderEvidenceSourceActivation,
  ReaderEvidenceSourceTarget,
  ReaderEvidenceUserEdge,
} from "@/lib/reader/documentMap";
import { isReaderEvidenceUserLink } from "@/lib/reader/documentMap";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import {
  evidenceItemPassesFilters,
  type EvidenceFilters,
} from "@/lib/reader/useEvidenceFilters";
import { anchoredRowForEvidenceItem, placeEvidenceGroups } from "@/lib/reader/evidencePlacement";
import { useAnchoredReaderProjection, type AnchoredReaderRow } from "../useAnchoredReaderProjection";
import styles from "./EvidencePaneSurface.module.css";
import {
  AssociationDisclosure,
  EvidenceItemRow,
  type EvidenceHighlightActions,
  type EvidenceLinkActions,
  type EvidenceRowActions,
} from "./EvidenceItemRow";

type EvidenceScope = "all" | "document";
const NO_ANCHORS: AnchoredReaderRow[] = [];

export interface EvidenceHighlightEditRequest {
  highlightId: string;
  requestId: number;
}

/** One closed projection for the always-published Media Evidence surface. */
export type EvidencePaneProjection =
  | { kind: "Processing"; source: "media" | "evidence" }
  | { kind: "IngestFailed"; feedback: FeedbackContent }
  | { kind: "Empty" }
  | {
      kind: "Ready";
      evidence: ReaderEvidence;
      aggregateStatus: "ready" | "partial";
    };

interface EvidencePaneSurfaceProps {
  projection: EvidencePaneProjection;
  placement: {
    contentRef: RefObject<HTMLElement | null>;
    measureKey: string | number;
    enabled: boolean;
  };
  filters: EvidenceFilters;
  activeItemId: string | null;
  followGeneration: number;
  highlightEditRequest: EvidenceHighlightEditRequest | null;
  onHighlightEditClose: (highlightId: string) => void;
  hoveredItemId: string | null;
  highlightActions: EvidenceHighlightActions;
  onActivatePassage: (group: ReaderEvidencePassageGroup) => boolean;
  onActivateObject: (
    object: ReaderEvidenceObject,
    disposition: WorkspaceTargetDisposition,
  ) => void;
  onActivateSourceTarget: (
    activation: ReaderEvidenceSourceActivation,
    disposition: WorkspaceTargetDisposition,
  ) => void;
  onOpenSourceLink: (
    href: string,
    disposition: WorkspaceTargetDisposition,
    opener: ReaderEvidenceSourceActivation,
  ) => void;
  onHoverItem: (item: ReaderEvidenceItem | null) => void;
  onDismissSynapse: (edgeId: string) => Promise<void>;
  /** Remove an explicit user edge whether it is a top-level Link or folded
   * association. The caller dispatches context to Link DELETE and stances to
   * stance DELETE from the typed role; generated associations never qualify. */
  onRemoveUserEdge: (edge: ReaderEvidenceUserEdge) => Promise<void>;
  /** Add/edit the one ordinary note folded onto a neutral (context) Link — mirrors
   * `links.ts` `putLinkNote(linkId, {noteBlockId, bodyPmJson, clientMutationId})`. */
  onSaveLinkNote: (
    linkId: string,
    noteBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string,
  ) => Promise<{ note_block_id: string }>;
  /** Remove the Link's note; mirrors `links.ts` `deleteLinkNote(linkId)`. The Link
   * itself is preserved. */
  onDeleteLinkNote: (linkId: string) => Promise<void>;
}

export default function EvidencePaneSurface({
  projection,
  placement,
  filters,
  activeItemId,
  followGeneration,
  highlightEditRequest,
  onHighlightEditClose,
  hoveredItemId,
  highlightActions,
  onActivatePassage,
  onActivateObject,
  onActivateSourceTarget,
  onOpenSourceLink,
  onHoverItem,
  onDismissSynapse,
  onRemoveUserEdge,
  onSaveLinkNote,
  onDeleteLinkNote,
}: EvidencePaneSurfaceProps) {
  const evidence = projection.kind === "Ready" ? projection.evidence : null;
  const aggregateStatus =
    projection.kind === "Ready" ? projection.aggregateStatus : null;
  const [scope, setScope] = useState<EvidenceScope>("all");
  const [openDisclosureIds, setOpenDisclosureIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingHighlightId, setEditingHighlightId] = useState<string | null>(
    null,
  );
  // The one open link-note editor, keyed by the Link's edge id (mirrors
  // editingHighlightId's single-editor rule for the folded link note).
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [mode, setMode] = useState<"follow" | "browse">("follow");
  const listRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const browseAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const pendingRevealRef = useRef<string | null>(null);
  const lastActivationRef = useRef<{ itemId: string; generation: number } | null>(null);
  const lastHighlightEditRef = useRef<EvidenceHighlightEditRequest | null>(null);
  const [revealedItemId, setRevealedItemId] = useState<string | null>(null);
  const [browseInset, setBrowseInset] = useState(0);
  const [heights, setHeights] = useState(new Map<string, number>());
  const [listGeometry, setListGeometry] = useState({ top: 0, height: 0 });
  const [remainingCount, setRemainingCount] = useState(0);
  const following = placement.enabled && mode === "follow" && scope === "all";
  const sourceTargets = useMemo(
    () => new Map((evidence?.source_targets ?? []).map((target) => [target.ref, target])),
    [evidence?.source_targets],
  );

  const browse = useCallback((target?: EventTarget | null) => {
    if (!following) return;
    const list = listRef.current;
    if (list) {
      const row = target instanceof Element
        ? target.closest<HTMLElement>("[data-evidence-item-id]")
        : null;
      const anchor = row ?? Array.from(
        list.querySelectorAll<HTMLElement>("[data-evidence-item-id]"),
      ).find((element) => element.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      if (anchor) browseAnchorRef.current = { element: anchor, top: anchor.getBoundingClientRect().top };
    }
    setMode("browse");
  }, [following]);

  const resumeFollow = () => {
    browseAnchorRef.current = null;
    pendingRevealRef.current = null;
    setRevealedItemId(null);
    setBrowseInset(0);
    setScope("all");
    if (listRef.current) listRef.current.scrollTop = 0;
    setMode("follow");
  };

  const visiblePassageGroups = useMemo(
    () =>
      (evidence?.passage_groups ?? [])
        .map((group) => ({
          group,
          items: group.items.filter((item) =>
            evidenceItemPassesFilters(item, filters.filter) || item.id === revealedItemId,
          ),
        }))
        .filter(({ items }) => items.length > 0),
    [evidence?.passage_groups, filters.filter, revealedItemId],
  );
  const visibleDocumentItems = useMemo(
    () =>
      (evidence?.document_items ?? []).filter((item) =>
        evidenceItemPassesFilters(item, filters.filter) || item.id === revealedItemId,
      ),
    [evidence?.document_items, filters.filter, revealedItemId],
  );
  const anchorRows = useMemo(() => visiblePassageGroups.flatMap(({ group, items }) => {
    const first = items[0];
    const anchor = first ? anchoredRowForEvidenceItem(group, first) : null;
    return anchor ? [{ ...anchor, id: group.locus_ref }] : [];
  }), [visiblePassageGroups]);
  const { projections, viewportState } = useAnchoredReaderProjection({
    contentRef: placement.contentRef,
    rows: following ? anchorRows : NO_ANCHORS,
    measureKey: placement.measureKey,
  });
  const positions = useMemo(() => placeEvidenceGroups(
    projections.map(({ row, rect }) => ({
      id: row.id,
      desiredTop: rect.top - viewportState.scrollTop + viewportState.top - listGeometry.top,
    })), heights, 12,
  ), [projections, viewportState, listGeometry.top, heights]);
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const displayedGroups = following
    ? visiblePassageGroups.filter(({ group }) => positionById.has(group.locus_ref))
    : visiblePassageGroups;
  const displayedGroupKey = displayedGroups.map(({ group }) => group.locus_ref).join("|");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const rect = list.getBoundingClientRect();
      setListGeometry((previous) => previous.top === rect.top && previous.height === list.clientHeight
        ? previous : { top: rect.top, height: list.clientHeight });
      const next = new Map<string, number>();
      for (const [id, element] of groupRefs.current) next.set(id, element.getBoundingClientRect().height);
      setHeights((previous) => previous.size === next.size &&
        Array.from(next).every(([id, height]) => previous.get(id) === height) ? previous : next);
      setRemainingCount(following ? Array.from(
        list.querySelectorAll<HTMLElement>("[data-evidence-item-id]"),
      ).filter((element) => element.getBoundingClientRect().bottom > rect.bottom + 1).length : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const element of groupRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [displayedGroupKey, scope, placement.measureKey, following, positions]);

  useLayoutEffect(() => {
    if (!activeItemId || followGeneration === 0) return;
    if (lastActivationRef.current?.itemId === activeItemId &&
      lastActivationRef.current.generation === followGeneration) return;
    lastActivationRef.current = { itemId: activeItemId, generation: followGeneration };
    browse();
    setMode("browse");
    setScope(evidence?.document_items.some((item) => item.id === activeItemId) ? "document" : "all");
    setRevealedItemId(activeItemId);
    pendingRevealRef.current = activeItemId;
  }, [activeItemId, followGeneration, browse, evidence?.document_items]);

  useLayoutEffect(() => {
    const request = highlightEditRequest;
    if (!request || !evidence ||
        (lastHighlightEditRef.current?.highlightId === request.highlightId &&
         lastHighlightEditRef.current.requestId === request.requestId)) return;
    const item = [...evidence.passage_groups.flatMap((group) => group.items), ...evidence.document_items]
      .find((candidate) => candidate.kind === "Highlight" && candidate.highlight_id === request.highlightId);
    if (!item) return;
    lastHighlightEditRef.current = request;
    browse();
    setMode("browse");
    setScope("all");
    setRevealedItemId(item.id);
    setEditingHighlightId(request.highlightId);
    pendingRevealRef.current = item.id;
  }, [browse, evidence, highlightEditRequest]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const anchor = browseAnchorRef.current;
    if (!list || mode !== "browse") return;
    if (anchor?.element.isConnected) {
      const desired = list.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top;
      if (desired < 0) {
        setBrowseInset((previous) => previous - desired);
        return;
      }
      list.scrollTop = desired;
    }
    browseAnchorRef.current = null;
    const revealId = pendingRevealRef.current;
    if (!revealId) return;
    const row = list.querySelector<HTMLElement>(`[data-evidence-item-id="${CSS.escape(revealId)}"]`);
    if (!row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.top - listRect.top;
    }
    pendingRevealRef.current = null;
  }, [mode, browseInset, revealedItemId, scope, listGeometry.height, followGeneration, editingHighlightId, evidence]);
  const currentScopeHasRows =
    scope === "all"
      ? visiblePassageGroups.length > 0 || visibleDocumentItems.length > 0
      : visibleDocumentItems.length > 0;
  const currentScopeFactCount = evidence
    ? scope === "all"
      ? evidence.passage_groups.reduce(
          (count, group) => count + group.items.length,
          evidence.document_items.length,
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
    onEditLink: (id) => { browse(); setEditingLinkId(id); },
    onSaveLinkNote,
    onDeleteLinkNote,
  };

  useEffect(() => {
    if (!editingHighlightId || (evidence === null && projection.kind !== "Empty")) return;
    const exists = [
      ...(evidence?.passage_groups.flatMap((group) => group.items) ?? []),
      ...(evidence?.document_items ?? []),
    ].some(
      (item) =>
        item.kind === "Highlight" && item.highlight_id === editingHighlightId,
    );
    if (!exists) {
      setEditingHighlightId(null);
      onHighlightEditClose(editingHighlightId);
    }
  }, [editingHighlightId, evidence, onHighlightEditClose, projection.kind]);

  const toggleDisclosure = (id: string) => {
    browse();
    setOpenDisclosureIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rowActions: EvidenceRowActions = {
    onToggleDisclosure: toggleDisclosure,
    onEditHighlight: (id) => {
      browse();
      if (editingHighlightId && editingHighlightId !== id) {
        onHighlightEditClose(editingHighlightId);
      }
      setEditingHighlightId(id);
    },
    onActivateObject,
    onActivateSourceTarget,
    onOpenSourceLink,
    onHoverItem,
    onDismissSynapse,
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (MANUAL_SCROLL_KEYS.has(event.key)) browse(event.target);
  };

  const header = (
    <header className={styles.header}>
      <h2 className={styles.title}>Evidence</h2>
      <TabsList aria-label="By location" className={styles.scopeTabs}>
        <TabsTrigger
          id="evidence-scope-all"
          value="all"
          aria-controls="evidence-panel-all"
        >
          All evidence{" "}
          <span className={styles.count}>{totalFacts}</span>
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
      <div className={styles.filters} role="group" aria-label="Filter by type">
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
      <div className={styles.viewControls}>
        {following ? (
          <button type="button" className={styles.followButton} onClick={() => browse()}>
            all items
          </button>
        ) : placement.enabled ? (
          <button type="button" className={styles.followButton} onClick={resumeFollow}>
            <LocateFixed size={13} aria-hidden="true" /> follow text
          </button>
        ) : null}
        {following && remainingCount > 0 ? <span className={styles.remaining}>{remainingCount} {remainingCount === 1 ? "item" : "items"} below</span> : null}
      </div>
    </header>
  );

  const documentRows = visibleDocumentItems.map((item) => (
    <EvidenceItemRow
      key={item.id}
      item={item}
      group={null}
      sourceTargets={sourceTargets}
      sourceExpansionRequest={revealedItemId === item.id ? followGeneration : null}
      onBrowse={browse}
      active={activeItemId === item.id}
      hovered={hoveredItemId === item.id}
      disclosureOpen={openDisclosureIds.has(`item:${item.id}`)}
      editing={item.kind === "Highlight" && editingHighlightId === item.highlight_id}
      highlightActions={highlightActions}
      linkActions={linkActions}
      rowActions={rowActions}
    />
  ));

  let content;
  if (projection.kind === "Processing") {
    content = (
      <FeedbackNotice
        content={{
          tone: "Info",
          title:
            projection.source === "media"
              ? "This media is still being processed."
              : "Loading reader items…",
        }}
        announcement="Polite"
      />
    );
  } else if (projection.kind === "IngestFailed") {
    content = <FeedbackNotice content={projection.feedback} announcement="Assertive" />;
  } else if (projection.kind === "Empty" || totalFacts === 0) {
    content = (
      <FeedbackNotice
        content={{
          tone: "Neutral",
          title: "No reader evidence in this document.",
        }}
        announcement="None"
      />
    );
  } else if (currentScopeFactCount === 0) {
    content = (
      <FeedbackNotice
        content={{
          tone: "Neutral",
          title: scope === "all"
            ? "No evidence in this document."
            : "No whole-document evidence in this document.",
        }}
        announcement="None"
      />
    );
  } else if ((!anyFilterEnabled && revealedItemId === null) || !currentScopeHasRows) {
    content = (
      <div className={styles.filteredEmpty}>
        <FeedbackNotice
          content={{ tone: "Neutral", title: "No items match these filters." }}
          announcement="None"
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
  } else if (scope === "all") {
    content = (
      <div className={styles.passageList} style={{ paddingTop: following ? 0 : browseInset, paddingBottom: following ? 0 : listGeometry.height }}>
        {following && displayedGroups.length === 0 ? <p className={styles.noCurrentEvidence}>no evidence beside this passage</p> : null}
        {displayedGroups.map(({ group, items }) => (
          <PassageGroup
            key={group.locus_ref}
            group={group}
            items={items}
            containerRef={(element) => {
              if (element) groupRefs.current.set(group.locus_ref, element);
              else groupRefs.current.delete(group.locus_ref);
            }}
            style={following ? { marginTop: positionById.get(group.locus_ref)?.gapBefore ?? 0 } : undefined}
            sourceTargets={sourceTargets}
            sourceExpandedId={revealedItemId}
            sourceExpansionRequest={followGeneration}
            onBrowse={browse}
            activeItemId={activeItemId}
            hoveredItemId={hoveredItemId}
            openDisclosureIds={openDisclosureIds}
            editingHighlightId={editingHighlightId}
            highlightActions={highlightActions}
            onActivate={() => { browse(); onActivatePassage(group); }}
            linkActions={linkActions}
            rowActions={rowActions}
          />
        ))}
        {!following && documentRows.length > 0 ? (
          <section className={styles.documentList} aria-label="Whole-document evidence">
            <h3 className={styles.sectionHeading}>Whole document</h3>
            {documentRows}
          </section>
        ) : null}
      </div>
    );
  } else {
    content = (
      <div className={styles.documentList}>
        {documentRows}
      </div>
    );
  }

  return (
    <Tabs
      value={scope}
      onValueChange={(value) => {
        if (value !== "all" && value !== "document") {
          throw new Error(`Unsupported Evidence scope: ${value}`);
        }
        browse();
        setMode("browse");
        setScope(value);
      }}
      variant="segmented"
      className={styles.root}
      role="group"
      aria-label="Evidence"
      data-evidence-mode={following ? "follow" : "browse"}
    >
      {header}
      {aggregateStatus === "partial" ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "Some reader items are unavailable." }}
          announcement="Polite"
        />
      ) : null}
      <TabsContent
        id="evidence-panel-all"
        value="all"
        aria-labelledby="evidence-scope-all"
        className={styles.tabPanel}
      >
        <div
          ref={scope === "all" ? listRef : undefined}
          className={styles.list}
          role="group"
          aria-label="All evidence"
          tabIndex={0}
          onWheelCapture={(event) => browse(event.target)}
          onTouchMoveCapture={(event) => browse(event.target)}
          onPointerDownCapture={(event) => browse(event.target)}
          onFocusCapture={(event) => browse(event.target)}
          onKeyDownCapture={handleListKeyDown}
          onScroll={(event) => { if (event.currentTarget.scrollTop !== 0) browse(); }}
        >
          {scope === "all" ? content : null}
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
          role="group"
          aria-label="Whole-document items"
          tabIndex={0}
          onWheelCapture={(event) => browse(event.target)}
          onTouchMoveCapture={(event) => browse(event.target)}
          onPointerDownCapture={(event) => browse(event.target)}
          onFocusCapture={(event) => browse(event.target)}
          onKeyDownCapture={handleListKeyDown}
          onScroll={(event) => { if (event.currentTarget.scrollTop !== 0) browse(); }}
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
  containerRef,
  style,
  sourceTargets,
  sourceExpandedId,
  sourceExpansionRequest,
  onBrowse,
  activeItemId,
  hoveredItemId,
  openDisclosureIds,
  editingHighlightId,
  highlightActions,
  onActivate,
  linkActions,
  rowActions,
}: {
  group: ReaderEvidencePassageGroup;
  items: ReaderEvidenceItem[];
  containerRef: (element: HTMLElement | null) => void;
  style: CSSProperties | undefined;
  sourceTargets: ReadonlyMap<string, ReaderEvidenceSourceTarget>;
  sourceExpandedId: string | null;
  sourceExpansionRequest: number;
  onBrowse: () => void;
  activeItemId: string | null;
  hoveredItemId: string | null;
  openDisclosureIds: Set<string>;
  editingHighlightId: string | null;
  highlightActions: EvidenceHighlightActions;
  onActivate: () => void;
  linkActions: EvidenceLinkActions;
  rowActions: EvidenceRowActions;
}) {
  const resolved = group.resolution.kind === "Resolved";
  const active = group.items.some((item) => item.id === activeItemId);
  const passageLabel =
    group.target_excerpt.kind === "Present" && group.target_excerpt.value.trim()
      ? group.target_excerpt.value
      : "Passage";
  const groupDisclosureId = `group:${group.locus_ref}`;
  return (
    <section ref={containerRef} style={style} className={styles.group}
      data-evidence-group-id={group.locus_ref} data-active={active ? "true" : undefined}>
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
            sourceTargets={sourceTargets}
            sourceExpansionRequest={sourceExpandedId === item.id ? sourceExpansionRequest : null}
            onBrowse={onBrowse}
            active={activeItemId === item.id}
            hovered={hoveredItemId === item.id}
            disclosureOpen={openDisclosureIds.has(`item:${item.id}`)}
            editing={
              item.kind === "Highlight" &&
              editingHighlightId === item.highlight_id
            }
            highlightActions={highlightActions}
            linkActions={linkActions}
            rowActions={rowActions}
          />
        ))}
      </div>
      {group.also_references.length > 0 ? (
        <AssociationDisclosure
          label="Also references this passage"
          associations={group.also_references}
          open={openDisclosureIds.has(groupDisclosureId)}
          onToggle={() => rowActions.onToggleDisclosure(groupDisclosureId)}
          onActivateObject={rowActions.onActivateObject}
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
