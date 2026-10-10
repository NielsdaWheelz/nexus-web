"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ImportInspector from "@/components/imports/ImportInspector";
import ImportsList from "@/components/imports/ImportsList";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import type { ImportItem, ImportsView } from "@/lib/imports/api";
import { loadFailure } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  decodeImportsUrl,
  encodeImportsUrl,
  firstView,
  selectView,
  type ImportsUrlState,
} from "@/lib/imports/query";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { usePaneCompanion, type PaneCompanion } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

const CODEC = {
  decode: decodeImportsUrl,
  encode: (state: ImportsUrlState) => encodeImportsUrl(state),
  basePath: "/imports",
};

/**
 * The Imports pane (docs/modules/imports.md): the url owns the view, the
 * filters and the selection; the counts choose the first view once; the
 * selected import is the pane's Companion (desktop: resizable column,
 * mobile: sheet), toggled from the header Inspector.
 */
export default function ImportsPaneBody() {
  const { state, setState } = usePaneUrlState(CODEC);
  const { summary, setPaneOpen, refresh } = useImports();
  const { displayTimeZone } = useRenderEnvironment();
  const { requestSecondarySurface } = requirePaneRuntime(
    usePaneRuntime(),
    "ImportsPaneBody",
  );
  const today = useCallback(
    () => formatLocalDateInTimeZone(new Date(), displayTimeZone),
    [displayTimeZone],
  );

  // An open pane is the live one; a closed pane polls only in its window.
  useEffect(() => {
    setPaneOpen(true);
    return () => setPaneOpen(false);
  }, [setPaneOpen]);

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

  const selected = state.selected ?? null;
  // Why the selected import matched is a fact of the listed row, which the
  // detail read cannot know; the list reports it for the current query.
  const [matched, setMatched] = useState<ImportItem["matched_event"]>({
    kind: "Absent",
  });
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
                    <ImportInspector importRef={selected} matched={matched} />
                  ),
                },
              ],
              defaultSurfaceId: "import-detail",
            },
      [matched, selected],
    ),
  );
  // A newly selected import opens its inspector; a dismissed inspector keeps
  // the selection and reopens from the header.
  useEffect(() => {
    if (selected !== null) requestSecondarySurface("import-detail");
  }, [requestSecondarySurface, selected]);
  const onSelect = useCallback(
    (ref: string | null) => {
      setState({ ...state, selected: ref ?? undefined });
      if (ref !== null) requestSecondarySurface("import-detail");
    },
    [requestSecondarySurface, setState, state],
  );

  // This route restores shell scroll once its list is as tall as it will get.
  const [listSettled, setListSettled] = useState(false);
  usePaneReturnReady(view === null ? summary.status === "failed" : listSettled);

  if (view === null) return <Unresolved refresh={refresh} />;
  return (
    <ImportsList
      view={view}
      state={state}
      setState={setState}
      today={today}
      onMatched={setMatched}
      onSelect={onSelect}
      onSettled={setListSettled}
    />
  );
}

/**
 * Before the counts choose a view there is no view to publish controls for:
 * the pane loads, or says the summary failed.
 */
function Unresolved({ refresh }: { readonly refresh: () => void }) {
  const { summary } = useImports();
  return summary.status === "failed" ? (
    <FeedbackNotice
      content={loadFailure(summary.error)}
      announcement="Assertive"
      actions={[{ label: "Try again", onClick: refresh }]}
    />
  ) : (
    <PaneLoadingState label="Loading imports" announcement="Polite" />
  );
}
