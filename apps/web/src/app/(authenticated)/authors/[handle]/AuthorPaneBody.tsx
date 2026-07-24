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
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError } from "@/lib/api/client";
import { contributorResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchContributorWorks,
  patchContributorDisplayName,
} from "@/lib/contributors/api";
import { createMutationIntent } from "@/lib/contributors/mutationIntent";
import type { ContributorDetail } from "@/lib/contributors/types";
import { presentContributorWork } from "@/lib/collections/presenters/presentContributorWork";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { paneResourceLoaders, type AuthorPaneSeed } from "@/lib/panes/paneResourceLoaders";
import {
  definePaneVisitDataKey,
  type PaneResourceStatus,
  useClearAllPaneVisitData,
  usePaneParam,
  usePaneReturnReady,
  usePaneRouter,
  usePaneRuntime,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import styles from "./page.module.css";

type AuthorConnectionsResource =
  | { kind: "Ready"; ref: { scheme: "contributor"; id: string } }
  | { kind: "Loading" }
  | { kind: "Unavailable" };

const AUTHOR_VISIT_DATA =
  definePaneVisitDataKey<AuthorPaneSeed>("Author.Works");

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
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const committedSnapshotRef = useRef<AuthorPaneSeed | null>(null);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(AUTHOR_VISIT_DATA, captureCommitted);
  const allowResourceAdoptionRef = useRef(restored === null);
  const initialAuthor = useResource<AuthorPaneSeed, { handle: string }>({
    descriptor: contributorResource,
    params: handle && restored === null ? { handle } : null,
    load: (params, signal) =>
      paneResourceLoaders.author!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<AuthorPaneSeed>,
  });

  const [data, setData] = useState<AuthorPaneSeed | null>(restored);
  const clearAllVisitData = useClearAllPaneVisitData();
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [worksError, setWorksError] = useState<FeedbackContent | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const worksRegionRef = useRef<HTMLElement>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);

  const loading =
    !!handle && !error && (data === null || data.detail.handle !== handle);

  // Reset the local copy whenever the route handle changes, so stale author data
  // never bleeds across panes while the next initial load runs.
  useEffect(() => {
    if (restored === null) setData(null);
    setError(handle ? null : { severity: "error", title: "Author handle is missing" });
    setWorksError(null);
    setLoadingMore(false);
    setRenameOpen(false);
    setAnnouncement("");
    pendingFocusIndexRef.current = null;
  }, [handle, restored]);

  // Seed the local copy from the initial resource's ready/error branch.
  useEffect(() => {
    if (
      initialAuthor.status === "ready" &&
      allowResourceAdoptionRef.current
    ) {
      allowResourceAdoptionRef.current = false;
      setData(initialAuthor.data);
      setError(null);
    } else if (
      initialAuthor.status === "error" &&
      allowResourceAdoptionRef.current
    ) {
      setError(toFeedback(initialAuthor.error, { fallback: "Couldn't load this author." }));
      setData(null);
    }
  }, [initialAuthor]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = data;
  }, [data]);

  usePaneReturnReady(data !== null || error !== null);
  useSetPaneLabel(loading ? null : (data?.detail.displayName ?? "Author"));

  const workCount = data?.works.length ?? 0;
  const workRows = useMemo(
    () => data?.works.map(presentContributorWork) ?? [],
    [data?.works],
  );
  const openRoute = useCallback(
    (
      href: string,
      inNewPane: boolean,
      secondaryActivation?: WorkspaceSecondaryActivation,
    ) => {
      if (inNewPane) openInNewPane?.(href, undefined, secondaryActivation);
      else router.push(href);
    },
    [openInNewPane, router],
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
          onOpenRoute={openRoute}
        />
      ) : connectionsResource.kind === "Loading" ? (
        <FeedbackNotice severity="info" title="Loading connections…" />
      ) : (
        <FeedbackNotice severity="neutral" title="Connections unavailable">
          This author’s resource identity could not be resolved.
        </FeedbackNotice>
      ),
    [connectionsComposerController, connectionsResource, openRoute],
  );
  const { companionAction } = useResourceInspector({
    scheme: "contributor",
    handle: canonicalHandle,
    bodies: { linkedItems: connectionsBody },
  });
  // Render no folio when there are no works (content spec M3); a zero count
  // would render the banned "0 works".
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    header: {
      kind: "section",
      folio:
        workCount > 0
          ? { kind: "count", value: workCount, unit: "work" }
          : { kind: "none" },
      pending: loading,
    },
  });

  // After appending a Load-more page, move focus to the first newly-appended
  // work title for keyboard continuity (content spec §4.2).
  useEffect(() => {
    const index = pendingFocusIndexRef.current;
    if (index === null) return;
    const region = worksRegionRef.current;
    if (!region) return;

    const focusAppendedTitle = () => {
      const title = region
        .querySelectorAll<HTMLAnchorElement>("[data-row-focusable]")
        .item(index);
      if (!title) return false;
      pendingFocusIndexRef.current = null;
      title.focus();
      return true;
    };
    if (focusAppendedTitle()) return;

    const observer = new MutationObserver(() => {
      if (focusAppendedTitle()) observer.disconnect();
    });
    observer.observe(region, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [workCount]);

  const loadMore = useCallback(async () => {
    if (!handle || !data || data.worksNextCursor === null || loadingMore) return;
    const cursor = data.worksNextCursor;
    const canonicalHandle = data.detail.handle;
    const appendAt = data.works.length;
    setLoadingMore(true);
    setWorksError(null);
    try {
      const page = await fetchContributorWorks(handle, { cursor });
      setData((current) =>
        current && current.detail.handle === canonicalHandle
          ? {
              ...current,
              works: [...current.works, ...page.works],
              worksNextCursor: page.nextCursor,
            }
          : current,
      );
      if (page.works.length > 0) {
        pendingFocusIndexRef.current = appendAt;
        setAnnouncement(
          page.works.length === 1
            ? "1 more work loaded"
            : `${page.works.length} more works loaded`,
        );
      }
    } catch (loadMoreError) {
      if (handleUnauthenticatedApiError(loadMoreError)) return;
      setWorksError(
        toFeedback(loadMoreError, { fallback: "Couldn't load more works." }),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [handle, data, loadingMore]);

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

  return (
    <PaneSurface
      state={
        loading || (error && !data) ? (
          <>
            {loading ? <PaneLoadingState /> : null}
            {error && !data ? <FeedbackNotice feedback={error} /> : null}
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

          <section ref={worksRegionRef} aria-label="Works">
            <CollectionView
              returnScope="Author.Works"
              rows={workRows}
              status="ready"
              ariaLabel="Works"
              surface={false}
              empty={<p className={styles.empty}>No works yet.</p>}
              footer={
                data.worksNextCursor !== null ? (
                  worksError ? (
                    <div className={styles.worksError}>
                      <FeedbackNotice feedback={worksError} />
                      <Button variant="secondary" size="sm" onClick={() => void loadMore()}>
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <div className={styles.worksFooter}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void loadMore()}
                        disabled={loadingMore}
                        loading={loadingMore}
                      >
                        Load more
                      </Button>
                    </div>
                  )
                ) : null
              }
            />
          </section>

          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>

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
  const toast = useFeedback();
  const [value, setValue] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const intentRef = useRef(createMutationIntent());
  const emptyErrorId = useId();

  const trimmed = value.trim();
  const isBlank = trimmed.length === 0;
  const isUnchanged = trimmed === currentName.trim();
  const canSave = !isBlank && !isUnchanged && !saving;

  const emptyFeedback = useMemo<FeedbackContent | null>(
    () => (isBlank ? { severity: "error", title: "Enter a name." } : null),
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
      toast.show({ severity: "success", title: "Author name updated." });
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
        setNotice(toFeedback(renameError, { fallback: "Couldn't update the name." }));
      } else {
        // Transport/timeout: the server may have committed. Keep the same key so a
        // retry replays idempotently and resolves the ambiguity (DP-1).
        setNotice({
          severity: "error",
          title: "Couldn't confirm the change. Try again.",
        });
      }
    } finally {
      setSaving(false);
    }
  }

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
        <FieldFeedback feedback={emptyFeedback} id={emptyErrorId} />
        {notice ? <FeedbackNotice feedback={notice} /> : null}
        <div className={styles.renameActions}>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={!canSave} loading={saving}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
