"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import OpmlImportRecord from "@/components/feeds/OpmlImportRecord";
import ImportInspector from "@/components/imports/ImportInspector";
import Register from "@/components/imports/Register";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { ImportCommandsProvider, useImportCommandOwner } from "@/lib/imports/commands";
import { useImports } from "@/lib/imports/ImportsProvider";
import { decodeImportsUrl, encodeImportsUrl } from "@/lib/imports/query";
import { requestNexusOpen } from "@/lib/nexus/events";
import { usePaneChrome, usePaneCompanion, type PaneCompanion } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneIsPresented, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import * as Icon from "@/lib/ui/icons";

const CODEC = { decode: decodeImportsUrl, encode: encodeImportsUrl, basePath: "/imports" };

/** The url remembers selection; only explicit activation opens its companion record. */
export default function ImportsPaneBody() {
  const { state, setState } = usePaneUrlState(CODEC);
  const { commands, feedback } = useImportCommandOwner();
  const { retainObserver, refresh } = useImports();
  const { requestSecondarySurface } = requirePaneRuntime(usePaneRuntime(), "ImportsPaneBody");
  const observing = useObservationDemand(usePaneIsPresented());
  useEffect(() => observing ? retainObserver() : undefined, [observing, retainObserver]);
  const selected = state.selected ?? null;
  usePaneChrome({ primaryAction: { kind: "command", id: "Import", label: "Import", icon: <Icon.Upload aria-hidden="true" />,
    restoreFocusOnClose: false, onSelect: ({ triggerEl }) => requestNexusOpen({ kind: "Import", into: [] }, triggerEl) },
    refresh: { kind: "Refreshable", sourceKey: "Imports.Register", execute: async () => { refresh(); return null; } } });
  usePaneCompanion(useMemo<PaneCompanion | null>(() => selected === null ? null : {
    groupId: "imports-inspector", defaultSurfaceId: "import-detail", surfaces: [{ id: "import-detail",
      body: <ImportCommandsProvider commands={commands}>{selected.startsWith("opml:")
        ? <OpmlImportRecord key={selected} id={selected.slice(5)} />
        : <ImportInspector key={selected} importRef={selected} />}</ImportCommandsProvider>,
    }],
  }, [commands, selected]));
  const [openIntent, setOpenIntent] = useState<{ ref: string; trigger: HTMLElement | null } | null>(null);
  useEffect(() => {
    if (openIntent === null || selected !== openIntent.ref) return;
    requestSecondarySurface("import-detail", { returnFocusTo: openIntent.trigger });
    setOpenIntent(null);
  }, [openIntent, requestSecondarySurface, selected]);
  const onSelect = useCallback((ref: string, trigger: HTMLElement | null) => {
    setState({ selected: ref });
    setOpenIntent({ ref, trigger });
  }, [setState]);
  return <ImportCommandsProvider commands={commands}>{feedback}<Register selected={selected} onSelect={onSelect} /></ImportCommandsProvider>;
}
