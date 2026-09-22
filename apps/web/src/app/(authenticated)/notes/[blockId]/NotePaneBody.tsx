"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import ResourceSurfaceEditor from "@/components/resource-surface/ResourceSurfaceEditor";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { consumePendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import {
  useNotePulseHighlight,
  type NotePulseTarget,
} from "@/lib/reader/pulseEvent";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import { usePaneTransientFilterRows } from "@/lib/panes/usePaneFilterRows";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import {
  requirePaneRuntime,
  usePaneHash,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePassageResolution } from "@/lib/reader/passageResolution";
import { resourceSurfaceFilterFields } from "@/components/resource-surface/resourceSurfaceFilterFields";
import {
  notifyNoteBlockActionIntentOwnerReady,
  useNoteBlockActionIntentOwner,
  type NoteBlockActionIntent,
} from "@/lib/notes/actionIntents";
import {
  createMountedEditorIntentController,
  type MountedEditorIntentController,
} from "@/lib/actions/mountedActionHandoff";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");
  const paneRuntime = requirePaneRuntime(
    usePaneRuntime(),
    "NotePaneBody",
  );
  const activateTarget = paneRuntime.activateTarget;
  const paneHash = usePaneHash();
  const passageResolution = usePassageResolution({
    hash: paneHash,
    ownerScheme: "note_block",
    ownerId: blockId,
  });
  const sourceRef = `note_block:${blockId}`;
  const [filterRowsState, setFilterRowsState] = useState<{
    sourceRef: string;
    ready: boolean;
    fields: readonly (readonly string[])[];
  }>({
    sourceRef,
    ready: false,
    fields: [],
  });
  if (filterRowsState.sourceRef !== sourceRef) {
    setFilterRowsState({ sourceRef, ready: false, fields: [] });
  }
  const filterRows = useMemo(
    () =>
      filterRowsState.sourceRef === sourceRef ? filterRowsState.fields : [],
    [filterRowsState, sourceRef],
  );
  const ready =
    filterRowsState.sourceRef === sourceRef && filterRowsState.ready;
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = filterRows.filter((fields) =>
        matchesPaneFilterQuery(query, fields),
      ).length;
      const unit = { singular: "item", plural: "items" };
      return ready
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: filterRows.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: filterRows.length,
            unit,
          };
    },
    [filterRows, ready],
  );
  const { query: filterQuery, publication: search } = usePaneTransientFilterRows({
    sourceKey: sourceRef,
      inputLabel: "Filter note items",
      placeholder: "Filter items",
    getRowStatus: getFilterStatus,
  });
  const [label, setLabel] = useState<string | null>(null);
  const [focusBodySerial, setFocusBodySerial] = useState(0);
  const editBodyIntentControllerRef = useRef<
    MountedEditorIntentController<NoteBlockActionIntent> | null
  >(null);
  if (editBodyIntentControllerRef.current === null) {
    editBodyIntentControllerRef.current = createMountedEditorIntentController(
      notifyNoteBlockActionIntentOwnerReady,
    );
  }
  const editBodyIntentController = editBodyIntentControllerRef.current;
  const [pulse, setPulse] = useState<
    (NotePulseTarget & { pulseId: number }) | null
  >(null);
  const pulseIdRef = useRef(0);
  usePaneReturnReady(ready);
  useSetPaneLabel(label);
  const acceptEditBodyIntent = useCallback(
    (intent: NoteBlockActionIntent) => {
      if (!ready || !editBodyIntentController.accept(intent)) return false;
      setFocusBodySerial((current) => current + 1);
      return true;
    },
    [editBodyIntentController, ready],
  );
  useNoteBlockActionIntentOwner(
    ready
      ? canonicalResourceRef({ scheme: "note_block", id: blockId })
      : null,
    acceptEditBodyIntent,
  );
  const beginBodyIntentMutation = useCallback(
    () => editBodyIntentController.beginMutation(),
    [editBodyIntentController],
  );
  const abortBodyIntent = useCallback(() => {
    editBodyIntentController.abortEditing();
  }, [editBodyIntentController]);
  useEffect(
    () => () => {
      editBodyIntentController.releaseOwner();
    },
    [editBodyIntentController],
  );
  const setPulseTarget = useCallback((target: NotePulseTarget) => {
    const next = pulseIdRef.current + 1;
    pulseIdRef.current = next;
    setPulse({ ...target, pulseId: next });
  }, []);
  const appliedPassageRef = useRef<string | null>(null);
  useEffect(() => {
    if (!paneHash) appliedPassageRef.current = null;
  }, [paneHash]);
  useEffect(() => {
    if (passageResolution.status !== "ready" || passageResolution.data.kind !== "Present") return;
    const target = passageResolution.data.value;
    if (target.kind !== "NoteTextOffsets" || appliedPassageRef.current === paneHash) return;
    appliedPassageRef.current = paneHash;
    setPulseTarget({
      blockId,
      startOffset: target.startOffset,
      endOffset: target.endOffset,
      snippet: null,
      highlightBehavior: "pulse",
      focusBehavior: "scroll_into_view",
    });
    paneRuntime.router.replace(paneRuntime.pathname + (paneRuntime.searchParams.size ? `?${paneRuntime.searchParams}` : ""));
  }, [blockId, paneHash, paneRuntime, passageResolution, setPulseTarget]);
  useNotePulseHighlight((target) => {
    if (target.blockId === blockId) setPulseTarget(target);
  });
  useEffect(() => {
    const pending = consumePendingNoteActivation(blockId);
    if (pending) setPulseTarget(pending);
  }, [blockId, setPulseTarget]);
  const composer = useConnectionsComposerController({
    scheme: "note_block",
    id: blockId,
  });
  const connections = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "note_block", id: blockId }}
        composerController={composer}
        activateTarget={activateTarget}
      />
    ),
    [activateTarget, blockId, composer],
  );
  const { companionAction } = useResourceInspector({
    scheme: "note_block",
    handle: blockId,
    bodies: { linkedItems: connections },
  });
  const handleSurfaceChange = useCallback(
    (surface: ResourceSurface) => {
      setFilterRowsState({
        sourceRef,
        ready: true,
        fields: surface.orderedItems.map(resourceSurfaceFilterFields),
      });
      if (surface.source.content.kind === "note_body") {
        setLabel(surface.source.content.bodyText.trim() || "Note");
      }
    },
    [sourceRef],
  );
  usePanePrimaryChrome({
    search,
    companionAction: companionAction ?? undefined,
    // The pane's canonical identity is its route key, never a fact of the
    // filter-row state it happened to be gated on. The snapshot owns missing.
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "note_block", id: blockId }),
    },
  });
  return (
    <>
      {!ready && filterQuery.trim() ? (
        <p role="status">No matching item found so far.</p>
      ) : null}
      {passageResolution.status === "ready" && passageResolution.data.kind === "Absent" ? (
        <p role="status">This passage is no longer available.</p>
      ) : null}
      {passageResolution.status === "error" ? (
        <p role="alert">The passage could not be opened.</p>
      ) : null}
      <ResourceSurfaceEditor
        sourceRef={sourceRef}
        rowFilterQuery={filterQuery}
        onSurfaceChange={handleSurfaceChange}
        focusBodySerial={focusBodySerial}
        onSourceBodyMutationStarted={beginBodyIntentMutation}
        onSourceBodyEditAborted={abortBodyIntent}
        activateTarget={activateTarget}
        notePulseTarget={pulse?.blockId === blockId ? pulse : null}
      />
    </>
  );
}
