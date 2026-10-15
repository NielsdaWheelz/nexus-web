"use client";

// The viewer's libraries: invitations waiting for them, a create form, and the
// index in the url's sort (oldest created first, so All leads). The text filter
// stays local.

import { useCallback, useId, useRef, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import LibraryInvitations from "@/components/libraries/LibraryInvitations";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useChangeStamp } from "@/lib/api/changes";
import { useThrowLater } from "@/lib/api/serverState";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import { libraryDisplayName, presentLibrary } from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { createLibrary, librariesPage, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { INDEX_SORTS, RESERVED_NAME, isReservedName, offered } from "@/lib/libraries/views";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { matchesPaneFilterQuery, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const VISIT = definePaneVisitDataKey<ListSnapshot<Library>>("Libraries.Index");
const UNIT = { singular: "library", plural: "libraries" };

export default function LibrariesPaneBody() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const sort = params.get("sort");
  const query = sort === null ? "" : new URLSearchParams({ sort }).toString();
  const list = useServerList<Library>({
    key: `/libraries?${query}`,
    stale: useChangeStamp("Libraries"),
    pageSize: 100,
    drain: true,
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

  const fail = useThrowLater();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const name = useHydrationPreservedInput();
  const reserved = isReservedName(name.value);
  const [creating, setCreating] = useState(false);
  // A retry of the same name resends the id minted for it.
  const attempt = useRef<{ id: string; name: string } | null>(null);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.value.trim();
    if (!trimmed || reserved) return;
    if (attempt.current?.name !== trimmed) {
      attempt.current = { id: crypto.randomUUID(), name: trimmed };
    }
    setCreating(true);
    try {
      await createLibrary(attempt.current);
      attempt.current = null;
      name.setValue("");
      setFeedback(null);
    } catch (error) {
      setFeedback(libraryErrorFeedback(error, "Library wasn’t created", fail));
    } finally {
      setCreating(false);
    }
  };

  const filterRows = usePaneFilterRows({
    sourceKey: "Libraries.Index",
    getRowStatus: (text) =>
      listRowStatus(
        list,
        list.items.length,
        list.items.filter((library) =>
          matchesPaneFilterQuery(text, [libraryDisplayName(library)]),
        ).length,
        UNIT,
      ),
  });
  const text = filterRows.query.trim();
  const change = useCallback(
    (changes: ViewChanges) => {
      scroll();
      router.replace(viewHref("/libraries", params, changes), {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [params, router, scroll],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const reset = () => {
    filterRows.clearQuery();
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
    query: invalid ? undefined : {
      kind: "Controls",
      label: "Filter libraries",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter libraries", placeholder: "Filter libraries", value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
          sort={{ label: "Sort", value: sort ?? "", choices: offered(INDEX_SORTS, sort ?? ""), onChange: (value) => change({ sort: value || null }) }}
          status={{ id: queryStatusId, content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} /> }}
          onReset={sort || text ? reset : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Libraries.Index", execute },
    header: {
      kind: "Section",
      // The count describes the complete view, never a subset.
      meta: invalid
        ? { kind: "None" }
        : list.complete
          ? { kind: "Count", value: list.items.length, unit: "library" }
          : { kind: "Pending" },
    },
  });

  if (invalid) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid libraries view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: reset }]}
      />
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
        actions={[{ label: "Retry", onClick: list.retry }]}
      />
    ) : null;
  return (
    <>
      <LibraryInvitations />
      <CollectionView
        returnScope="Libraries.Items"
        rows={list.items
          .map(presentLibrary)
          .filter((row) => matchesPaneFilterQuery(text, [row.title.text]))}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Libraries"
        rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
        collectionBusy={list.running !== null || !list.current}
        toolbar={
          <form className={styles.create} onSubmit={create}>
            <Input
              {...name.inputProps}
              placeholder="New library name..."
              disabled={creating}
              aria-label="New library name"
              aria-invalid={reserved || undefined}
              aria-describedby={reserved ? "library-name-reserved" : undefined}
            />
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={creating}
              disabled={!name.value.trim() || reserved}
            >
              Create
            </Button>
            {reserved ? (
              <p id="library-name-reserved" role="alert" className={styles.hint}>
                {RESERVED_NAME}
              </p>
            ) : null}
          </form>
        }
        notice={feedback ? <FeedbackNotice content={feedback} announcement="Assertive" /> : undefined}
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
                    title: "No libraries yet.",
                    message: "Create your first library above.",
                  }
            }
            announcement="Polite"
          />
        }
        footer={
          <>
            <CollectionExhaustionNotice list={list} />
            {loadFailure}
          </>
        }
      />
    </>
  );
}
