"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Button from "@/components/ui/Button";
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
import type {
  ContributorDetail,
  ContributorRoleFact,
} from "@/lib/contributors/types";
import { paneResourceLoaders, type AuthorPaneSeed } from "@/lib/panes/paneResourceLoaders";
import { usePaneParam, useSetPaneLabel } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

// Singular role labels (content spec §0.2 / §4.3) — a work role-fact is one
// credit, so it renders the singular form. Anything outside the closed vocabulary
// (or a null role) reads as the generic "Contributor".
const ROLE_SINGULAR: Record<string, string> = {
  author: "Author",
  editor: "Editor",
  translator: "Translator",
  host: "Host",
  guest: "Guest",
  narrator: "Narrator",
  creator: "Creator",
  producer: "Producer",
  publisher: "Publisher",
  channel: "Channel",
  organization: "Organization",
  unknown: "Contributor",
};

function roleFactLabel(role: string): string {
  return ROLE_SINGULAR[role.trim()] ?? "Contributor";
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Render a partial ISO date at its known precision (content spec §4.3): YYYY,
// "Month YYYY", or "Month D, YYYY". A null/unparseable date renders nothing (no
// "Unknown date", no "n.d.").
function formatWorkDate(date: string | null): string | null {
  if (!date) return null;
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (full) {
    const month = MONTHS[Number(full[2]) - 1];
    if (!month) return null;
    return `${month} ${Number(full[3])}, ${Number(full[1])}`;
  }
  const yearMonth = /^(\d{4})-(\d{2})$/.exec(date);
  if (yearMonth) {
    const month = MONTHS[Number(yearMonth[2]) - 1];
    if (!month) return null;
    return `${month} ${Number(yearMonth[1])}`;
  }
  const year = /^(\d{4})$/.exec(date);
  if (year) return year[1];
  return null;
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  const initialAuthor = useResource<AuthorPaneSeed, { handle: string }>({
    descriptor: contributorResource,
    params: handle ? { handle } : null,
    load: (params, signal) =>
      paneResourceLoaders.author!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<AuthorPaneSeed>,
  });

  const [data, setData] = useState<AuthorPaneSeed | null>(null);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [worksError, setWorksError] = useState<FeedbackContent | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const worksListRef = useRef<HTMLOListElement>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);

  const loading =
    !!handle && !error && (data === null || data.detail.handle !== handle);

  // Reset the local copy whenever the route handle changes, so stale author data
  // never bleeds across panes while the next initial load runs.
  useEffect(() => {
    setData(null);
    setError(handle ? null : { severity: "error", title: "Author handle is missing" });
    setWorksError(null);
    setLoadingMore(false);
    setRenameOpen(false);
    setAnnouncement("");
    pendingFocusIndexRef.current = null;
  }, [handle]);

  // Seed the local copy from the initial resource's ready/error branch.
  useEffect(() => {
    if (initialAuthor.status === "ready") {
      setData(initialAuthor.data);
      setError(null);
    } else if (initialAuthor.status === "error") {
      setError(toFeedback(initialAuthor.error, { fallback: "Couldn't load this author." }));
      setData(null);
    }
  }, [initialAuthor]);

  useSetPaneLabel(loading ? null : (data?.detail.displayName ?? "Author"));

  const workCount = data?.works.length ?? 0;
  // Render no folio when there are no works (content spec M3); a zero count
  // would render the banned "0 works".
  usePanePrimaryChrome({
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
    pendingFocusIndexRef.current = null;
    worksListRef.current
      ?.querySelector<HTMLElement>(`[data-work-title="${index}"]`)
      ?.focus();
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

          <section className={styles.works} aria-label="Works">
            {data.works.length === 0 ? (
              <p className={styles.empty}>No works yet.</p>
            ) : (
              <ol className={styles.workList} ref={worksListRef}>
                {data.works.map((work, index) => {
                  const dateLabel = formatWorkDate(work.date);
                  return (
                    <li key={`${work.href}-${index}`} className={styles.workRow}>
                      <a
                        className={styles.workTitle}
                        href={work.href}
                        dir="auto"
                        data-work-title={index}
                      >
                        {work.title}
                      </a>
                      {dateLabel || work.contentKind ? (
                        <p className={styles.workMeta}>
                          {dateLabel ? <span>{dateLabel}</span> : null}
                          {work.contentKind ? (
                            <span className={styles.workKind}>
                              {work.contentKind.replace(/_/g, " ")}
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                      <ul className={styles.workFacts}>
                        {work.roleFacts.map((fact, factIndex) => (
                          <li
                            key={`${fact.role}-${fact.creditedName}-${factIndex}`}
                            className={styles.fact}
                          >
                            <RoleFact fact={fact} displayName={data.detail.displayName} />
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ol>
            )}

            {data.worksNextCursor !== null ? (
              worksError ? (
                <div className={styles.worksError}>
                  <FeedbackNotice feedback={worksError} />
                  <Button variant="secondary" size="sm" onClick={() => void loadMore()}>
                    Try again
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.loadMore}
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  loading={loadingMore}
                >
                  Load more
                </Button>
              )
            ) : null}
          </section>

          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>

          {renameOpen ? (
            <RenameAuthorDialog
              handle={data.detail.handle}
              currentName={data.detail.displayName}
              onClose={() => setRenameOpen(false)}
              onRenamed={(detail) =>
                setData((current) =>
                  current && current.detail.handle === detail.handle
                    ? { ...current, detail }
                    : current,
                )
              }
            />
          ) : null}
        </div>
      ) : null}
    </PaneSurface>
  );
}

function RoleFact({
  fact,
  displayName,
}: {
  fact: ContributorRoleFact;
  displayName: string;
}) {
  const label = roleFactLabel(fact.role);
  // When the credited spelling matches the canonical heading, the role stands
  // alone; otherwise it names the exact spelling used on this work (§4.3).
  if (fact.creditedName === displayName) {
    return <span>{label}</span>;
  }
  return (
    <span>
      {label} · credited as “<span dir="auto">{fact.creditedName}</span>”
    </span>
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
