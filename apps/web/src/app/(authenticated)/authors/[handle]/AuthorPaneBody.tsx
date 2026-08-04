"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Button from "@/components/ui/Button";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import Input from "@/components/ui/Input";
import Dialog from "@/components/ui/Dialog";
import PaneSurface from "@/components/ui/PaneSurface";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { contributorResource } from "@/lib/api/resource";
import type {
  CollectionCursor,
  CollectionPage,
  CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchContributorWorks,
  patchContributorDisplayName,
} from "@/lib/contributors/api";
import { createMutationIntent } from "@/lib/contributors/mutationIntent";
import type {
  ContributorDetail,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import { presentContributorWork } from "@/lib/collections/presenters/presentContributorWork";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  paneResourceLoaders,
  type AuthorPaneSeed,
} from "@/lib/panes/paneResourceLoaders";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import {
  definePaneVisitDataKey,
  type PaneResourceStatus,
  useClearAllPaneVisitData,
  usePaneIsActive,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { isAbortError } from "@/lib/errors";
import styles from "./page.module.css";

type AuthorConnectionsResource =
  | { kind: "Ready"; ref: { scheme: "contributor"; id: string } }
  | { kind: "Loading" }
  | { kind: "Unavailable" };

const AUTHOR_VISIT_DATA =
  definePaneVisitDataKey<AuthorPaneSeed>("Author.Works");
const NO_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_REVISION = 0 as CollectionRevision;

function authorLoadErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This author is no longer available",
        requestId: error.requestId,
      };
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "This author couldn’t be loaded",
        message: "Check your connection and retry.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

function authorRenameErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "The change couldn’t be confirmed",
        message: "Retry to safely check whether it was saved.",
        requestId: error.requestId,
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This author is no longer available",
        requestId: error.requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title: "You can’t rename this author",
        requestId: error.requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title: "Enter a valid author name",
        requestId: error.requestId,
      };
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      return {
        tone: "Danger",
        title: "The name wasn’t updated",
        message: "Retry the saved draft.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

interface PendingAuthorRevalidation {
  readonly version: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

function resolveAuthorConnectionsResource(
  resourceRef: string | null,
  resourceStatus: PaneResourceStatus,
): AuthorConnectionsResource {
  const parsed = resourceRef ? parseResourceRef(resourceRef) : null;
  if (parsed?.scheme === "contributor") {
    return {
      kind: "Ready",
      ref: { scheme: "contributor", id: parsed.id },
    };
  }
  switch (resourceStatus) {
    case "none":
    case "pending":
      return { kind: "Loading" };
    case "ready":
    case "missing":
    case "unauthorized":
    case "invalid":
    case "error":
      return { kind: "Unavailable" };
    default: {
      const exhaustive: never = resourceStatus;
      return exhaustive;
    }
  }
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  const paneRuntime = usePaneRuntime();
  const runtime = requirePaneRuntime(paneRuntime, "AuthorPaneBody");
  const isPaneActive = usePaneIsActive();
  const activateTarget = runtime.activateTarget;
  const committedSnapshotRef = useRef<AuthorPaneSeed | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(AUTHOR_VISIT_DATA, captureCommitted);
  if (committedSnapshotRef.current === null && restored !== null) {
    committedSnapshotRef.current = restored;
  }
  const allowResourceAdoptionRef = useRef(restored === null);
  const clearAllVisitData = useClearAllPaneVisitData();
  const [firstPageVersion, setFirstPageVersion] = useState(0);
  const firstPageVersionRef = useRef(0);
  const pendingAuthorRevalidationRef =
    useRef<PendingAuthorRevalidation | null>(null);
  const completedAuthorRevalidationVersionRef = useRef<number | null>(null);
  const [refreshingWorks, setRefreshingWorks] = useState(false);
  const [chainEpoch, setChainEpoch] = useState(0);
  const initialAuthor = useResource<AuthorPaneSeed>({
    cacheKey:
      handle && (restored === null || firstPageVersion > 0)
        ? firstPageVersion === 0
          ? contributorResource.cacheKey({ handle })
          : `${contributorResource.cacheKey({ handle })}:collection:${firstPageVersion}`
        : null,
    load: (signal) =>
      paneResourceLoaders.author!.load(clientResourceFetcher(signal), {
        handle: handle!,
      }) as Promise<AuthorPaneSeed>,
  });

  const [data, setData] = useState<AuthorPaneSeed | null>(restored);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const loading =
    !!handle && !error && (data === null || data.detail.handle !== handle);

  // Reset the local copy whenever the route handle changes, so stale author data
  // never bleeds across panes while the next initial load runs.
  useEffect(() => {
    if (restored === null) setData(null);
    setError(
      handle ? null : { tone: "Danger", title: "Author handle is missing" },
    );
    setRenameOpen(false);
  }, [handle, restored]);

  // Seed the local copy from the initial resource's ready/error branch.
  useEffect(() => {
    if (initialAuthor.status === "ready" && allowResourceAdoptionRef.current) {
      allowResourceAdoptionRef.current = false;
      committedSnapshotRef.current = initialAuthor.data;
      setData(initialAuthor.data);
      setChainEpoch((epoch) => epoch + 1);
      setError(null);
      setRefreshingWorks(false);
      const pending = pendingAuthorRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        completedAuthorRevalidationVersionRef.current = pending.version;
      }
    } else if (
      initialAuthor.status === "error" &&
      allowResourceAdoptionRef.current
    ) {
      setRefreshingWorks(false);
      try {
        setError(authorLoadErrorMessage(initialAuthor.error));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
      const pending = pendingAuthorRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        pendingAuthorRevalidationRef.current = null;
        completedAuthorRevalidationVersionRef.current = null;
        pending.removeAbortListener();
        pending.reject(initialAuthor.error);
      }
    }
  }, [firstPageVersion, initialAuthor]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = data;
    const pending = pendingAuthorRevalidationRef.current;
    if (
      data === null ||
      data.detail.handle !== handle ||
      pending === null ||
      completedAuthorRevalidationVersionRef.current !== pending.version
    ) {
      return;
    }
    completedAuthorRevalidationVersionRef.current = null;
    pendingAuthorRevalidationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [data, handle]);

  usePaneReturnReady(data !== null || error !== null);
  useSetPaneLabel(loading ? null : (data?.detail.displayName ?? "Author"));

  const rejectPendingAuthorRevalidation = useCallback((error: unknown) => {
    const pending = pendingAuthorRevalidationRef.current;
    pendingAuthorRevalidationRef.current = null;
    completedAuthorRevalidationVersionRef.current = null;
    if (!pending) return;
    pending.removeAbortListener();
    pending.reject(error);
  }, []);
  const refreshWorks = useCallback(() => {
    rejectPendingAuthorRevalidation(
      new DOMException("Author refresh was superseded.", "AbortError"),
    );
    allowResourceAdoptionRef.current = true;
    clearAllVisitData();
    setError(null);
    setRefreshingWorks(true);
    const version = firstPageVersionRef.current + 1;
    firstPageVersionRef.current = version;
    setFirstPageVersion(version);
  }, [clearAllVisitData, rejectPendingAuthorRevalidation]);
  const revalidateWorks = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException("Author refresh was aborted.", "AbortError"),
        );
      }
      refreshWorks();
      const version = firstPageVersionRef.current;
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingAuthorRevalidationRef.current;
          if (pending?.version !== version) return;
          pendingAuthorRevalidationRef.current = null;
          completedAuthorRevalidationVersionRef.current = null;
          pending.removeAbortListener();
          allowResourceAdoptionRef.current = false;
          setRefreshingWorks(false);
          reject(
            signal.reason ??
              new DOMException("Author refresh was aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingAuthorRevalidationRef.current = {
          version,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [refreshWorks],
  );
  useEffect(
    () => () => {
      rejectPendingAuthorRevalidation(
        new DOMException("Author refresh source was replaced.", "AbortError"),
      );
    },
    [handle, rejectPendingAuthorRevalidation],
  );
  const commitWorksPage = useCallback(
    (page: CollectionPage<ContributorWorkItem>): number => {
      const current = committedSnapshotRef.current;
      if (
        current === null ||
        current.collectionRevision !== page.collectionRevision
      ) {
        throw new Error("Author continuation settled for a stale collection");
      }
      const seen = new Set(current.works.map((work) => work.href));
      const works = [...current.works];
      for (const work of page.items) {
        if (seen.has(work.href)) continue;
        seen.add(work.href);
        works.push(work);
      }
      const next: AuthorPaneSeed = {
        ...current,
        works,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = next;
      setData(next);
      return works.length;
    },
    [],
  );
  const exhaustion = useExhaustivePagination<ContributorWorkItem>({
    active:
      isPaneActive &&
      data !== null &&
      data.detail.handle === handle &&
      !refreshingWorks,
    chainKey: `${handle ?? ""}:${chainEpoch}`,
    cursor: data?.nextCursor ?? NO_CURSOR,
    collectionRevision: data?.collectionRevision ?? ZERO_REVISION,
    itemCount: data?.works.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) =>
      fetchContributorWorks(handle!, {
        cursor,
        collectionRevision,
        limit: 100,
        signal,
      }),
    commitPage: commitWorksPage,
    refresh: refreshWorks,
  });

  const workCount = data?.works.length ?? 0;
  const workRows = useMemo(
    () => data?.works.map(presentContributorWork) ?? [],
    [data?.works],
  );
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount =
        data?.works.filter((work) =>
          matchesPaneFilterQuery(query, [work.title]),
        ).length ?? 0;
      const unit = { singular: "work", plural: "works" };
      return exhaustion.kind === "Complete"
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: workCount,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: workCount,
            unit,
          };
    },
    [data?.works, exhaustion.kind, workCount],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: `Author.Works:${handle ?? ""}`,
    inputLabel: "Filter works",
    placeholder: "Filter works",
    getRowStatus: getFilterStatus,
    activeDomainControlCount: 0,
  });
  const filteredWorkRows = useMemo(
    () =>
      workRows.filter((row) =>
        matchesPaneFilterQuery(filterQuery, [row.title.text]),
      ),
    [filterQuery, workRows],
  );
  const canonicalHandle = data?.detail.handle ?? null;
  const connectionsComposerController = useConnectionsComposerController({
    scheme: "contributor",
    id: canonicalHandle ?? handle ?? "",
  });
  const connectionsResource = useMemo(
    () =>
      resolveAuthorConnectionsResource(
        paneRuntime?.resourceRef ?? null,
        paneRuntime?.resourceStatus ?? "none",
      ),
    [paneRuntime?.resourceRef, paneRuntime?.resourceStatus],
  );
  const connectionsBody = useMemo(
    () =>
      connectionsResource.kind === "Ready" ? (
        <ConnectionsSurface
          resourceRef={connectionsResource.ref}
          composerController={connectionsComposerController}
          activateTarget={activateTarget}
        />
      ) : connectionsResource.kind === "Loading" ? (
        <FeedbackNotice
          content={{ tone: "Info", title: "Loading connections…" }}
          announcement="None"
        />
      ) : (
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: "Connections unavailable",
            message: "This author’s resource identity could not be resolved.",
          }}
          announcement="None"
        />
      ),
    [activateTarget, connectionsComposerController, connectionsResource],
  );
  const { companionAction } = useResourceInspector({
    scheme: "contributor",
    handle: canonicalHandle,
    bodies: { linkedItems: connectionsBody },
  });
  const executeRefresh = useCallback(
    async ({ signal }: { readonly signal: AbortSignal }) => {
      try {
        await revalidateWorks(signal);
        return {
          kind: "Complete" as const,
          announcement: "Author refreshed",
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        return {
          kind: "Failed" as const,
          announcement: "Author failed to refresh",
        };
      }
    },
    [revalidateWorks],
  );
  usePanePrimaryChrome({
    search,
    refresh: handle
      ? {
          sourceKey: `Author.Works:${handle}`,
          execute: executeRefresh,
        }
      : undefined,
    actions: companionAction ? [companionAction] : [],
    resourceTarget: data ? data.detail.actionTarget : undefined,
    header: {
      kind: "section",
      folio:
        exhaustion.kind === "Complete"
          ? { kind: "count", value: workCount, unit: "work" }
          : { kind: "none" },
      pending: loading || refreshingWorks || exhaustion.kind !== "Complete",
    },
  });

  const otherNames = data?.detail.otherNames ?? [];
  const handleRenamed = useCallback(
    (detail: ContributorDetail) => {
      setData((current) =>
        current && current.detail.handle === detail.handle
          ? { ...current, detail }
          : current,
      );
      clearAllVisitData();
    },
    [clearAllVisitData],
  );

  if (defect) throw defect.error;

  return (
    <PaneSurface
      state={
        loading || (error && !data) ? (
          <>
            {loading ? (
              <PaneLoadingState label="Loading author…" announcement="Polite" />
            ) : null}
            {loading && filterQuery.trim() ? (
              <FeedbackNotice
                content={{
                  tone: "Neutral",
                  title: "No matching work found so far.",
                }}
                announcement="None"
              />
            ) : null}
            {error && !data ? (
              <FeedbackNotice content={error} announcement="Assertive" />
            ) : null}
          </>
        ) : null
      }
    >
      {data ? (
        <div className={styles.detail}>
          <header className={styles.header}>
            <h1 className={styles.heading} dir="auto">
              {data.detail.displayName}
            </h1>
            {data.detail.canRename ? (
              <Button
                variant="secondary"
                size="sm"
                className={styles.editName}
                onClick={() => setRenameOpen(true)}
              >
                Edit name
              </Button>
            ) : null}
          </header>

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
              rows={filteredWorkRows}
              status="ready"
              ariaLabel="Works"
              rowChangePresentation={{
                kind: "ImmediateOnKeyChange",
                key: filterQuery.trim(),
              }}
              collectionBusy={exhaustion.kind === "Draining"}
              surface={false}
              notice={
                error && data ? (
                  <FeedbackNotice content={error} announcement="Assertive" />
                ) : undefined
              }
              empty={
                filterQuery.trim() ? (
                  exhaustion.kind === "Complete" ? (
                    <FeedbackNotice
                      content={{
                        tone: "Neutral",
                        title: "No works match this filter.",
                      }}
                      announcement="None"
                    />
                  ) : (
                    <FeedbackNotice
                      content={{
                        tone: "Neutral",
                        title: "No matching work found so far.",
                      }}
                      announcement="None"
                    />
                  )
                ) : (
                  <p className={styles.empty}>No works yet.</p>
                )
              }
              footer={<CollectionExhaustionNotice state={exhaustion} />}
            />
          </section>

          {renameOpen ? (
            <RenameAuthorDialog
              handle={data.detail.handle}
              currentName={data.detail.displayName}
              onClose={() => setRenameOpen(false)}
              onRenamed={handleRenamed}
            />
          ) : null}
        </div>
      ) : null}
    </PaneSurface>
  );
}

