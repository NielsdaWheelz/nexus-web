"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ImportInspector from "@/components/imports/ImportInspector";
import ImportsWorkspace from "@/components/imports/ImportsWorkspace";
import { companionAction } from "@/components/resource-inspector/companionAction";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { absent, present } from "@/lib/api/presence";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import type { ImportRef } from "@/lib/imports/importRef";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  decodeImportsUrlState,
  encodeImportsUrlState,
} from "@/lib/imports/importsUrlState";
import {
  normalizePaneSecondaryPublication,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import { usePaneReturnReady, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";

const IMPORTS_URL_STATE_CODEC = {
  decode: decodeImportsUrlState,
  encode: encodeImportsUrlState,
  basePath: "/imports",
};

/**
 * The Imports pane: the URL owns which view and which import the reader is
 * looking at, the workspace renders that view, and the selected import is
 * published as this pane's one secondary surface so desktop gets the resizable
 * inspector and mobile the sheet with Back (contract D8). The workspace owns
 * the pane's only Refresh control, so the header publishes none.
 */
export default function ImportsPaneBody() {
  const { state, setState } = usePaneUrlState(IMPORTS_URL_STATE_CODEC);
  const { loadState, setPaneOpen } = useImports();
  const paneRuntime = usePaneRuntime();

  // This route restores shell scroll, so it owes the memento one readiness
  // token, and the memento may only be spent once the list is as tall as it is
  // going to get: the workspace reports its page read, and a first summary read
  // that failed leaves no list to wait for.
  const [listSettled, setListSettled] = useState(false);
  usePaneReturnReady(listSettled || loadState.kind === "Failed");

  // The provider polls a closed pane only inside its bounded window; an open
  // pane is the live one (contract D10).
  useEffect(() => {
    setPaneOpen(true);
    return () => setPaneOpen(false);
  }, [setPaneOpen]);

  const selectedRef = state.selected.kind === "Present" ? state.selected.value : null;
  const publication = useMemo<PaneSecondaryPublication | null>(
    () =>
      selectedRef === null
        ? null
        : normalizePaneSecondaryPublication({
            groupId: "imports-inspector",
            surfaces: [
              {
                id: "import-detail",
                body: <ImportInspector importRef={selectedRef} />,
              },
            ],
            defaultSurfaceId: "import-detail",
          }),
    [selectedRef],
  );
  const requestSecondarySurface = usePaneSecondary(publication);

  // A newly selected import opens its inspector; a reader who then dismisses
  // the inspector keeps the selection and reopens it from the header.
  useEffect(() => {
    if (selectedRef === null) return;
    requestSecondarySurface("import-detail");
  }, [requestSecondarySurface, selectedRef]);

  const paneId = paneRuntime?.paneId ?? null;
  const inspectorVisible =
    paneRuntime?.secondaryPane?.groupId === "imports-inspector" &&
    paneRuntime.secondaryPane.visibility === "visible";
  const closeSecondaryPane = paneRuntime?.closeSecondaryPane;
  const onOpenInspector = useCallback(
    (trigger: HTMLButtonElement | null) => {
      requestSecondarySurface("import-detail", { returnFocusTo: trigger });
    },
    [requestSecondarySurface],
  );
  const onCloseInspector = useCallback(() => {
    closeSecondaryPane?.();
  }, [closeSecondaryPane]);
  const companion = useMemo(
    () =>
      publication === null || paneId === null
        ? null
        : companionAction({
            expanded: inspectorVisible,
            regionId: paneSecondaryRegionId(paneId, "imports-inspector"),
            onOpen: onOpenInspector,
            onClose: onCloseInspector,
          }),
    [
      inspectorVisible,
      onCloseInspector,
      onOpenInspector,
      paneId,
      publication,
    ],
  );
  usePanePrimaryChrome(
    companion === null ? null : { companionAction: companion },
  );

  const onSelect = useCallback(
    (ref: ImportRef | null) => {
      setState({
        ...state,
        selected: ref === null ? absent() : present(ref),
      });
      if (ref !== null) requestSecondarySurface("import-detail");
    },
    [requestSecondarySurface, setState, state],
  );

  return (
    <ImportsWorkspace
      state={state}
      onStateChange={setState}
      selectedRef={selectedRef}
      onSelect={onSelect}
      onListSettled={setListSettled}
    />
  );
}
