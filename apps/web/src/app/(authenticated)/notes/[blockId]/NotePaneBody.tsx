"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import ResourceSurfaceEditor from "@/components/resource-surface/ResourceSurfaceEditor";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { consumePendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import { useNotePulseHighlight, type NotePulseTarget } from "@/lib/reader/pulseEvent";
import { emptyResourceMenuGroups } from "@/lib/actions/resourceActions";
import type { PaneFilterRowsPublication } from "@/lib/panes/paneSearch";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { requirePaneRuntime, usePaneParam, usePaneReturnReady, usePaneRuntime, useSetPaneLabel } from "@/lib/panes/paneRuntime";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");
  const activateTarget = requirePaneRuntime(
    usePaneRuntime(),
    "NotePaneBody",
  ).activateTarget;
  const sourceRef = `note_block:${blockId}`;
  const [filterState, setFilterState] = useState({
    sourceRef,
    query: "",
  });
  const filterQuery =
    filterState.sourceRef === sourceRef ? filterState.query : "";
  const onFilterQueryChange = useCallback(
    (query: string) => setFilterState({ sourceRef, query }),
    [sourceRef],
  );
  const dismissFilter = useCallback(
    () => setFilterState({ sourceRef, query: "" }),
    [sourceRef],
  );
  const search = useMemo<PaneFilterRowsPublication>(
    () => ({
      kind: "FilterRows",
      query: filterQuery,
      inputLabel: "Filter note items",
      placeholder: "Filter items",
      onQueryChange: onFilterQueryChange,
      onDismiss: dismissFilter,
    }),
    [dismissFilter, filterQuery, onFilterQueryChange],
  );
  const [label, setLabel] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pulse, setPulse] = useState<NotePulseTarget & { pulseId: number } | null>(null);
  const pulseIdRef = useRef(0);
  usePaneReturnReady(ready);
  useSetPaneLabel(label);
  const setPulseTarget = useCallback((target: NotePulseTarget) => {
    const next = pulseIdRef.current + 1;
    pulseIdRef.current = next;
    setPulse({ ...target, pulseId: next });
  }, []);
  useNotePulseHighlight((target) => { if (target.blockId === blockId) setPulseTarget(target); });
  useEffect(() => {
    const pending = consumePendingNoteActivation(blockId);
    if (pending) setPulseTarget(pending);
  }, [blockId, setPulseTarget]);
  const composer = useConnectionsComposerController({ scheme: "note_block", id: blockId });
  const connections = useMemo(
    () => <ConnectionsSurface resourceRef={{ scheme: "note_block", id: blockId }} composerController={composer} activateTarget={activateTarget} />,
    [activateTarget, blockId, composer],
  );
  const { companionAction } = useResourceInspector({ scheme: "note_block", handle: blockId, bodies: { linkedItems: connections } });
  usePanePrimaryChrome({
    search,
    actions: companionAction ? [companionAction] : [],
    menu: ready ? { kind: "ResourceMenu", target: routeResourceActionSubject({ scheme: "note_block", id: blockId, href: `/notes/${blockId}` }), groups: emptyResourceMenuGroups() } : undefined,
  });
  return <ResourceSurfaceEditor
    sourceRef={sourceRef}
    rowFilterQuery={filterQuery}
    onSurfaceReady={(surface) => {
      setReady(true);
      if (surface.source.content.kind === "note_body") setLabel(surface.source.content.bodyText.trim() || "Note");
    }}
    activateTarget={activateTarget}
    notePulseTarget={pulse}
  />;
}