function RenameAuthorDialog({
  handle,
  currentName,
  onClose,
  onRenamed,
}: {
  handle: string;
  currentName: string;
  onClose: () => void;
  onRenamed: (detail: ContributorDetail) => void;
}) {
  const [value, setValue] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const intentRef = useRef(createMutationIntent());
  const emptyErrorId = useId();

  const trimmed = value.trim();
  const isBlank = trimmed.length === 0;
  const isUnchanged = trimmed === currentName.trim();
  const canSave = !isBlank && !isUnchanged && !saving;

  const emptyFeedback = useMemo<FeedbackContent | null>(
    () => (isBlank ? { tone: "Danger", title: "Enter a name." } : null),
    [isBlank],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setNotice(null);
    const clientMutationId = intentRef.current.clientMutationId(trimmed);
    try {
      const detail = await patchContributorDisplayName(handle, {
        clientMutationId,
        displayName: trimmed,
      });
      intentRef.current.discard();
      onRenamed(detail);
      onClose();
    } catch (renameError) {
      if (handleUnauthenticatedApiError(renameError)) return;
      if (isApiError(renameError)) {
        // A proven 409 replay mismatch rotates the mutation id — the reused key is
        // now bound to a different request server-side (spec §7 shared
        // mutation-intent rule; matches MediaAuthorsEditor). Other 4xx keep the
        // key. The draft is preserved either way.
        if (renameError.code === "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH") {
          intentRef.current.rotate();
        }
        try {
          setNotice(authorRenameErrorMessage(renameError));
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      } else {
        setDefect({ error: renameError });
      }
    } finally {
      setSaving(false);
    }
  }

  if (defect) throw defect.error;

  return (
    <Dialog open title="Edit name" onClose={onClose}>
      <form className={styles.renameForm} onSubmit={submit}>
        <p className={styles.renameHelper}>
          Used across Nexus. Each work keeps the name it was credited under.
        </p>
        <label className={styles.renameField}>
          <span className={styles.renameLabel}>Author name</span>
          <Input
            value={value}
            dir="auto"
            autoFocus
            aria-invalid={isBlank || undefined}
            aria-describedby={isBlank ? emptyErrorId : undefined}
            onChange={(nextEvent) => setValue(nextEvent.target.value)}
          />
        </label>
        <FieldFeedback content={emptyFeedback} id={emptyErrorId} />
        {notice ? (
          <FeedbackNotice content={notice} announcement="Assertive" />
        ) : null}
        <div className={styles.renameActions}>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!canSave}
            loading={saving}
          >
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
