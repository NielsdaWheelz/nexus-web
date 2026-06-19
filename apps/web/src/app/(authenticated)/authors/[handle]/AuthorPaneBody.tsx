"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, UserRound, X } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import PaneSurface from "@/components/ui/PaneSurface";
import CollectionView from "@/components/collections/CollectionView";
import CollectionDisplayControls from "@/components/collections/CollectionDisplayControls";
import Pill from "@/components/ui/Pill";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import ContributorPicker from "@/components/contributors/ContributorPicker";
import { contributorResource } from "@/lib/api/resource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  addContributorAlias,
  addContributorExternalId,
  deleteContributorAlias,
  deleteContributorExternalId,
  fetchContributor,
  fetchContributorWorks,
  mergeContributor,
  tombstoneContributor,
} from "@/lib/contributors/api";
import { useResource } from "@/lib/api/useResource";
import type {
  ContributorAlias,
  ContributorExternalId,
  ContributorSummary,
  ContributorWork,
} from "@/lib/contributors/types";
import { formatContributorRole } from "@/lib/contributors/formatting";
import { presentContributorWork } from "@/lib/collections/presenters/contributor";
import { useCollectionDisplayState } from "@/lib/collections/useCollectionDisplayState";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  usePaneParam,
  usePaneRouter,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { compareStableString } from "@/lib/display/format";
import styles from "./page.module.css";

interface ContributorPaneData {
  contributor: ContributorSummary;
  aliases: ContributorAlias[];
  externalIds: ContributorExternalId[];
  works: ContributorWork[];
  workFilterOptions: ContributorWork[];
}

const AUTHOR_WORKS_LIMIT = 100;

function workRequestKey(handle: string, role: string, kind: string, query: string): string {
  return `${handle}\n${role}\n${kind}\n${query}`;
}

function formatContentKind(kind: string): string {
  return (kind || "work").replace(/_/g, " ");
}

function workContentKind(work: ContributorWork): string {
  return (
    normalizeFilterValue(work.content_kind) ||
    normalizeFilterValue(work.object_type) ||
    "work"
  );
}

