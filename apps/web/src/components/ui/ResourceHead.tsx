"use client";

import type {
  PaneHeaderCredit,
  PaneHeaderCreditGroup,
  PaneResourceHeaderState,
} from "@/lib/panes/paneHeaderModel";
import styles from "./ResourceHead.module.css";

interface ResourceHeadProps {
  readonly creditsInert?: boolean;
  readonly id: string;
  readonly maxVisibleCredits: 1 | 2;
  readonly resource: PaneResourceHeaderState;
}

function Credits({
  groups,
  maxVisibleCredits,
}: {
  groups: readonly PaneHeaderCreditGroup[];
  maxVisibleCredits: 1 | 2;
}) {
  if (groups.length === 0) {
    return <span aria-hidden="true">&nbsp;</span>;
  }

  const visibleGroups: {
    group: PaneHeaderCreditGroup;
    credits: readonly PaneHeaderCredit[];
  }[] = [];
  let visibleCreditCount = 0;
  for (const group of groups) {
    if (visibleCreditCount === maxVisibleCredits) break;
    const credits = group.credits.slice(
      0,
      maxVisibleCredits - visibleCreditCount,
    );
    visibleGroups.push({ group, credits });
    visibleCreditCount += credits.length;
  }
  const hiddenCreditCount =
    groups.reduce((count, group) => count + group.credits.length, 0) -
    visibleCreditCount;

  return (
    <>
      {visibleGroups.map(({ group, credits }, groupIndex) => (
        <span
          key={
            group.kind === "authors"
              ? "authors"
              : `${group.label}-${groupIndex}`
          }
          className={styles.creditGroup}
        >
          {groupIndex > 0 ? (
            <span className={styles.separator}> · </span>
          ) : null}
          {group.kind === "authors" ? (
            <span className="sr-only">Authors: </span>
          ) : (
            <span className={styles.roleLabel}>{group.label}: </span>
          )}
          {credits.map((credit, creditIndex) => (
            <span
              key={`${credit.label}-${creditIndex}`}
              className={styles.creditItem}
            >
              {creditIndex > 0 ? (
                <span className={styles.separator}>, </span>
              ) : null}
              {credit.href ? (
                <a
                  className={styles.creditLink}
                  href={credit.href}
                  title={credit.label}
                  dir="auto"
                  data-pane-label-hint={credit.label}
                >
                  <span className={styles.creditLabel}>{credit.label}</span>
                </a>
              ) : (
                <span
                  className={styles.creditFact}
                  title={credit.label}
                  dir="auto"
                >
                  <span className={styles.creditLabel}>{credit.label}</span>
                </span>
              )}
            </span>
          ))}
        </span>
      ))}
      {hiddenCreditCount > 0 ? (
        <span className={styles.moreCredits}>
          <span aria-hidden="true">+{hiddenCreditCount}</span>
          <span className="sr-only">{hiddenCreditCount} more credits</span>
        </span>
      ) : null}
    </>
  );
}

export default function ResourceHead({
  creditsInert = false,
  id,
  maxVisibleCredits,
  resource,
}: ResourceHeadProps) {
  const pending = resource.status === "pending";
  const title = pending ? resource.accessibleLabel : resource.title;
  const creditGroups = resource.status === "ready" ? resource.creditGroups : [];

  return (
    <div
      className={styles.resourceHead}
      data-resource-head="true"
      data-status={resource.status}
    >
      <h1
        id={id}
        className={styles.title}
        dir="auto"
        aria-busy={pending || undefined}
        title={pending ? undefined : title}
      >
        {pending ? (
          <>
            <span className={styles.titleSkeleton} aria-hidden="true" />
            <span className="sr-only">{resource.accessibleLabel}</span>
          </>
        ) : (
          title
        )}
      </h1>
      <p
        className={styles.credits}
        data-resource-credits="true"
        aria-hidden={creditsInert || undefined}
        inert={creditsInert || undefined}
      >
        <Credits groups={creditGroups} maxVisibleCredits={maxVisibleCredits} />
      </p>
    </div>
  );
}
