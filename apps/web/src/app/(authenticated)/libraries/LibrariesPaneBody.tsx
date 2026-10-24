"use client";

// The viewer's libraries in the url's sort. Creation and filtering belong to
// this visit, independently of whether its collection is available.

import { useCallback, useId, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import LibraryInvitations from "@/components/libraries/LibraryInvitations";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useCatalogRead } from "@/lib/catalog/provider";
import { catalogLibraries } from "@/lib/catalog/selectors";
import { useChangeStamp } from "@/lib/api/changes";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import { libraryDisplayName, presentLibrary } from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { librariesPage, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { INDEX_SORTS, offered } from "@/lib/libraries/views";
import { truncatePaneSearchQuery, usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { matchesPaneFilterQuery, paneFilterRowsStatusVisible } from "@/lib/panes/paneFilterRows";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";
import { useLibraryCreation } from "./useLibraryCreation";

const VISIT = definePaneVisitDataKey<ListSnapshot<Library>>("Libraries.Index");
const FILTER = definePaneVisitDataKey<string>("Libraries.Filter");
const UNIT = { singular: "library", plural: "libraries" };

export default function LibrariesPaneBody() {
  const router = usePaneRouter();
  const creation = useLibraryCreation();
  const params = usePaneSearchParams();
  const sort = params.get("sort");
  const query = sort === null ? "" : new URLSearchParams({ sort }).toString();
  const catalog = useCatalogRead(value => catalogLibraries(value, new URLSearchParams(query)));
  const list = useServerList<Library>({
    key: `/libraries?${query}`,
    stale: useChangeStamp("Libraries"),
    catalog,
    pageSize: 100,
    active: usePaneIsActive(),
    visit: VISIT,
    id: (library) => library.id,
    fetchPage: (cursor, limit, signal) =>
      librariesPage(pageQuery(query, cursor, limit), signal),
  });
  const invalid =
    list.failure?.op === "Load" && list.failure.error.code === "E_INVALID_REQUEST";
  usePaneReturnReady(list.status !== "loading" || invalid);
  const scroll = usePaneScrollRetention(list.items);

  const retainedFilter = usePaneVisitData(FILTER, (): string => filter);
  const [filter, setFilter] = useState(retainedFilter ?? "");
  const text = filter.trim();
  const rowStatus = listRowStatus(
    list,
    list.items.length,
    list.items.filter((library) => matchesPaneFilterQuery(text, [libraryDisplayName(library)])).length,
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
  const canReset = Boolean(sort);
  // The count describes the complete view, never a subset.
  const headerMeta: PaneHeaderMeta = invalid
    ? { kind: "None" }
    : list.complete
      ? { kind: "Count", value: list.items.length, unit: "library" }
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
            visible: paneFilterRowsStatusVisible({
              status: rowStatus,
              filtering: text !== "",
            }),
            content: <PaneFilterRowsStatus id={queryStatusId} status={rowStatus} query={filter} />,
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
    list.failure !== null && list.failure.op !== "More" ? (
      <FeedbackNotice
        content={
          libraryErrorFeedback(
            list.failure.error,
            list.status === "ready"
              ? "Libraries couldn’t be refreshed"
              : "Libraries couldn’t be loaded",
            throwDefect,
          ) ?? { tone: "Danger", title: "Libraries couldn’t be loaded" }
        }
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: list.retry, busy: list.running !== null }]}
      />
    ) : null;
  return (
    <>
      {creation.content}
      <LibraryInvitations returnFocus={() => inputRef.current} />
      <CollectionView
        returnScope="Libraries.Items"
        rows={list.items
          .map(presentLibrary)
          .filter((row) => matchesPaneFilterQuery(text, [row.title.text]))}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Libraries"
        rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
        collectionBusy={list.running !== null || !list.current}
        error={loadFailure}
        empty={
          <FeedbackNotice
            content={
              text
                ? {
                    tone: "Neutral",
                    title: list.complete
                      ? "No libraries match this filter."
                      : "No matching library found so far.",
                  }
                : {
                    tone: "Neutral",
                    title: list.complete ? "no libraries yet." : "no libraries loaded so far.",
                    message: list.complete ? "use new library to create one." : undefined,
                  }
            }
            announcement="Polite"
          />
        }
        footer={
          <>
            <CollectionExhaustionNotice list={list} unit={{ singular: "library", plural: "libraries" }} returnFocus={() => inputRef.current} />
            {list.status === "ready" ? loadFailure : null}
          </>
        }
      />
    </>
  );
}
