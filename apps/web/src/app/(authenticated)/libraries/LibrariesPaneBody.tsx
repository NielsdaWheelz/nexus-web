"use client";

// The viewer's libraries in the url's sort. Creation and filtering belong to
// this visit, independently of whether its collection is available.

import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { useCallback, useId, useState } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import CollectionView from "@/components/collections/CollectionView";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import LibraryInvitations, { useLibraryInvitations } from "@/components/libraries/LibraryInvitations";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useCatalogRead } from "@/lib/catalog/provider";
import { catalogLibraries } from "@/lib/catalog/selectors";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { indexPaneQuery } from "@/lib/panes/indexPaneQuery";
import { useLibrariesIndexRead } from "@/lib/panes/indexPaneEntry";
import { libraryDisplayName, presentLibrary } from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { type Library } from "@/lib/libraries/api";
import { INDEX_SORTS, offered } from "@/lib/libraries/views";
import { truncatePaneSearchQuery, usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";
import { useLibraryCreation } from "./useLibraryCreation";

const VISIT = definePaneVisitDataKey<Visit<{ items: Library[] }>>("Libraries.Index");
const FILTER = definePaneVisitDataKey<string>("Libraries.Filter");
const UNIT = { singular: "library", plural: "libraries" };

export default function LibrariesPaneBody() {
  const speak = useActiveRegion();
  const router = usePaneRouter();
  const creation = useLibraryCreation();
  const invitations = useLibraryInvitations();
  const params = usePaneSearchParams();
  const sort = params.get("sort");
  const query = indexPaneQuery("libraries", params)!;
  const catalog = useCatalogRead(value => catalogLibraries(value, new URLSearchParams(query)));
  const descriptor = useLibrariesIndexRead();
  const list = useServerValue({ ...descriptor, catalog, visit: VISIT });
  const indexItems = list.status === "ready" ? list.data.items : [];
  const failure = list.status === "loading" ? null : list.error;
  const catalogFailure = failure === null ? null : catalogLine(failure);
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  const invalid =
    failure?.code === "E_INVALID_REQUEST";
  usePaneReturnReady(list.status !== "loading" || invalid);
  const scroll = usePaneScrollRetention(indexItems);

  const retainedFilter = usePaneVisitData(FILTER, (): string => filter);
  const [filter, setFilter] = useState(retainedFilter ?? "");
  const text = filter.trim();
  const visible = indexItems.filter((library) => matchesPaneFilterQuery(text, [libraryDisplayName(library)]));
  const rowStatus = indexRowStatus(
    list,
    indexItems.length,
    visible.length,
    UNIT,
  );
  const change = useCallback(
    (changes: ViewChanges) => {
      scroll();
      router.replace(viewHref("/libraries", params, changes), {
      });
    },
    [params, router, scroll],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  // Every account has its default library, so only a filter empties the index.
  const emptyTitle = text ? "no libraries match this filter." : null;
  const readFeedback = useIndexReadFeedback({ value: list, requestedKey: descriptor.key, active: usePaneIsActive(), waiting: list.status === "loading" && !invalid, outcome: visible.length > 0 ? null : emptyTitle });
  const canReset = Boolean(sort);
  // The count describes the complete view, never a subset.
  const headerMeta: PaneHeaderMeta = invalid
    ? { kind: "None" }
    : (list.status === "ready")
      ? { kind: "Count", value: indexItems.length, unit: "library" }
      : { kind: "Pending" };
  const reset = () => {
    setFilter("");
    // Leaving an invalid view mounts the list: nothing to reflow, and a view
    // transition would mount it after the focus below.
    if (invalid) router.replace("/libraries");
    else change({ sort: null });
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };
  const { refetch } = list;
  // Success and a failed reread over shown rows both say nothing.
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
    } catch (error) {
      if (isAbortError(error) || !isApiError(error) || isSameSystemApiDefect(error)) throw error;
      // justify-ignore-error: the displayed read retains its failure and heals on demand.
    }
    return null;
  }, [refetch]);
  usePaneChrome({
    primaryAction: creation.primaryAction,
    query: invalid ? undefined : {
      kind: "Controls",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter libraries", placeholder: "Filter libraries", value: filter, appliedValue: filter, onChange: (text) => setFilter(truncatePaneSearchQuery(text)), onClear: () => setFilter("") }}
          sort={{ label: "Sort", value: sort ?? "", choices: offered(INDEX_SORTS, sort ?? ""), onChange: (value) => change({ sort: value || null }) }}
          status={{
            placement: "Inline",
            id: queryStatusId,
            visible: false,
            content: <PaneFilterRowsStatus announceQueryChanges={(list.status === "ready") && failure === null} id={queryStatusId} status={rowStatus} query={filter} />,
          }}
          onReset={canReset ? reset : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Libraries.Index", execute },
    header: { kind: "Section", meta: headerMeta },
  });

  if (invalid) {
    return (
      <>
        {readFeedback.announcement}
        {creation.content}
        {invitations.held}
        <Fact line={{ fact: "this view doesn’t exist." }} speak verbs={[{ label: "reset view", commandKey: "libraries-view-reset", run: reset }]} />
      </>
    );
  }
  return (
    <>
      {readFeedback.announcement}
      {creation.content}
      {invitations.held}
      <LibraryInvitations state={invitations} />
      <CollectionView geometry="UniformIndex"
        returnScope="Libraries.Items"
        rows={visible.map(presentLibrary)}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Libraries"
        anchorKey={text}
        collectionBusy={busy}
        error={list.status === "failed" ? catalogFailure !== null ? <Fact line={catalogFailure} speak={speak} />
          : <Failed error={list.error} noun="libraries" retry={{ run: retry, busy }} /> : null}
        empty={emptyTitle === null ? null : <Fact line={{ fact: emptyTitle }} />}
      />
    </>
  );
}
