"use client";

// The author pane: the person's other names and their visible works. The url
// owns the works view (`sort`, `direction`) and passes it to the server, which
// validates it; the text filter stays local. While the pane is active it loads
// every page, so the filter and the "N works" count cover all works.

import { useCallback, useEffect, useMemo, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import SelectField from "@/components/ui/SelectField";
import PaneCollectionBar from "@/components/workspace/PaneCollectionBar";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import {
  listRowStatus,
  useServerList,
  useServerValue,
  type ListData,
  type Visit,
} from "@/lib/api/serverState";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import {
  getContributor,
  listContributorWorks,
  type ContributorDetail,
  type ContributorWork,
} from "@/lib/contributors/api";
import {
  contributorRoleLabel,
  selectMediaAuthors,
} from "@/lib/contributors/credits";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  useMediaQueryRevision,
  useMediaSummaries,
} from "@/lib/media/MediaSummaryProvider";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import {
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { usePodcastRevision } from "@/lib/podcasts/api";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const DETAIL =
  definePaneVisitDataKey<Visit<ContributorDetail>>("Author.Detail");
const WORKS =
  definePaneVisitDataKey<Visit<ListData<ContributorWork>>>("Author.Works");

const NO_WORKS: readonly ContributorWork[] = [];

/** The four views; the first is the default and owns no url keys. */
const SORTS = [
  { id: "", label: "Oldest published" },
  { id: "sort=published&direction=desc", label: "Newest published" },
  { id: "sort=title&direction=asc", label: "Title A–Z" },
  { id: "sort=title&direction=desc", label: "Title Z–A" },
] as const;

function authorError(error: unknown, title: string): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const { requestId } = error;
  if (error.code === "E_NOT_FOUND") {
    return {
      tone: "Danger",
      title: "This author is no longer available",
      requestId,
    };
  }
  if (error.code === "E_COLLECTION_CHANGED") {
    const message = "The works changed while loading.";
    return { tone: "Danger", title, message, requestId };
  }
  const transport = apiTransportFeedback(error, title);
  if (transport === null) throw error;
  return transport;
}

