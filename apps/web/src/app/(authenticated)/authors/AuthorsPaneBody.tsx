"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import Pill from "@/components/ui/Pill";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchContributorDirectory } from "@/lib/contributors/api";
import {
  contributorContentKindLabel,
  contributorKindLabel,
  contributorRoleLabel,
  contributorStatusLabel,
} from "@/lib/contributors/vocab";
import {
  contributorDirectoryResource,
  type ContributorDirectoryResourceParams,
} from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import type {
  ContributorDirectoryEntry,
  ContributorDirectoryFacets,
  FacetCount,
} from "@/lib/contributors/types";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";

const PAGE_LIMIT = 30;
const QUERY_DEBOUNCE_MS = 200;

type DirectorySort = "works" | "name";

interface AuthorsUrlState {
  q: string;
  roles: string[];
  kinds: string[];
  contentKinds: string[];
  statuses: string[];
  sort: DirectorySort;
}

function parseCommaList(searchParams: URLSearchParams, key: string): string[] {
  const raw = searchParams.getAll(key).join(",");
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values;
}

function toggleValue(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((candidate) => candidate !== value)
    : [...current, value];
}

function buildAuthorsHref(state: AuthorsUrlState): string {
  const params = new URLSearchParams();
  const trimmedQuery = state.q.trim();
  if (trimmedQuery) params.set("q", trimmedQuery);
  if (state.roles.length) params.set("roles", state.roles.join(","));
  if (state.kinds.length) params.set("kinds", state.kinds.join(","));
  if (state.contentKinds.length) params.set("content_kinds", state.contentKinds.join(","));
  if (state.statuses.length) params.set("statuses", state.statuses.join(","));
  if (state.sort === "name") params.set("sort", "name");
  const search = params.toString();
  return search ? `/authors?${search}` : "/authors";
}

function pageParams(
  state: AuthorsUrlState
): ContributorDirectoryResourceParams {
  return {
    q: state.q.trim() || undefined,
    roles: state.roles.length ? state.roles : undefined,
    kinds: state.kinds.length ? state.kinds : undefined,
    contentKinds: state.contentKinds.length ? state.contentKinds : undefined,
    statuses: state.statuses.length ? state.statuses : undefined,
    sort: state.sort,
    limit: PAGE_LIMIT,
  };
}

function entryMeta(entry: ContributorDirectoryEntry): string {
  return [contributorKindLabel(entry.kind), entry.disambiguation]
    .filter(Boolean)
    .join(" · ");
}

export default function AuthorsPaneBody() {
  useSetPaneTitle("Authors");
  const paneRouter = usePaneRouter();
  const searchParams = usePaneSearchParams();

  const urlState = useMemo<AuthorsUrlState>(
    () => ({
      q: searchParams.get("q")?.trim() ?? "",
      roles: parseCommaList(searchParams, "roles"),
      kinds: parseCommaList(searchParams, "kinds"),
      contentKinds: parseCommaList(searchParams, "content_kinds"),
      statuses: parseCommaList(searchParams, "statuses"),
      sort: searchParams.get("sort") === "name" ? "name" : "works",
    }),
    [searchParams]
  );

  const params = useMemo(() => pageParams(urlState), [urlState]);
  const cacheKey = contributorDirectoryResource.cacheKey(params);
  const firstPage = useResource<
    Awaited<ReturnType<typeof fetchContributorDirectory>>,
    ContributorDirectoryResourceParams
  >({
    descriptor: contributorDirectoryResource,
    params,
    load: async (loadParams) => fetchContributorDirectory(loadParams),
  });

  // Page 1 (entries/facets/cursor) is owned by the resource; only later pages
  // accumulate locally, so the local copy cannot drift from page 1.
  const [appended, setAppended] = useState<ContributorDirectoryEntry[]>([]);
  const [tailCursor, setTailCursor] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<FeedbackContent | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestIdRef = useRef(0);

  // Any facet/sort/query change refetches page 1 and invalidates the previous
  // cursor window, so drop the accumulated tail and cancel in-flight appends.
  useEffect(() => {
    requestIdRef.current += 1;
    setAppended([]);
    setTailCursor(null);
    setLoadMoreError(null);
    setLoadingMore(false);
  }, [cacheKey]);

  const firstPageData = firstPage.status === "ready" ? firstPage.data : null;
  const entries = useMemo(
    () => (firstPageData ? [...firstPageData.entries, ...appended] : appended),
    [firstPageData, appended]
  );
  const facets = firstPageData?.facets ?? null;
  const nextCursor =
    appended.length > 0 ? tailCursor : firstPageData?.page.next_cursor ?? null;

  const replaceState = (next: Partial<AuthorsUrlState>) => {
    paneRouter.replace(buildAuthorsHref({ ...urlState, ...next }));
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchContributorDirectory({ ...params, cursor: nextCursor });
      if (requestId !== requestIdRef.current) return;
      setAppended((current) => [...current, ...page.entries]);
      setTailCursor(page.page.next_cursor);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      if (handleUnauthenticatedApiError(loadError)) return;
      setLoadMoreError(toFeedback(loadError, { fallback: "Failed to load more authors" }));
    } finally {
      if (requestId === requestIdRef.current) setLoadingMore(false);
    }
  };

  const loadingFirstPage = firstPage.status === "loading";

  return (
    <PaneSurface
      toolbar={
        <AuthorsToolbar
          urlState={urlState}
          facets={facets}
          onQueryChange={(q) => replaceState({ q })}
          onToggle={(group, value) =>
            replaceState({ [group]: toggleValue(urlState[group], value) })
          }
          onSortChange={(sort) => replaceState({ sort })}
        />
      }
      state={
        firstPage.status === "error" || loadMoreError || loadingFirstPage ? (
        <>
          {firstPage.status === "error" ? (
            <>
              <FeedbackNotice
                feedback={toFeedback(firstPage.error, { fallback: "Failed to load authors" })}
              />
              <Button variant="secondary" size="md" onClick={firstPage.retry}>
                Retry
              </Button>
            </>
          ) : null}
          {loadMoreError ? <FeedbackNotice feedback={loadMoreError} /> : null}
          {loadingFirstPage ? <PaneLoadingState /> : null}
        </>
        ) : null
      }
      empty={
        !loadingFirstPage && firstPage.status !== "error" && entries.length === 0 ? (
        <FeedbackNotice
          severity="neutral"
          title="No authors yet."
          message="No contributors match the current filters."
        />
        ) : null
      }
      footer={
        nextCursor ? (
          <Button
            variant="secondary"
            size="md"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : null
      }
    >
      {!loadingFirstPage && firstPage.status !== "error" && entries.length > 0 ? (
          <ResourceList>
            {entries.map((entry) => (
              <ResourceRow
                key={entry.handle}
                primary={{
                  kind: "link",
                  href: entry.href,
                  paneTitleHint: entry.display_name,
                }}
                title={entry.display_name}
                meta={entryMeta(entry)}
                trailing={<Pill tone="info">{entry.work_count} works</Pill>}
              />
            ))}
          </ResourceList>
        ) : null}
    </PaneSurface>
  );
}

