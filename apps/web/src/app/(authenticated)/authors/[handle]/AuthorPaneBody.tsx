"use client";

import { useResourceComposer } from "@/components/resources/ResourceComposer";

// The author pane: the person's other names and their visible works. The url
// owns the works view (`sort`, `direction`) and passes it to the server, which
// validates it; the text filter stays local. While the pane is active it loads
// every page, so the filter and the "N works" count cover all works.

import { useCallback, useId, useMemo } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import PaneSurface from "@/components/ui/PaneSurface";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
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
} from "@/lib/panes/paneRuntime";
import {
  matchesPaneFilterQuery,
  paneFilterRowsStatusVisible,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
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
  definePaneVisitDataKey<ListSnapshot<ContributorWork>>("Author.Works");

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
  const transport = apiTransportFeedback(error, title);
  if (transport === null) throw error;
  return transport;
}

function presentWork(work: ContributorWork): CollectionRowView {
  if (work.kind === "Media") {
    const resourceRef = assumeCanonicalResourceRef(work.action_ref);
    return presentMedia(work.media_summary, {
      id: resourceRef,
      primary: {
        kind: "link",
        href: work.href,
      },
      resourceRef,
      selected: false,
    });
  }
  const row = {
    kind: "contributor_work",
    primary: { kind: "link", href: work.href, paneLabelHint: work.title },
    title: { text: work.title },
    publicationDate: null,
    activity: null,
    exceptionalStatus: null,
    selected: false,
  } as const;
  if (work.kind === "ExternalWork") {
    return {
      ...row,
      id: work.href,
      mediaIdentity: "External",
      contributors: selectMediaAuthors(work.contributors),
      context: null,
      resourceRef: null,
      insertionSource:null,
    };
  }
  const roles = work.role_facts.map((fact) =>
    contributorRoleLabel(fact.role, 1),
  );
  const text = [...new Set(roles), "Publication date unknown"].join(" · ");
  const resourceRef = assumeCanonicalResourceRef(work.action_ref);
  return {
    ...row,
    id: resourceRef,
    contributors: [],
    context: { kind: "Text", text },
    resourceRef,
    insertionSource:{kind:"resource",ref:work.resource_ref},
  };
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  if (!handle) throw new Error("author route requires a handle");
  return <AuthorPane key={handle} handle={handle} />;
}

function AuthorPane({ handle }: { readonly handle: string }) {
  const active = usePaneIsActive();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  // The view keys pass through verbatim, duplicates included: the server
  // rejects anything that is not one of the four views.
  const view = new URLSearchParams([
    ...params.getAll("sort").map((value) => ["sort", value]),
    ...params.getAll("direction").map((value) => ["direction", value]),
  ]).toString();
  const stale = `${useMediaQueryRevision()}:${useChangeStamp("Podcasts")}`;
  const detail = useServerValue({
    key: `/contributors/${encodeURIComponent(handle)}`,
    stale,
    visit: DETAIL,
    load: (signal) => getContributor(handle, signal),
  });
  const works = useServerList<ContributorWork>({
    key: `/contributors/${encodeURIComponent(handle)}/works?${view}`,
    stale,
    pageSize: 100,
    drain: true,
    active,
    visit: WORKS,
    id: (work) => work.href,
    fetchPage: (cursor, limit, signal) =>
      listContributorWorks(handle, pageQuery(view, cursor, limit), signal),
  });
  const loaded = works.items;
  const summaries = useMediaSummaries(
    loaded.flatMap((work) =>
      work.kind === "Media" ? [work.media_summary] : [],
    ),
  );
  // A media work whose summary is no longer visible drops out.
  const rows = useMemo(
    () =>
      loaded.flatMap((work) => {
        if (work.kind !== "Media") return [presentWork(work)];
        const summary = summaries.resolve(work.media_summary);
        return summary === null
          ? []
          : [presentWork({ ...work, media_summary: summary })];
      }),
    [loaded, summaries],
  );
  const complete = works.complete;
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
        listRowStatus(works, rows.length, matches(text).length, {
          singular: "work",
          plural: "works",
        }),
      [matches, rows.length, works],
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
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const resetView = useCallback(() => {
    clearQuery();
    setView("");
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [clearQuery, inputRef, setView]);
  const invalidView =
    works.status === "failed" && works.failure?.error.code === "E_INVALID_REQUEST";
  const canReset = view.length > 0;
  const headerMeta: PaneHeaderMeta = invalidView
    ? { kind: "None" }
    : complete
      ? { kind: "Count", value: rows.length, unit: "work" }
      : { kind: "Pending" };
  const queryControls = invalidView ? undefined : {
    kind: "Controls" as const,
    label: "Filter works",
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: "Filter works", placeholder: "Filter works", value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: clearQuery }}
      sort={{ label: "Sort", value: view, choices: SORTS.map(({ id, label }) => ({ value: id, label })), onChange: setView }}
      status={{
        placement: "Inline",
        id: queryStatusId,
        visible: paneFilterRowsStatusVisible({
          status: filterRows.rowStatus,
          filtering: text !== "",
        }),
        content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
      }}
      onReset={canReset ? resetView : undefined}
    />,
  };

  const ref =
    detail.status === "ready"
      ? parseResourceRef(detail.data.action_ref)
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
  useResourceInspector({
    scheme: "contributor",
    handle: detail.status === "ready" ? detail.data.handle : null,
    bodies: { linkedItems },
  });
  const { refetch: refetchDetail } = detail;
  const { refetch: refetchWorks } = works;
  const refresh = useCallback(async () => {
    refetchDetail();
    // a failed reread shows as the list's failure
    refetchWorks().catch(() => {});
    return { kind: "Complete" as const, announcement: "Refreshing author" };
  }, [refetchDetail, refetchWorks]);
  const insertion=useResourceComposer(detail.status === "ready" ? {kind:"resource",ref:detail.data.resource_ref} : null,`contributor:${handle}`,"add item");
  usePaneChrome({
    menuActions:insertion.action ? [insertion.action] : [],
    query: queryControls,
    resourceRef:
      detail.status === "ready"
        ? assumeCanonicalResourceRef(detail.data.action_ref)
        : undefined,
    refresh: {
      kind: "Refreshable",
      sourceKey: `Author.Works:${handle}`,
      execute: refresh,
    },
    header: { kind: "Section", meta: headerMeta },
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
        ? (works.failure?.error ?? null)
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
            : [{ label: "retry", onClick: retry, busy: (detail.status === "failed" && detail.retrying) || works.running !== null }]
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

  const { other_names: otherNames } = detail.data;
  return (
    <PaneSurface>
      {insertion.content}
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
            collectionBusy={works.running !== null}
            surface={false}
            notice={
              works.status === "ready" &&
              works.failure !== null &&
              works.failure.op !== "More" ? (
                <FeedbackNotice
                  content={authorError(works.failure.error, "Works couldn’t be loaded")}
                  announcement="Polite"
                  actions={[{ label: "Retry", onClick: works.retry, busy: works.running !== null }]}
                />
              ) : (
                <MediaSummaryNotice
                  error={summaries.error}
                  retry={summaries.retry}
                busy={summaries.retrying}
                />
              )
            }
            footer={<CollectionExhaustionNotice list={works} />}
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
