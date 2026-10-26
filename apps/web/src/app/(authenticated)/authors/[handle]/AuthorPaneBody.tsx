"use client";

// The author pane: the person's other names and their visible works. The url
// owns the works view (`sort`, `direction`) and passes it to the server, which
// validates it; the text filter stays local. The filter and count cover the
// complete finite index; the local filter sees every visible kind.

import { useCallback, useId, useMemo } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
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
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useAuthorIndexReads } from "@/lib/panes/indexPaneEntry";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { browsePreviewHref } from "@/lib/browse/api";
import {
  listContributorWorks,
  type ContributorDetail,
  type ContributorWork,
} from "@/lib/contributors/api";
import {
  contributorRoleLabel,
  selectMediaAuthors,
} from "@/lib/contributors/credits";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import {
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
  definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listContributorWorks>>>>("Author.Works");

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
    presentation: "Index",
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
      primary: { ...row.primary, href: browsePreviewHref(work.target) },
      resourceActions: {
        kind: "Media",
        subject: {
          kind: "External",
          target: work.target,
          media_kind: "epub",
          title: work.title,
          contributors: work.contributors,
        },
        knownDescriptor: null,
      },
      contributors: selectMediaAuthors(work.contributors),
      context: null,
      resourceRef: null,
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
  const descriptors = useAuthorIndexReads();
  const detail = useServerValue({ ...descriptors.detail, visit: DETAIL });
  const works = useServerValue({ ...descriptors.works, visit: WORKS });
  const loaded = works.status === "ready" ? works.data.items : [];
  const worksFailure = works.status === "loading" ? null : works.error;
  const detailFailure = detail.status === "ready" ? detail.error : null;
  const worksBusy = indexReading(works);
  const retryWorks = () => { void works.refetch().catch(() => {}); };
  const summaries = useMediaSummaries(
    loaded.flatMap((work) =>
      work.kind === "Media" ? [work.media_summary] : [],
    ),
  );
  // A media work whose summary is no longer visible drops out.
  const rows = useMemo(
    () =>
      (works.status === "ready" ? works.data.items : []).flatMap((work) => {
        if (work.kind !== "Media") return [presentWork(work)];
        const summary = summaries.resolve(work.media_summary);
        return summary === null
          ? []
          : [presentWork({ ...work, media_summary: summary })];
      }),
    [works, summaries],
  );
  const complete = (works.status === "ready");
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
        indexRowStatus(works, rows.length, matches(text).length, {
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
    works.status === "failed" && works.error.code === "E_INVALID_REQUEST";
  const visible = matches(text);
  const emptyTitle = text
    ? "no works match this filter." : "no works yet.";
  const readFeedback = useIndexReadFeedback({
    value: works, requestedKey: descriptors.works.key, active, unit: { singular: "work", plural: "works" },
    waiting: !invalidView && works.status === "loading",
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
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
        visible: false,
        content: <PaneFilterRowsStatus announceQueryChanges={(works.status === "ready") && worksFailure === null} id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
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
    handle: detail.status === "ready" && detail.error?.status !== 403 && detail.error?.status !== 404 ? detail.data.handle : null,
    bodies: { linkedItems },
  });
  const { refetch: refetchDetail } = detail;
  const { refetch: refetchWorks } = works;
  const refresh = useCallback(async () => {
    try {
      await Promise.all([refetchDetail(), refetchWorks()]);
      return { kind: "Complete" as const, announcement: "author refreshed" };
    } catch { return { kind: "Failed" as const, announcement: "couldn’t refresh author" }; }
  }, [refetchDetail, refetchWorks]);
  usePaneChrome({
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
      <>
      {readFeedback.announcement}
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid works view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: resetView }]}
      />
      </>
    );
  }
  const failure =
    detail.status === "failed"
      ? detail.error
      : works.status === "failed"
        ? (worksFailure ?? null)
        : null;
  if (failure !== null) {
    const retry = () => {
      if (detail.status === "failed") detail.refetch();
      if (works.status === "failed") retryWorks();
    };
    return (
      <>
      {readFeedback.announcement}
      <FeedbackNotice
        content={authorError(failure, "couldn’t load author")}
        announcement="Polite"
        actions={
          failure.code === "E_NOT_FOUND"
            ? undefined
            : [{ label: "retry", onClick: retry, busy: (detail.status === "failed" && detail.retrying) || worksBusy }]
        }
      />
      </>
    );
  }
  if (detail.status !== "ready") {
    return (
      <>
      {readFeedback.announcement}
      <PaneSurface
        state={
          <PaneLoadingState label="Loading author…" announcement="Polite" />
        }
      />
      </>
    );
  }

  const { other_names: otherNames } = detail.data;
  return (
    <>
      {readFeedback.announcement}
      <PaneSurface state={detailFailure === null ? undefined : <FeedbackNotice
        content={authorError(detailFailure, "couldn’t refresh author")}
        announcement="None" actions={[{ label: "try again", onClick: detail.refetch, busy: indexReading(detail) }]}
        returnFocus={() => inputRef.current} />}>
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
            <CollectionView geometry="UniformIndex"
              returnScope="Author.Works"
              rows={visible}
              status={works.status === "loading" ? "loading" : "ready"}
              ariaLabel="Works"
              anchorKey={text}
              collectionBusy={worksBusy}
              surface={false}
              notice={<>
                {works.status === "ready" &&
                worksFailure !== null ? (
                  <FeedbackNotice
                    content={authorError(worksFailure, "couldn’t refresh works")}
                    announcement="None"
                    actions={[{ label: "try again", onClick: retryWorks, busy: worksBusy }]}
                    returnFocus={() => inputRef.current}
                  />
                ) : (
                  <MediaSummaryNotice
                    error={summaries.error}
                    retry={summaries.retry}
                    busy={summaries.retrying}
                  />
                )}
              </>}
              empty={
                text ? (
                  <FeedbackNotice
                    content={{
                      tone: "Neutral",
                      title: emptyTitle,
                    }}
                    announcement="None"
                  />
                ) : (
                  <p className={styles.empty}>{emptyTitle}</p>
                )
              }
            />
          </section>
        </div>
      </PaneSurface>
    </>
  );
}