type FacetGroup = "roles" | "kinds" | "contentKinds" | "statuses";

function AuthorsToolbar({
  urlState,
  facets,
  onQueryChange,
  onToggle,
  onSortChange,
}: {
  urlState: AuthorsUrlState;
  facets: ContributorDirectoryFacets | null;
  onQueryChange: (q: string) => void;
  onToggle: (group: FacetGroup, value: string) => void;
  onSortChange: (sort: DirectorySort) => void;
}) {
  const [draftQuery, setDraftQuery] = useState(urlState.q);

  // Seed the controlled input from the URL whenever it changes externally.
  useEffect(() => {
    setDraftQuery(urlState.q);
  }, [urlState.q]);

  // Debounce text edits into the URL.
  useEffect(() => {
    if (draftQuery.trim() === urlState.q) return;
    const timer = setTimeout(() => onQueryChange(draftQuery), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftQuery, onQueryChange, urlState.q]);

  return (
    <div>
      <Input
        type="search"
        aria-label="Filter authors"
        value={draftQuery}
        onChange={(event) => setDraftQuery(event.target.value)}
        placeholder="Filter authors by name…"
      />

      <fieldset>
        <legend className="sr-only">Sort</legend>
        <Button
          variant="pill"
          size="sm"
          aria-pressed={urlState.sort === "works"}
          onClick={() => onSortChange("works")}
        >
          Works
        </Button>
        <Button
          variant="pill"
          size="sm"
          aria-pressed={urlState.sort === "name"}
          onClick={() => onSortChange("name")}
        >
          A–Z
        </Button>
      </fieldset>

      <FacetChips
        legend="Roles"
        counts={facets?.roles}
        selected={urlState.roles}
        label={contributorRoleLabel}
        onToggle={(value) => onToggle("roles", value)}
      />
      <FacetChips
        legend="Kinds"
        counts={facets?.kinds}
        selected={urlState.kinds}
        label={contributorKindLabel}
        onToggle={(value) => onToggle("kinds", value)}
      />
      <FacetChips
        legend="Content"
        counts={facets?.content_kinds}
        selected={urlState.contentKinds}
        label={contributorContentKindLabel}
        onToggle={(value) => onToggle("contentKinds", value)}
      />
      <FacetChips
        legend="Status"
        counts={facets?.statuses}
        selected={urlState.statuses}
        label={contributorStatusLabel}
        onToggle={(value) => onToggle("statuses", value)}
      />
    </div>
  );
}

function FacetChips({
  legend,
  counts,
  selected,
  label,
  onToggle,
}: {
  legend: string;
  counts: FacetCount[] | undefined;
  selected: string[];
  label: (value: string) => string;
  onToggle: (value: string) => void;
}) {
  if (!counts || counts.length === 0) {
    return null;
  }
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      {counts.map(({ value, count }) => (
        <Button
          key={value}
          variant="pill"
          size="sm"
          aria-pressed={selected.includes(value)}
          onClick={() => onToggle(value)}
        >
          {label(value)} ({count})
        </Button>
      ))}
    </fieldset>
  );
}
