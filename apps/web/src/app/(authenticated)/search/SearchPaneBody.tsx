"use client";

import { useCallback, useMemo } from "react";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { apiTransportFeedback, type ApiError } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { presentSearchResult } from "@/lib/collections/presenters/search";
import {
  useMediaQueryRevision,
  useMediaSummaries,
} from "@/lib/media/MediaSummaryProvider";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  usePaneIsVisible,
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import {
  searchHref,
  searchQueryFromParams,
  searchQueryToParams,
} from "@/lib/search/searchParams";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import SearchControls from "./SearchControls";
import styles from "./page.module.css";

type Row = SearchResultRowViewModel;
const VISIT = definePaneVisitDataKey<ListSnapshot<Row>>("Search.Results");
const UNFIXABLE = [
  "E_INVALID_REQUEST",
  "E_NOT_FOUND",
  "E_CONVERSATION_NOT_FOUND",
];

const FAILED = {
  Load: "Search couldn’t be completed",
  More: "More results couldn’t be loaded",
  Refetch: "Results couldn’t be refreshed",
};

function failureContent(
  error: ApiError,
  op: keyof typeof FAILED,
): FeedbackContent {
  const { requestId } = error;
  if (error.code === "E_INVALID_REQUEST")
    return {
      tone: "Danger",
      title: "This search isn’t valid",
      message: "Adjust the query or filters and retry.",
      requestId,
    };
  if (UNFIXABLE.includes(error.code))
    return {
      tone: "Danger",
      title: "The search scope is no longer available",
      requestId,
    };
  const title = FAILED[op];
  return (
    apiTransportFeedback(error, title) ?? { tone: "Danger", title, requestId }
  );
}

/**
 * Search: the pane url is the query (SearchControls drafts it); the server
 * ranks, 20 rows a page. A query with no usable text and no format or credit
 * filter, or with no kinds, is a list of no rows that never asks the server.
 */
export default function SearchPaneBody() {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const visible = usePaneIsVisible();
  const query = useMemo(() => searchQueryFromParams(params), [params]);
  const { inputRef, focusInput } = usePaneQueryInput();
  const none = query.requestedKinds?.size === 0;
  // the server ignores text under two code points (services/search/query.py)
  const blank =
    !none &&
    [...query.text.trim()].length < 2 &&
    query.formats.length + query.authors.length + query.roles.length === 0;
  const idle = blank || none;
  const filtered = searchHref({ ...query, text: "" }) !== "/search";
  const list = useServerList<Row>({
    key: visible ? searchQueryToParams(query).toString() : null,
    stale: String(useMediaQueryRevision()),
    pageSize: 20,
    drain: false,
    active: true,
    visit: VISIT,
    id: (row) => row.key,
    fetchPage: async (cursor, limit, signal) => {
      if (idle) return { items: [], next_cursor: null };
      const page = await fetchSearchResultPage(query, {
        limit,
        cursor,
        signal,
      });
      return { items: page.rows, next_cursor: page.nextCursor };
    },
  });
  const results = idle && !list.current ? [] : list.items;
  const summaries = useMediaSummaries(
    results.flatMap((row) => ("mediaSummary" in row ? [row.mediaSummary] : [])),
  );
  const rows = results.flatMap((row) => {
    if (!("mediaSummary" in row)) return [presentSearchResult(row)];
    const mediaSummary = summaries.resolve(row.mediaSummary);
    return mediaSummary === null
      ? []
      : [presentSearchResult({ ...row, mediaSummary })];
  });
  const commit = useCallback(
    (next: SearchQuery) =>
      router.replace(searchHref(next), {
        viewTransition: { kind: "collection-reflow" },
      }),
    [router],
  );
  const failure = list.failure;
  const searching = !idle && !list.current && failure === null;
  const count = rows.length;
  const status = blank
    ? "Ready to search."
    : !list.current
      ? list.status === "ready"
        ? `${count} results retained from the previous search; ${failure ? "update failed" : "updating"}.`
        : failure
          ? "Results unavailable."
          : "Searching…"
      : failure?.op === "More"
        ? `${count} loaded results; loading more failed.`
        : `${count} loaded results${list.complete ? "." : "; more available."}`;
  usePaneReturnReady(list.current || failure !== null);
  usePaneChrome({
    query: {
      kind: "Controls",
      label: "Search content",
      focusInput,
      content: (
        <SearchControls
          query={query}
          commit={commit}
          inputRef={inputRef}
          status={{ text: status, announce: list.current || failure === null }}
        />
      ),
    },
    header: {
      kind: "Section",
      meta: searching
        ? { kind: "Pending" }
        : list.current && count > 0
          ? { kind: "Count", value: count, unit: "result" }
          : { kind: "None" },
    },
  });

  const notices = failure !== null || searching || summaries.error !== null;
  return (
    <CollectionView
      returnScope="Search.Results"
      rows={rows}
      status="ready"
      ariaLabel="Search results"
      notice={
        notices ? (
          <>
            {failure ? (
              <FeedbackNotice
                content={failureContent(failure.error, failure.op)}
                announcement={list.current ? "Polite" : "Assertive"}
                actions={
                  UNFIXABLE.includes(failure.error.code)
                    ? undefined
                    : [{ label: "Retry", onClick: list.retry }]
                }
              />
            ) : null}
            {searching ? (
              <FeedbackNotice
                content={{ tone: "Info", title: "Searching…" }}
                announcement="None"
              />
            ) : null}
            <MediaSummaryNotice
              error={summaries.error}
              retry={summaries.retry}
            />
          </>
        ) : undefined
      }
      empty={
        blank ? (
          <FeedbackNotice
            content={{
              tone: "Info",
              title: "Search everything in your Nexus",
              message:
                "Type two or more characters, or open filters to narrow by content type, format or author.",
            }}
            announcement="None"
          />
        ) : list.current && list.complete ? (
          <div className={styles.empty}>
            <FeedbackNotice
              content={{ tone: "Neutral", title: "No results found." }}
              announcement="None"
            />
            {filtered ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() =>
                  commit({ ...emptySearchQuery(), text: query.text })
                }
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null
      }
      footer={
        <LoadMoreFooter
          hasMore={list.current && !list.complete}
          loading={list.running === "More"}
          disabled={list.running !== null}
          onLoadMore={list.more}
          label="Load more"
        />
      }
    />
  );
}
