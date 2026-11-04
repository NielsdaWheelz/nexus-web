"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import ImportInspector from "@/components/imports/ImportInspector";
import ImportsList, {
  type MatchedImportEvidence,
} from "@/components/imports/ImportsList";
import type { ImportsView } from "@/lib/imports/api";
import { ImportCommandsProvider, useImportCommandOwner } from "@/lib/imports/commands";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  apiQuery,
  decodeImportsUrl,
  encodeImportsUrl,
  firstView,
  selectView,
} from "@/lib/imports/query";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { usePaneCompanion, type PaneCompanion } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

const CODEC = {
  decode: decodeImportsUrl,
  encode: encodeImportsUrl,
  basePath: "/imports",
};

/**
 * The Imports pane (docs/modules/imports.md): the url owns the view, the
 * filters and the selection; the counts choose the first view once; the
 * selected import is the pane's companion (desktop: resizable column, mobile:
 * sheet), opened only by explicit activation and toggled by the shell's
 * Inspector control.
 */
export default function ImportsPaneBody() {
  const { state, setState } = usePaneUrlState(CODEC);
  const { commands, feedback } = useImportCommandOwner();
  const { summary, retainObserver, refresh } = useImports();
  const { displayTimeZone } = useRenderEnvironment();
  const { requestSecondarySurface } = requirePaneRuntime(
    usePaneRuntime(),
    "ImportsPaneBody",
  );
  const today = useCallback(
    () => formatLocalDateInTimeZone(new Date(), displayTimeZone),
    [displayTimeZone],
  );

  // A mounted pane keeps the observer polling; it counts until unmount.
  useEffect(() => retainObserver(), [retainObserver]);

  // The counts choose a view once and the url records it once; a later count
  // never moves the reader, and the url write may not have landed yet.
  const chosen = useRef<ImportsView | null>(null);
  chosen.current ??= firstView(
    summary.status === "ready" ? summary.data : null,
  );
  const view = state.view ?? chosen.current;
  const written = useRef(false);
  useEffect(() => {
    if (state.view !== undefined || view === null || written.current) return;
    written.current = true;
    setState(selectView(state, view, today()));
  }, [setState, state, today, view]);

  // Why the selected import matched is a fact of its listed row under this
  // query, which the detail read cannot know; the list reports it.
  const selected = state.selected ?? null;
  const [evidence, setEvidence] = useState<MatchedImportEvidence | null>(null);
  const query = view === null ? null : apiQuery(view, state);
  const matched =
    evidence?.importRef === selected && evidence.apiQuery === query
      ? evidence.event
      : null;
  usePaneCompanion(
    useMemo<PaneCompanion | null>(
      () =>
        selected === null
          ? null
          : {
              groupId: "imports-inspector",
              surfaces: [
                {
                  id: "import-detail",
                  body: (
                    <ImportCommandsProvider commands={commands}><ImportInspector
                      key={selected}
                      importRef={selected}
                      matched={matched}
                    /></ImportCommandsProvider>
                  ),
                },
              ],
              defaultSurfaceId: "import-detail",
            },
      [commands, matched, selected],
    ),
  );
  // The companion publishes in a layout effect: consume an explicit
  // activation only once its url selection has landed. Restoring a url never
  // opens details.
  const [openIntent, setOpenIntent] = useState<{
    ref: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  useEffect(() => {
    if (openIntent === null || selected !== openIntent.ref) return;
    requestSecondarySurface("import-detail", {
      returnFocusTo: openIntent.trigger,
    });
    setOpenIntent(null);
  }, [openIntent, requestSecondarySurface, selected]);
  const onSelect = useCallback(
    (ref: string, trigger: HTMLButtonElement) => {
      setState({ ...state, selected: ref });
      setOpenIntent({ ref, trigger });
    },
    [setState, state],
  );

  // This route restores shell scroll once its list is as tall as it will get.
  const [listSettled, setListSettled] = useState(false);
  usePaneReturnReady(view === null ? summary.status === "failed" : listSettled);

  // Before the counts choose a view there are no list controls; held commands still stand.
  return <ImportCommandsProvider commands={commands}>
    {feedback}
    {view === null ? summary.status === "failed"
      ? <Failed error={summary.error} noun="imports" retry={{ run: refresh, busy: summary.retrying }} />
      : <Ruling />
      : <ImportsList view={view} state={state} setState={setState} today={today}
        onMatched={setEvidence} onSelect={onSelect} onSettled={setListSettled} />}
  </ImportCommandsProvider>;
}