function normalizeFilterValue(value: string | null | undefined): string {
  return value?.trim() || "";
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeFilterValue(value)).filter(Boolean))
  ).sort(compareStableString);
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  const { displayState, setDisplayState } = useCollectionDisplayState(
    `/authors/${encodeURIComponent(handle ?? "")}`,
  );
  const initialAuthor = useResource<ContributorPaneData, { handle: string }>({
    descriptor: contributorResource,
    params: handle ? { handle } : null,
    load: async (params) => {
      const [contributorResponse, works] = await Promise.all([
        fetchContributor(params.handle),
        fetchContributorWorks(params.handle, { limit: AUTHOR_WORKS_LIMIT }),
      ]);
      return {
        contributor: contributorResponse,
        aliases: contributorResponse.aliases ?? [],
        externalIds: contributorResponse.external_ids ?? [],
        works,
        workFilterOptions: works,
      };
    },
  });
  const paneRouter = usePaneRouter();
  const [data, setData] = useState<ContributorPaneData | null>(null);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [roleFilter, setRoleFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [queryFilter, setQueryFilter] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const [authorityDraft, setAuthorityDraft] = useState("");
  const [externalKeyDraft, setExternalKeyDraft] = useState("");
  const lastWorksRequestKeyRef = useRef<string | null>(null);
  const worksRequestIdRef = useRef(0);
  const mergeCardRef = useRef<HTMLDivElement>(null);
  const loading =
    !!handle && !error && (data === null || data.contributor.handle !== handle);
  useDialogOverlay({
    ref: mergeCardRef,
    active: mergeOpen,
    onDismiss: () => setMergeOpen(false),
  });

  // After a curation mutation, the survivor handle may equal the loaded handle
  // (alias/external-id/tombstone) — reload its summary + works in place so the
  // pane reflects the change without losing the active filters.
  async function reload(): Promise<void> {
    if (!data) return;
    const targetHandle = data.contributor.handle;
    try {
      const [contributorResponse, works] = await Promise.all([
        fetchContributor(targetHandle),
        fetchContributorWorks(targetHandle, {
          role: roleFilter,
          contentKind: kindFilter,
          query: queryFilter,
          limit: AUTHOR_WORKS_LIMIT,
        }),
      ]);
      setData((current) =>
        current && current.contributor.handle === targetHandle
          ? {
              ...current,
              contributor: contributorResponse,
              aliases: contributorResponse.aliases ?? [],
              externalIds: contributorResponse.external_ids ?? [],
              works,
            }
          : current,
      );
    } catch (reloadError) {
      if (handleUnauthenticatedApiError(reloadError)) return;
      setError(toFeedback(reloadError, { fallback: "Failed to refresh author" }));
    }
  }

  async function runMutation(
    action: () => Promise<unknown>,
    fallback: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (mutationError) {
      if (handleUnauthenticatedApiError(mutationError)) return false;
      setError(toFeedback(mutationError, { fallback }));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleMergeSelect(target: ContributorSummary): Promise<void> {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const survivor = await mergeContributor(data.contributor.handle, target.handle);
      setMergeOpen(false);
      paneRouter.push(`/authors/${encodeURIComponent(survivor.handle)}`);
    } catch (mergeError) {
      if (handleUnauthenticatedApiError(mergeError)) return;
      setError(toFeedback(mergeError, { fallback: "Failed to merge author" }));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddAlias(): Promise<void> {
    if (!data) return;
    const alias = aliasDraft.trim();
    if (!alias) return;
    const ok = await runMutation(
      () => addContributorAlias(data.contributor.handle, { alias }),
      "Failed to add alias",
    );
    if (ok) setAliasDraft("");
  }

  async function handleAddExternalId(): Promise<void> {
    if (!data) return;
    const authority = authorityDraft.trim();
    const externalKey = externalKeyDraft.trim();
    if (!authority || !externalKey) return;
    const ok = await runMutation(
      () =>
        addContributorExternalId(data.contributor.handle, {
          authority,
          external_key: externalKey,
        }),
      "Failed to add authority ID",
    );
    if (ok) {
      setAuthorityDraft("");
      setExternalKeyDraft("");
    }
  }

  useSetPaneTitle(loading ? null : (data?.contributor.display_name ?? "Author"));

  // Reset the local copy + filters whenever the route handle changes, so stale
  // author data never bleeds across panes while the next initial load runs.
  useEffect(() => {
    setData(null);
    setRoleFilter("");
    setKindFilter("");
    setQueryFilter("");
    setMergeOpen(false);
    setAliasDraft("");
    setAuthorityDraft("");
    setExternalKeyDraft("");
    lastWorksRequestKeyRef.current = null;
    worksRequestIdRef.current += 1;
    setError(
      handle ? null : { severity: "error", title: "Author handle is missing" },
    );
  }, [handle]);

  // Seed the local copy from the initial resource's ready/error branch.
  useEffect(() => {
    if (initialAuthor.status === "ready") {
      lastWorksRequestKeyRef.current = workRequestKey(
        initialAuthor.data.contributor.handle,
        "",
        "",
        "",
      );
      setData(initialAuthor.data);
      setError(null);
    } else if (initialAuthor.status === "error") {
      setError(
        toFeedback(initialAuthor.error, { fallback: "Failed to load author" }),
      );
      setData(null);
    }
  }, [initialAuthor]);

  useEffect(() => {
    if (!handle || !data || data.contributor.handle !== handle) {
      return;
    }

    const requestKey = workRequestKey(handle, roleFilter, kindFilter, queryFilter);
    if (lastWorksRequestKeyRef.current === requestKey) {
      return;
    }

    let cancelled = false;
    const requestId = worksRequestIdRef.current + 1;
    worksRequestIdRef.current = requestId;
    setError(null);
    void (async () => {
      try {
        const works = await fetchContributorWorks(handle, {
          role: roleFilter,
          contentKind: kindFilter,
          query: queryFilter,
          limit: AUTHOR_WORKS_LIMIT,
        });
        if (cancelled || requestId !== worksRequestIdRef.current) {
          return;
        }
        lastWorksRequestKeyRef.current = requestKey;
        setData((current) =>
          current && current.contributor.handle === handle
            ? {
                ...current,
                works,
                workFilterOptions:
                  roleFilter || kindFilter || queryFilter
                    ? current.workFilterOptions
                    : works,
              }
            : current
        );
      } catch (loadError) {
        if (handleUnauthenticatedApiError(loadError)) return;
        if (!cancelled && requestId === worksRequestIdRef.current) {
          setError(toFeedback(loadError, { fallback: "Failed to load author works" }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data, handle, kindFilter, queryFilter, roleFilter]);

  const roleOptions = useMemo(
    () => uniqueSorted(data?.workFilterOptions.map((work) => work.role) ?? []),
    [data?.workFilterOptions]
  );
  const kindOptions = useMemo(
    () => uniqueSorted(data?.workFilterOptions.map(workContentKind) ?? []),
    [data?.workFilterOptions]
  );
  const visibleWorks = data?.works ?? [];
  const workConnectionSummaries = useConnectionSummaries(
    visibleWorks.map((work) => `${work.object_type}:${work.object_id}`),
  );
  // The backend follows merges, so a requested handle that no longer matches the
  // resolved survivor means the URL handle was merged away.
  const formerlyHandle =
    data && handle && handle !== data.contributor.handle ? handle : null;

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
        <>
          <header className={styles.header}>
            <div className={styles.avatar} aria-hidden="true">
              <UserRound size={24} />
            </div>
            <div className={styles.identity}>
              <h1 className={styles.name}>{data.contributor.display_name}</h1>
              <div className={styles.identityMeta}>
                {data.contributor.sort_name ? (
                  <span>{data.contributor.sort_name}</span>
                ) : null}
                {data.contributor.status ? (
                  <Pill tone="neutral">{data.contributor.status}</Pill>
                ) : null}
                {data.contributor.kind ? (
                  <span>{data.contributor.kind.replace(/_/g, " ")}</span>
                ) : null}
                {formerlyHandle ? (
                  <span className={styles.formerly}>Formerly {formerlyHandle}</span>
                ) : null}
              </div>
              {data.contributor.disambiguation ? (
                <p className={styles.disambiguation}>
                  {data.contributor.disambiguation}
                </p>
              ) : null}
              <div className={styles.headerActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMergeOpen(true)}
                  disabled={busy}
                >
                  Merge into…
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() =>
                    void runMutation(
                      () => tombstoneContributor(data.contributor.handle),
                      "Failed to tombstone author",
                    )
                  }
                  disabled={busy}
                >
                  Tombstone
                </Button>
              </div>
            </div>
          </header>

          {/* split UI deferred */}
          <div className={styles.identityDetails}>
            <section>
              <h2>Aliases</h2>
              <div className={styles.pillRow}>
                {data.aliases.map((alias, index) => (
                  <span
                    key={alias.id ?? `${alias.alias}-${index}`}
                    className={styles.removablePill}
                  >
                    {alias.alias}
                    {alias.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove alias ${alias.alias}`}
                        disabled={busy}
                        onClick={() =>
                          void runMutation(
                            () =>
                              deleteContributorAlias(
                                data.contributor.handle,
                                alias.id as string,
                              ),
                            "Failed to remove alias",
                          )
                        }
                      >
                        <X size={12} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </span>
                ))}
              </div>
              <div className={styles.inlineForm}>
                <Input
                  aria-label="New alias"
                  value={aliasDraft}
                  placeholder="Add alias…"
                  className={styles.inlineFormInput}
                  onChange={(event) => setAliasDraft(event.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !aliasDraft.trim()}
                  onClick={() => void handleAddAlias()}
                >
                  Add
                </Button>
              </div>
            </section>
            <section>
              <h2>Authority IDs</h2>
              <div className={styles.pillRow}>
                {data.externalIds.map((externalId, index) => (
                  <span
                    key={
                      externalId.id ??
                      `${externalId.authority}-${externalId.external_key}-${index}`
                    }
                    className={styles.removablePill}
                  >
                    {externalId.external_url ? (
                      <a
                        href={externalId.external_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.detailPill}
                      >
                        {externalId.authority}
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    ) : (
                      externalId.authority
                    )}
                    {externalId.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove authority ID ${externalId.authority}`}
                        disabled={busy}
                        onClick={() =>
                          void runMutation(
                            () =>
                              deleteContributorExternalId(
                                data.contributor.handle,
                                externalId.id as string,
                              ),
                            "Failed to remove authority ID",
                          )
                        }
                      >
                        <X size={12} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </span>
                ))}
              </div>
              <div className={styles.inlineForm}>
                <Input
                  aria-label="New authority"
                  value={authorityDraft}
                  placeholder="Authority…"
                  className={styles.inlineFormInput}
                  onChange={(event) => setAuthorityDraft(event.target.value)}
                />
                <Input
                  aria-label="New authority key"
                  value={externalKeyDraft}
                  placeholder="External key…"
                  className={styles.inlineFormInput}
                  onChange={(event) => setExternalKeyDraft(event.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !authorityDraft.trim() || !externalKeyDraft.trim()}
                  onClick={() => void handleAddExternalId()}
                >
                  Add
                </Button>
              </div>
            </section>
          </div>

          <section className={styles.worksSection}>
            <div className={styles.worksHeader}>
              <h2>Works</h2>
              <a
                href={`/search?authors=${encodeURIComponent(
                  data.contributor.handle,
                )}`}
                onClick={(event) => {
                  event.preventDefault();
                  paneRouter.push(
                    `/search?authors=${encodeURIComponent(
                      data.contributor.handle,
                    )}`,
                  );
                }}
              >
                Search this author&apos;s works
              </a>
            </div>
            <div className={styles.workToolbar}>
              <label>
                <span>Search works</span>
                <Input
                  type="search"
                  value={queryFilter}
                  onChange={(event) => setQueryFilter(event.target.value)}
                  placeholder="Filter credited works..."
                  className={styles.workSearchInput}
                />
              </label>
              <label>
                <span>Role</span>
                <Select
                  value={roleFilter}
                  onChange={(event) => setRoleFilter(event.target.value)}
                >
                  <option value="">All roles</option>
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>
                      {formatContributorRole(role)}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                <span>Kind</span>
                <Select
                  value={kindFilter}
                  onChange={(event) => setKindFilter(event.target.value)}
                >
                  <option value="">All kinds</option>
                  {kindOptions.map((kind) => (
                    <option key={kind} value={kind}>
                      {formatContentKind(kind)}
                    </option>
                  ))}
                </Select>
              </label>
              <CollectionDisplayControls
                value={displayState}
                onChange={setDisplayState}
              />
            </div>

            <CollectionView
              rows={visibleWorks.map((work) =>
                presentContributorWork(work, {
                  connectionSummary: workConnectionSummaries.get(
                    `${work.object_type}:${work.object_id}`,
                  ),
                }),
              )}
              view={displayState.view}
              density={displayState.density}
              status={error ? "error" : "ready"}
              ariaLabel="Works"
              error={error ? <FeedbackNotice feedback={error} /> : undefined}
              empty={
                <FeedbackNotice severity="neutral">
                  No visible credited works match the current filters.
                </FeedbackNotice>
              }
            />
          </section>

          {mergeOpen ? (
            <div
              className={styles.modalBackdrop}
              role="presentation"
              onClick={() => setMergeOpen(false)}
            >
              <div
                ref={mergeCardRef}
                className={styles.modalCard}
                role="dialog"
                aria-modal="true"
                aria-label="Merge author"
                onClick={(event) => event.stopPropagation()}
              >
                <h2 className={styles.modalTitle}>Merge into…</h2>
                <p className={styles.modalDescription}>
                  Pick the author to merge <strong>{data.contributor.display_name}</strong>{" "}
                  into. Credits, aliases, and authority IDs move to the survivor.
                </p>
                <ContributorPicker
                  excludeHandle={data.contributor.handle}
                  onSelect={(target) => void handleMergeSelect(target)}
                  busy={busy}
                />
                <div className={styles.modalActions}>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => setMergeOpen(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </PaneSurface>
  );
}