function presentWork(work: ContributorWork): CollectionRowView {
  if (work.kind === "Media") {
    const actionSubject = {
      ref: assumeCanonicalResourceRef(work.actionSubject.ref),
    };
    return presentMedia(work.mediaSummary, {
      id: actionSubject.ref,
      primary: {
        kind: "link",
        href: work.href,
        viewTransition: "media-reader",
      },
      actionSubject,
      selected: false,
    });
  }
  const row = {
    kind: "contributor_work",
    primary: { kind: "link", href: work.href, paneLabelHint: work.title },
    title: { text: work.title },
    publicationDate: absent<string>(),
    activity: absent<never>(),
    exceptionalStatus: absent<never>(),
    selected: false,
  } as const;
  if (work.kind === "ExternalWork") {
    return {
      ...row,
      id: work.href,
      mediaIdentity: "External",
      contributors: selectMediaAuthors(work.contributors),
      context: absent(),
      actionSubject: null,
    };
  }
  const roles = work.roleFacts.map((fact) =>
    contributorRoleLabel(fact.role, 1),
  );
  const text = [...new Set(roles), "Publication date unknown"].join(" · ");
  const ref = assumeCanonicalResourceRef(work.actionSubject.ref);
  return {
    ...row,
    id: ref,
    contributors: [],
    context: present({ kind: "Text", text }),
    actionSubject: { ref },
  };
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  if (!handle) throw new Error("author route requires a handle");
  const active = usePaneIsActive();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  // The view keys pass through verbatim, duplicates included: the server
  // rejects anything that is not one of the four views.
  const view = new URLSearchParams([
    ...params.getAll("sort").map((value) => ["sort", value]),
    ...params.getAll("direction").map((value) => ["direction", value]),
  ]).toString();
  const stale = `${useMediaQueryRevision()}:${usePodcastRevision()}`;
  const detail = useServerValue({
    key: handle,
    stale,
    visit: DETAIL,
    load: (signal) => getContributor(handle, signal),
  });
  const works = useServerList<ContributorWork>({
    key: `${handle}?${view}`,
    stale,
    pageSize: 100,
    visit: WORKS,
    fetchPage: (page, signal) =>
      listContributorWorks(
        handle,
        new URLSearchParams(`${view}&${page}`),
        signal,
      ),
  });
  // Drain while active: one page at a time, stopping at the first error.
  const drain =
    active &&
    works.status === "ready" &&
    !works.complete &&
    !works.loadingMore &&
    works.error === null;
  useEffect(() => {
    if (drain) works.loadMore();
  });

  const loaded = works.status === "ready" ? works.items : NO_WORKS;
  const summaries = useMediaSummaries(
    loaded.flatMap((work) =>
      work.kind === "Media" ? [work.mediaSummary] : [],
    ),
  );
  // A media work whose summary is no longer visible drops out.
  const rows = useMemo(
    () =>
      loaded.flatMap((work) => {
        if (work.kind !== "Media") return [presentWork(work)];
        const summary = summaries.resolve(work.mediaSummary);
        return summary.kind === "Absent"
          ? []
          : [presentWork({ ...work, mediaSummary: summary.value })];
      }),
    [loaded, summaries],
  );
  const complete = works.status === "ready" && works.complete;
  const matches = useCallback(
    (text: string) =>
      rows.filter((row) =>
        matchesPaneFilterQuery(
          text,
          mediaListFilterFields({
            title: row.title.text,
            contributors: row.contributors,
          }),
        ),
      ),
    [rows],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: `Author.Works:${handle}`,
    getRowStatus: useCallback(
      (text: string) =>
        listRowStatus(
          works.status,
          complete,
          rows.length,
          matches(text).length,
          "work",
        ),
      [complete, matches, rows.length, works.status],
    ),
  });
  const text = filterRows.query.trim();

  const { clearQuery } = filterRows;
  const setView = useCallback(
    (next: string) => {
      const query = new URLSearchParams(next);
      for (const [key, value] of params) {
        if (key !== "sort" && key !== "direction") query.append(key, value);
      }
      const suffix = query.toString() ? `?${query}` : "";
      router.replace(`/authors/${encodeURIComponent(handle)}${suffix}`, {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [handle, params, router],
  );
  const sortRef = useRef<HTMLSelectElement>(null);
  const resetView = useCallback(() => {
    clearQuery();
    setView("");
    // The pressed button goes away with the view: keep focus on the control.
    requestAnimationFrame(() =>
      sortRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, setView]);
  const { inputRef, focusInput } = usePaneCollectionInput();
  const invalidView =
    works.status === "failed" && works.error.code === "E_INVALID_REQUEST";
  const collection = useMemo(
    () =>
      invalidView
        ? undefined
        : {
            label: "Filter works",
            content: (
              <PaneCollectionBar
                inputRef={inputRef}
                inputLabel="Filter works"
                placeholder="Filter works"
                query={filterRows.query}
                onQueryChange={filterRows.onQueryChange}
                onClearQuery={filterRows.clearQuery}
                rowStatus={filterRows.rowStatus}
                filters={
                  <SelectField
                    ref={sortRef}
                    layout="Inline"
                    label="Sort works"
                    size="sm"
                    value={view}
                    onChange={(event) => setView(event.target.value)}
                  >
                    {SORTS.map((sort) => (
                      <option key={sort.id} value={sort.id}>
                        {sort.label}
                      </option>
                    ))}
                  </SelectField>
                }
                controls={
                  view === "" ? undefined : (
                    <Button variant="ghost" size="sm" onClick={resetView}>
                      Reset view
                    </Button>
                  )
                }
              />
            ),
            focusInput,
          },
    [filterRows, focusInput, inputRef, invalidView, resetView, setView, view],
  );

  const ref =
    detail.status === "ready"
      ? parseResourceRef(detail.data.actionSubject.ref)
      : null;
  const contributorId = ref?.scheme === "contributor" ? ref.id : null;
  const linkedItems = useMemo(
    () =>
      contributorId !== null ? (
        <ConnectionsSurface
          resourceRef={{ scheme: "contributor", id: contributorId }}
        />
      ) : (
        <FeedbackNotice
          content={
            detail.status === "failed"
              ? { tone: "Neutral", title: "Connections unavailable" }
              : { tone: "Info", title: "Loading connections…" }
          }
          announcement="None"
        />
      ),
    [contributorId, detail.status],
  );
  const { companionAction } = useResourceInspector({
    scheme: "contributor",
    handle: detail.status === "ready" ? detail.data.handle : null,
    bodies: { linkedItems },
  });
  useSetPaneLabel(
    detail.status === "ready"
      ? detail.data.displayName
      : detail.status === "failed"
        ? "Author"
        : null,
  );
  const { refetch: refetchDetail } = detail;
  const { refetch: refetchWorks } = works;
  const refresh = useCallback(async () => {
    refetchDetail();
    refetchWorks();
    return { kind: "Complete" as const, announcement: "Refreshing author" };
  }, [refetchDetail, refetchWorks]);
  usePanePrimaryChrome({
    collection,
    companionAction: companionAction ?? undefined,
    actionSubject:
      detail.status === "ready"
        ? { ref: assumeCanonicalResourceRef(detail.data.actionSubject.ref) }
        : undefined,
    refresh: {
      kind: "Refreshable",
      sourceKey: `Author.Works:${handle}`,
      execute: refresh,
    },
    header: {
      kind: "Section",
      meta: invalidView
        ? { kind: "None" }
        : complete
          ? { kind: "Count", value: rows.length, unit: "work" }
          : { kind: "Pending" },
    },
  });
  usePaneReturnReady(detail.status !== "loading" && works.status !== "loading");

  if (invalidView) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid works view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: resetView }]}
      />
    );
  }
  const failure =
    detail.status === "failed"
      ? detail.error
      : works.status === "failed"
        ? works.error
        : null;
  if (failure !== null) {
    const retry = () => {
      if (detail.status === "failed") detail.refetch();
      if (works.status === "failed") works.retry();
    };
    return (
      <FeedbackNotice
        content={authorError(failure, "This author couldn’t be loaded")}
        announcement="Assertive"
        actions={
          failure.code === "E_NOT_FOUND"
            ? undefined
            : [{ label: "Retry", onClick: retry }]
        }
      />
    );
  }
  if (detail.status !== "ready") {
    return (
      <PaneSurface
        state={
          <PaneLoadingState label="Loading author…" announcement="Polite" />
        }
      />
    );
  }

  const { otherNames } = detail.data;
  return (
    <PaneSurface>
      <div className={styles.detail}>
        {otherNames.length > 0 ? (
          <section className={styles.otherNames}>
            <h2 className={styles.sectionHeading}>Other names</h2>
            <p className={styles.otherNamesList}>
              {otherNames.map((name, index) => (
                <span key={`${name}-${index}`}>
                  {index > 0 ? ", " : null}
                  <span dir="auto">{name}</span>
                </span>
              ))}
            </p>
          </section>
        ) : null}
        <section aria-label="Works">
          <CollectionView
            returnScope="Author.Works"
            rows={matches(text)}
            status={works.status === "loading" ? "loading" : "ready"}
            ariaLabel="Works"
            rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
            collectionBusy={works.status === "ready" && works.loadingMore}
            surface={false}
            notice={
              works.status === "ready" && works.error !== null ? (
                <FeedbackNotice
                  content={authorError(works.error, "Works couldn’t be loaded")}
                  announcement="Polite"
                  actions={[{ label: "Retry", onClick: works.retry }]}
                />
              ) : (
                <MediaSummaryNotice
                  error={summaries.error}
                  retry={summaries.retry}
                />
              )
            }
            empty={
              text ? (
                <FeedbackNotice
                  content={{
                    tone: "Neutral",
                    title: complete
                      ? "No works match this filter."
                      : "No matching work found so far.",
                  }}
                  announcement="None"
                />
              ) : (
                <p className={styles.empty}>No works yet.</p>
              )
            }
          />
        </section>
      </div>
    </PaneSurface>
  );
}
