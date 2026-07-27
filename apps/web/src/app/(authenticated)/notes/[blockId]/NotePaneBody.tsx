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
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { requirePaneRuntime, usePaneParam, usePaneReturnReady, usePaneRuntime, useSetPaneLabel } from "@/lib/panes/paneRuntime";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");
  const runtime = usePaneRuntime();
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
    () => <ConnectionsSurface resourceRef={{ scheme: "note_block", id: blockId }} composerController={composer} activateTarget={requirePaneRuntime(runtime, "Note connections activation").activateTarget} />,
    [blockId, composer, runtime],
  );
  const { companionAction } = useResourceInspector({ scheme: "note_block", handle: blockId, bodies: { linkedItems: connections } });
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    menu: ready ? { kind: "ResourceMenu", target: routeResourceActionSubject({ scheme: "note_block", id: blockId, href: `/notes/${blockId}` }), groups: emptyResourceMenuGroups() } : undefined,
  });
  return <ResourceSurfaceEditor
    sourceRef={`note_block:${blockId}`}
    onSurfaceReady={(surface) => {
      setReady(true);
      if (surface.source.content.kind === "note_body") setLabel(surface.source.content.bodyText.trim() || "Note");
    }}
    activateTarget={requirePaneRuntime(runtime, "Note target activation").activateTarget}
    notePulseTarget={pulse}
  />;
}
