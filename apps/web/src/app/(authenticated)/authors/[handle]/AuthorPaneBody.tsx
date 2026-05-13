"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, UserRound } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import { AppList, AppListItem } from "@/components/ui/AppList";
import Pill from "@/components/ui/Pill";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { fetchContributor, fetchContributorWorks } from "@/lib/contributors/api";
import type {
  ContributorAlias,
  ContributorExternalId,
  ContributorSummary,
  ContributorWork,
} from "@/lib/contributors/types";
import { formatContributorRole } from "@/lib/contributors/formatting";
import { usePaneParam, useSetPaneTitle } from "@/lib/panes/paneRuntime";
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

function formatWorkKind(work: ContributorWork): string {
  return formatContentKind(workContentKind(work));
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
  ).sort((a, b) => a.localeCompare(b));
}

function buildWorkMeta(work: ContributorWork): string {
  return [
    formatContributorRole(work.role),
    work.credited_name?.trim() ? `credited as ${work.credited_name.trim()}` : null,
    work.published_date,
    work.publisher,
    work.source,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  const [data, setData] = useState<ContributorPaneData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [roleFilter, setRoleFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [queryFilter, setQueryFilter] = useState("");
  const lastWorksRequestKeyRef = useRef<string | null>(null);
  const worksRequestIdRef = useRef(0);

  useSetPaneTitle(data?.contributor.display_name ?? "Author");

  useEffect(() => {
    setData(null);
    setRoleFilter("");
    setKindFilter("");
    setQueryFilter("");
    lastWorksRequestKeyRef.current = null;
    worksRequestIdRef.current += 1;

    if (!handle) {
      setLoading(false);
      setError({ severity: "error", title: "Author handle is missing" });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [contributorResponse, works] = await Promise.all([
          fetchContributor(handle),
          fetchContributorWorks(handle, { limit: AUTHOR_WORKS_LIMIT }),
        ]);
        if (cancelled) {
          return;
        }
        lastWorksRequestKeyRef.current = workRequestKey(handle, "", "", "");
        setData({
          contributor: contributorResponse,
          aliases: contributorResponse.aliases ?? [],
          externalIds: contributorResponse.external_ids ?? [],
          works,
          workFilterOptions: works,
        });
      } catch (loadError) {
        if (!cancelled) {
          setError(toFeedback(loadError, { fallback: "Failed to load author" }));
          setData(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handle]);

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

  return (
    <SectionCard>
      <div className={styles.content}>
        {loading ? <FeedbackNotice severity="info" title="Loading author..." /> : null}
        {error ? <FeedbackNotice feedback={error} /> : null}

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
                </div>
                {data.contributor.disambiguation ? (
                  <p className={styles.disambiguation}>
                    {data.contributor.disambiguation}
                  </p>
                ) : null}
              </div>
            </header>

            {data.aliases.length > 0 || data.externalIds.length > 0 ? (
              <div className={styles.identityDetails}>
                {data.aliases.length > 0 ? (
                  <section>
                    <h2>Aliases</h2>
                    <div className={styles.pillRow}>
                      {data.aliases.map((alias, index) => (
                        <span key={`${alias.alias}-${index}`} className={styles.detailPill}>
                          {alias.alias}
                        </span>
                      ))}
                    </div>
                  </section>
                ) : null}
                {data.externalIds.length > 0 ? (
                  <section>
                    <h2>Authority IDs</h2>
                    <div className={styles.pillRow}>
                      {data.externalIds.map((externalId, index) =>
                        externalId.external_url ? (
                          <a
                            key={`${externalId.authority}-${externalId.external_key}-${index}`}
                            href={externalId.external_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.detailPill}
                          >
                            {externalId.authority}
                            <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : (
                          <span
                            key={`${externalId.authority}-${externalId.external_key}-${index}`}
                            className={styles.detailPill}
                          >
                            {externalId.authority}
                          </span>
                        )
                      )}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            <section className={styles.worksSection}>
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
              </div>

              {visibleWorks.length === 0 ? (
                <FeedbackNotice severity="neutral">
                  No visible credited works match the current filters.
                </FeedbackNotice>
              ) : (
                <AppList>
                  {visibleWorks.map((work) => (
                    <AppListItem
                      key={`${work.route}-${work.object_id}`}
                      href={work.route}
                      title={work.title}
                      description={formatWorkKind(work)}
                      meta={buildWorkMeta(work)}
                    />
                  ))}
                </AppList>
              )}
            </section>
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
