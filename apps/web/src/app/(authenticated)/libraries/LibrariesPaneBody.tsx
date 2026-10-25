"use client";

// The viewer's libraries in the url's sort. Creation and filtering belong to
// this visit, independently of whether its collection is available.

import { useCallback, useId, useState } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import LibraryInvitations from "@/components/libraries/LibraryInvitations";
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
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
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
  const router = usePaneRouter();
  const creation = useLibraryCreation();
  const params = usePaneSearchParams();
  const sort = params.get("sort");
  const query = indexPaneQuery("libraries", params)!;
  const catalog = useCatalogRead(value => catalogLibraries(value, new URLSearchParams(query)));
  const descriptor = useLibrariesIndexRead();
  const list = useServerValue({ ...descriptor, catalog, visit: VISIT });
  const indexItems = list.status === "ready" ? list.data.items : [];
  const failure = list.status === "loading" ? null : list.error;
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
  const emptyTitle = text
    ? "no libraries match this filter."
    : "no libraries yet.";
  const readFeedback = useIndexReadFeedback({
    value: list, requestedKey: descriptor.key, active: usePaneIsActive(), unit: UNIT, waiting: list.status === "loading" && !invalid,
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
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
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
      return { kind: "Complete", announcement: "Libraries refreshed" };
    } catch {
      return { kind: "Failed", announcement: "Libraries failed to refresh" };
    }
  }, [refetch]);
  usePaneChrome({
    primaryAction: creation.primaryAction,
    query: invalid ? undefined : {
      kind: "Controls",
      label: "Filter libraries",
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
        <FeedbackNotice
          content={{ tone: "Danger", title: "Invalid libraries view" }}
          announcement="Assertive"
          actions={[{ label: "Reset view", onClick: reset }]}
        />
      </>
    );
  }
  const loadFailure =
    failure !== null ? (
      <FeedbackNotice
        content={
          libraryErrorFeedback(
            failure,
            list.status === "ready"
              ? "couldn’t refresh libraries"
              : "couldn’t load libraries",
            throwDefect,
          ) ?? { tone: "Danger", title: "couldn’t load libraries" }
        }
        announcement={list.status === "ready" ? "None" : "Polite"}
        actions={[{ label: "try again", onClick: retry, busy }]}
        returnFocus={() => inputRef.current}
      />
    ) : null;
  return (
    <>
      {readFeedback.announcement}
      {creation.content}
      <LibraryInvitations returnFocus={() => inputRef.current} />
      <CollectionView
        returnScope="Libraries.Items"
        rows={visible.map(presentLibrary)}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Libraries"
        rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
        collectionBusy={busy}
        error={loadFailure}
        notice={list.status === "ready" ? loadFailure : null}
        empty={
          <FeedbackNotice
            content={{ tone: "Neutral", title: emptyTitle,
              message: !text && (list.status === "ready") ? "use new library to create one." : undefined }}
            announcement="None"
          />
        }
      />
    </>
  );
}
